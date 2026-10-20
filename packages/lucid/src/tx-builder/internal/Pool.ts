import * as Effect from "effect/Effect";
import type {
  PoolId,
  PoolParams,
  Redeemer,
  RewardAddress,
} from "@lucid-evolution/core-types";
import { fromHex, toHex } from "@lucid-evolution/core-utils";
import { getAddressDetails } from "@lucid-evolution/utils";
import { ledger, CborTag, type CborValue } from "@lucid-evolution/ledger";
import { recordCertificate, credentialCbor } from "../../sc-tools/intent.js";
import { TxBuilderError } from "../../Errors.js";
import {
  validateAndGetStakeCredential,
  validateAddressDetails,
} from "./TxUtils.js";
import { poolHash } from "./Governance.js";
import { TxConfig } from "./Service.js";
export const poolError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Pool: ${cause} }` });
export const delegateTo = (
  address: RewardAddress,
  pool: PoolId,
  redeemer?: Redeemer,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig,
      credential = yield* validateAndGetStakeCredential(address, config);
    yield* Effect.try({
      try: () =>
        recordCertificate(
          config,
          [2n, credentialCbor(credential), poolHash(pool)],
          credential,
          redeemer,
        ),
      catch: poolError,
    });
  });
export const retirePool = (pool: PoolId, epoch: bigint) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    yield* Effect.try({
      try: () => recordCertificate(config, [4n, poolHash(pool), epoch]),
      catch: poolError,
    });
  });
export const registerPool = (params: PoolParams) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    const owners: Uint8Array[] = [];
    for (const address of params.owners) {
      const credential = yield* validateAndGetStakeCredential(address, config);
      if (credential.type !== "Key")
        return yield* Effect.fail(
          poolError("Pool owners must be key credentials"),
        );
      owners.push(fromHex(credential.hash));
    }
    yield* validateAddressDetails(params.rewardAddress, config.lucidConfig);
    let metadata: CborValue = null;
    if (params.metadataUrl) {
      const bytes = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(params.metadataUrl!);
          if (!response.ok)
            throw new Error(`Pool metadata request failed: ${response.status}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        catch: poolError,
      });
      metadata = [
        params.metadataUrl,
        fromHex(
          ledger<string>("hash.blake2b", { hex: toHex(bytes), size: 32 }),
        ),
      ];
    }
    yield* Effect.try({
      try: () => {
        const relays: CborValue[] = params.relays.map((relay) => {
          if (relay.type !== "SingleHostIp" && !relay.domainName)
            throw new Error("Pool relay domainName is required");
          return relay.type === "SingleHostIp"
            ? [
                0n,
                relay.port === undefined ? null : BigInt(relay.port),
                relay.ipV4 ? new Uint8Array(ipv4Bytes(relay.ipV4)) : null,
                relay.ipV6 ? new Uint8Array(ipv6Bytes(relay.ipV6)) : null,
              ]
            : relay.type === "SingleHostDomainName"
              ? [
                  1n,
                  relay.port === undefined ? null : BigInt(relay.port),
                  relay.domainName!,
                ]
              : [2n, relay.domainName!];
        });
        recordCertificate(config, [
          3n,
          poolHash(params.poolId),
          fromHex(params.vrfKeyHash),
          params.pledge,
          params.cost,
          poolMargin(params.margin),
          fromHex(getAddressDetails(params.rewardAddress).address.hex),
          owners,
          relays,
          metadata,
        ]);
      },
      catch: poolError,
    });
  });
const poolMargin = (value: number): CborValue => {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Pool margin must be between 0 and 1");
  const [coefficient, exponent = "0"] = String(value).split("e"),
    [whole, fraction = ""] = coefficient.split(".");
  let numerator = BigInt(whole + fraction),
    denominator = 10n ** BigInt(fraction.length - Number(exponent)),
    a = numerator,
    b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return new CborTag(30n, [numerator / a, denominator / a]);
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
