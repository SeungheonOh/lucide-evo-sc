import * as Effect from "effect/Effect";
import type {
  Anchor,
  DRep,
  PoolId,
  Redeemer,
  RewardAddress,
  Credential,
  AlwaysAbstain,
  AlwaysNoConfidence,
} from "@lucid-evolution/core-types";
import { poolIdToHex } from "@lucid-evolution/utils";
import { fromHex } from "@lucid-evolution/core-utils";
import type { CborValue } from "@lucid-evolution/ledger";
import { recordCertificate, credentialCbor } from "../../sc-tools/intent.js";
import { TxBuilderError } from "../../Errors.js";
import { validateAndGetStakeCredential } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
import type { TxBuilderConfig } from "../TxBuilder.js";
export const isDRepCredential = (d: DRep): d is Credential =>
  !("__typename" in d);
export const isDRepAlwaysAbstain = (d: DRep): d is AlwaysAbstain =>
  !isDRepCredential(d) && d.__typename === "AlwaysAbstain";
export const isDRepAlwaysNoConfidence = (d: DRep): d is AlwaysNoConfidence =>
  !isDRepCredential(d) && d.__typename === "AlwaysNoConfidence";
export const drepCbor = (d: DRep): CborValue =>
  isDRepCredential(d) ? credentialCbor(d) : [isDRepAlwaysAbstain(d) ? 2n : 3n];
export const poolHash = (pool: PoolId): Uint8Array =>
  fromHex(/^[0-9a-f]{56}$/i.test(pool) ? pool : poolIdToHex(pool));
export const anchorCbor = (anchor?: Anchor): CborValue =>
  anchor ? [anchor.url, fromHex(anchor.dataHash)] : null;
export const governanceError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Governance: ${cause} }` });
const certificate = (
  address: RewardAddress,
  make: (credential: CborValue, config: TxBuilderConfig) => CborValue,
  redeemer?: Redeemer,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig,
      credential = yield* validateAndGetStakeCredential(address, config);
    yield* Effect.try({
      try: () =>
        recordCertificate(
          config,
          make(credentialCbor(credential), config),
          credential,
          redeemer,
        ),
      catch: governanceError,
    });
  });
export const delegateVoteToDRep = (a: RewardAddress, d: DRep, r?: Redeemer) =>
  certificate(a, (c) => [9n, c, drepCbor(d)], r);
export const delegateVoteToPoolAndDRep = (
  a: RewardAddress,
  p: PoolId,
  d: DRep,
  r?: Redeemer,
) => certificate(a, (c) => [10n, c, poolHash(p), drepCbor(d)], r);
export const registerAndDelegateToPool = (
  a: RewardAddress,
  p: PoolId,
  r?: Redeemer,
) =>
  certificate(
    a,
    (c, x) => [
      11n,
      c,
      poolHash(p),
      x.lucidConfig.protocolParameters.keyDeposit,
    ],
    r,
  );
export const registerAndDelegateToDRep = (
  a: RewardAddress,
  d: DRep,
  r?: Redeemer,
) =>
  certificate(
    a,
    (c, x) => [
      12n,
      c,
      drepCbor(d),
      x.lucidConfig.protocolParameters.keyDeposit,
    ],
    r,
  );
export const registerAndDelegateToPoolAndDRep = (
  a: RewardAddress,
  p: PoolId,
  d: DRep,
  r?: Redeemer,
) =>
  certificate(
    a,
    (c, x) => [
      13n,
      c,
      poolHash(p),
      drepCbor(d),
      x.lucidConfig.protocolParameters.keyDeposit,
    ],
    r,
  );
export const registerDRep = (a: RewardAddress, anchor?: Anchor, r?: Redeemer) =>
  certificate(
    a,
    (c, x) => [
      16n,
      c,
      x.lucidConfig.protocolParameters.drepDeposit,
      anchorCbor(anchor),
    ],
    r,
  );
export const deregisterDRep = (a: RewardAddress, r?: Redeemer) =>
  certificate(
    a,
    (c, x) => [17n, c, x.lucidConfig.protocolParameters.drepDeposit],
    r,
  );
export const updateDRep = (a: RewardAddress, anchor?: Anchor, r?: Redeemer) =>
  certificate(a, (c) => [18n, c, anchorCbor(anchor)], r);
export const resignCommitteeHot = (
  a: RewardAddress,
  anchor?: Anchor,
  r?: Redeemer,
) => certificate(a, (c) => [15n, c, anchorCbor(anchor)], r);
export const authCommitteeHot = (
  cold: RewardAddress,
  hot: RewardAddress,
  r?: Redeemer,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig,
      coldCredential = yield* validateAndGetStakeCredential(cold, config),
      hotCredential = yield* validateAndGetStakeCredential(hot, config);
    yield* Effect.try({
      try: () =>
        recordCertificate(
          config,
          [14n, credentialCbor(coldCredential), credentialCbor(hotCredential)],
          coldCredential,
          r,
        ),
      catch: governanceError,
    });
  });
