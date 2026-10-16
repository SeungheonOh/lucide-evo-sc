import { scCertificateBuilder } from "../../sc-tools/intent.js";
import {
  PoolId,
  PoolParams,
  Redeemer,
  RewardAddress,
} from "@lucid-evolution/core-types";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import * as TxBuilder from "../TxBuilder.js";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import {
  toCMLAddress,
  toPartial,
  toV1,
  toV2,
  toV3,
  validateAddressDetails,
} from "./TxUtils.js";
import * as CML from "@lucid-evolution/cml";
import { LucidConfig } from "../../lucid-evolution/LucidEvolution.js";
import { blake2b } from "@noble/hashes/blake2b";
import { TxConfig } from "./Service.js";

export const poolError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Pool : ${cause} }` });

export const delegateTo = (
  rewardAddress: RewardAddress,
  poolId: PoolId,
  redeemer?: Redeemer,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const addressDetails = yield* pipe(
      validateAddressDetails(rewardAddress, config.lucidConfig),
      Effect.andThen((address) =>
        address.type !== "Reward"
          ? poolError(ERROR_MESSAGE.MISSING_REWARD_TYPE)
          : Effect.succeed(address),
      ),
    );

    const stakeCredential = yield* pipe(
      Effect.fromNullable(addressDetails.stakeCredential),
      Effect.orElseFail(() =>
        poolError(ERROR_MESSAGE.MISSING_STAKE_CREDENTIAL),
      ),
    );

    switch (stakeCredential.type) {
      case "Key": {
        const credential = CML.Credential.new_pub_key(
          CML.Ed25519KeyHash.from_hex(stakeCredential.hash),
        );
        const certBuilder = scCertificateBuilder(
          config,
          redeemer,
          CML.Certificate.new_stake_delegation(
            credential,
            CML.Ed25519KeyHash.from_bech32(poolId),
          ),
        );
        config.txBuilder.add_cert(certBuilder.payment_key());
        break;
      }

      case "Script": {
        const credential = CML.Credential.new_script(
          CML.ScriptHash.from_hex(stakeCredential.hash),
        );
        const certBuilder = scCertificateBuilder(
          config,
          redeemer,
          CML.Certificate.new_stake_delegation(
            credential,
            CML.Ed25519KeyHash.from_bech32(poolId),
          ),
        );
        const script = yield* pipe(
          Effect.fromNullable(config.scripts.get(stakeCredential.hash)),
          Effect.orElseFail(() =>
            poolError(ERROR_MESSAGE.MISSING_SCRIPT(stakeCredential.hash)),
          ),
        );
        const handleRedeemer = () =>
          pipe(
            Effect.fromNullable(redeemer),
            Effect.orElseFail(() => poolError(ERROR_MESSAGE.MISSING_REDEEMER)),
          );
        switch (script.type) {
          case "PlutusV1": {
            const red = yield* handleRedeemer();
            config.txBuilder.add_cert(
              certBuilder.plutus_script(
                toPartial(toV1(script.script), red),
                CML.Ed25519KeyHashList.new(),
              ),
            );
            break;
          }

          case "PlutusV2": {
            const red = yield* handleRedeemer();
            config.txBuilder.add_cert(
              certBuilder.plutus_script(
                toPartial(toV2(script.script), red),
                CML.Ed25519KeyHashList.new(),
              ),
            );
            break;
          }

          case "PlutusV3": {
            const red = yield* handleRedeemer();
            config.txBuilder.add_cert(
              certBuilder.plutus_script(
                toPartial(toV3(script.script), red),
                CML.Ed25519KeyHashList.new(),
              ),
            );
            break;
          }
          case "Native": {
            config.txBuilder.add_cert(
              certBuilder.native_script(
                CML.NativeScript.from_cbor_hex(script.script),
                CML.NativeScriptWitnessInfo.assume_signature_count(),
              ),
            );
            break;
          }
        }
      }
    }
  });

/** Register a stake pool. A pool deposit is required. The metadataUrl needs to be hosted already before making the registration. */
export const registerPool = (poolParams: PoolParams) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const poolRegistration = yield* createPoolRegistration(
      poolParams,
      config.lucidConfig,
    );
    const certBuilder = scCertificateBuilder(
      config,
      undefined,
      CML.Certificate.new_pool_registration(poolRegistration.pool_params()),
    );

    config.txBuilder.add_cert(certBuilder.skip_witness());
  });

export const retirePool = (poolId: PoolId, epoch: bigint) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const certBuilder = scCertificateBuilder(
      config,
      undefined,
      CML.Certificate.new_pool_retirement(
        CML.Ed25519KeyHash.from_bech32(poolId),
        epoch,
      ),
    );

    config.txBuilder.add_cert(certBuilder.skip_witness());
  });

const createPoolRegistration = (poolParams: PoolParams, lucid: LucidConfig) =>
  Effect.gen(function* () {
    const poolOwners = CML.Ed25519KeyHashList.new();
    for (const owner of poolParams.owners) {
      const addressDetails = yield* validateAddressDetails(owner, lucid);
      const stakeCredential = yield* pipe(
        Effect.fromNullable(addressDetails.stakeCredential),
        Effect.orElseFail(() =>
          poolError(ERROR_MESSAGE.MISSING_STAKE_CREDENTIAL),
        ),
      );
      stakeCredential.type === "Key"
        ? poolOwners.add(CML.Ed25519KeyHash.from_hex(stakeCredential.hash))
        : poolError(ERROR_MESSAGE.SCRIPT_CREDENTIAL_NOT_ALLOWED);
    }
    const metadataHash = yield* getMetadataHash(poolParams.metadataUrl);
    const relays = CML.RelayList.new();
    for (const relay of poolParams.relays) {
      switch (relay.type) {
        case "SingleHostIp": {
          const ipV4 = relay.ipV4
            ? CML.Ipv4.from_cbor_bytes(
                Uint8Array.of(0x44, ...ipv4Bytes(relay.ipV4)),
              )
            : undefined;
          const ipV6 = relay.ipV6
            ? CML.Ipv6.from_cbor_bytes(
                Uint8Array.of(0x50, ...ipv6Bytes(relay.ipV6)),
              )
            : undefined;
          relays.add(CML.Relay.new_single_host_addr(relay.port, ipV4, ipV6));
          break;
        }
        case "SingleHostDomainName": {
          relays.add(
            CML.Relay.new_single_host_name(
              relay.port,
              CML.DNSName.from_json(JSON.stringify(relay.domainName)),
            ),
          );
          break;
        }
        case "MultiHost": {
          relays.add(
            CML.Relay.new_multi_host_name(
              CML.DNSName.from_json(JSON.stringify(relay.domainName)),
            ),
          );
          break;
        }
      }
    }
    return CML.PoolRegistration.new(
      CML.PoolParams.new(
        CML.Ed25519KeyHash.from_bech32(poolParams.poolId),
        CML.VRFKeyHash.from_hex(poolParams.vrfKeyHash),
        poolParams.pledge,
        poolParams.cost,
        poolMargin(poolParams.margin),
        CML.RewardAddress.from_address(
          yield* toCMLAddress(poolParams.rewardAddress, lucid),
        )!,
        poolOwners,
        relays,
        metadataHash
          ? CML.PoolMetadata.new(
              CML.Url.from_json(JSON.stringify(poolParams.metadataUrl)),
              metadataHash,
            )
          : undefined,
      ),
    );
  });

const getMetadataHash = (metadataUrl?: string) =>
  Effect.gen(function* () {
    if (metadataUrl) {
      const metadata = yield* pipe(
        Effect.tryPromise({
          try: () => fetch(metadataUrl),
          catch: (cause) => poolError(cause),
        }),
        Effect.andThen((resp) =>
          resp.ok
            ? Effect.tryPromise({
                try: () => resp.arrayBuffer(),
                catch: poolError,
              })
            : Effect.fail(
                poolError(`Pool metadata request failed: ${resp.status}`),
              ),
        ),
      );
      const metadataHash = CML.PoolMetadataHash.from_raw_bytes(
        blake2b(new Uint8Array(metadata), { dkLen: 32 }),
      );
      return metadataHash;
    } else {
      return null;
    }
  });

// Convert the public decimal margin to an exact ledger fraction, including 0.
const poolMargin = (margin: number): CML.UnitInterval => {
  if (!Number.isFinite(margin) || margin < 0 || margin > 1) {
    throw new Error("Pool margin must be between 0 and 1");
  }
  const [coefficient, exponent = "0"] = String(margin).split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  let numerator = BigInt(whole + fraction);
  let denominator = 10n ** BigInt(fraction.length - Number(exponent));
  let a = numerator,
    b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  numerator /= a;
  denominator /= a;
  return CML.UnitInterval.new(numerator, denominator);
};

const ipv4Bytes = (address: string): number[] => {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    throw new Error(`Invalid IPv4 pool relay: ${address}`);
  return parts.map(Number);
};

const ipv6Bytes = (address: string): number[] => {
  // URL validates and canonicalizes IPv6, including compressed and IPv4-mapped forms.
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = host.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8)
    throw new Error(`Invalid IPv6 pool relay: ${address}`);
  return groups.flatMap((part) => {
    const value = parseInt(part, 16);
    return [value >> 8, value & 255];
  });
};
