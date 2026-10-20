import * as Effect from "effect/Effect";
import type {
  Assets,
  BuildTxWithRedeemer,
  OutRef,
  PolicyId,
  Redeemer,
  RedeemerBuilder,
  RedeemerContext,
  RedeemerPurpose,
  RedeemerTag,
  RewardAddress,
  TxOutput,
  UTxO,
} from "@lucid-evolution/core-types";
import {
  encodeCbor,
  type CborValue,
  type TransactionSnapshot,
  type TransactionBodySnapshot,
} from "@lucid-evolution/ledger";
import { toHex } from "@lucid-evolution/core-utils";
import { TxBuilderError } from "../../Errors.js";
import type { TxBuilderConfig } from "../TxBuilder.js";
export type BuildTxRedeemer = Redeemer | RedeemerBuilder | BuildTxWithRedeemer;
export type DelayedRedeemer = RedeemerBuilder | BuildTxWithRedeemer;
export type WitnessPurposeKey =
  | { readonly tag: "spend"; readonly input: OutRef }
  | { readonly tag: "mint"; readonly policyId: PolicyId }
  | { readonly tag: "withdraw"; readonly rewardAddress: RewardAddress }
  | { readonly tag: "publish"; readonly index: bigint }
  | { readonly tag: "propose"; readonly index: bigint }
  | { readonly tag: "propose"; readonly proposalKey: string }
  | { readonly tag: "vote"; readonly index: bigint }
  | { readonly tag: "vote"; readonly voterKey: string };
export type PendingRedeemer = Readonly<{
  id: number;
  actionId: number;
  source: DelayedRedeemer;
  purposeKey: WitnessPurposeKey;
}>;
export type CanonicalRedeemerInfo = Omit<RedeemerContext, "ownPurpose"> & {
  purposeByKey: ReadonlyMap<string, RedeemerPurpose>;
};
export type RedeemerBuilderCache = Map<number, Map<string, Redeemer>>;
export const redeemerContextError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ RedeemerContext: ${cause} }` });
export const isRedeemerBuilder = (
  redeemer: BuildTxRedeemer | undefined,
): redeemer is RedeemerBuilder =>
  typeof redeemer === "object" &&
  redeemer !== null &&
  "kind" in redeemer &&
  (redeemer.kind === "selected" || redeemer.kind === "self");

export const isBuildTxWithRedeemer = (
  redeemer: BuildTxRedeemer | undefined,
): redeemer is BuildTxWithRedeemer => typeof redeemer === "function";

export const isDelayedRedeemer = (
  redeemer: BuildTxRedeemer | undefined,
): redeemer is DelayedRedeemer =>
  isRedeemerBuilder(redeemer) || isBuildTxWithRedeemer(redeemer);

export const cloneAssets = (assets: Assets): Assets => ({ ...assets });

export const cloneUTxO = (utxo: UTxO): UTxO => ({
  ...utxo,
  assets: cloneAssets(utxo.assets),
  scriptRef: utxo.scriptRef ? { ...utxo.scriptRef } : utxo.scriptRef,
});

export const cloneUTxOs = (utxos: UTxO[]): UTxO[] => utxos.map(cloneUTxO);

export const cloneRedeemerBuilder = (
  redeemerBuilder: RedeemerBuilder,
  selfInputs?: UTxO[],
): RedeemerBuilder =>
  redeemerBuilder.kind === "selected"
    ? {
        kind: "selected",
        makeRedeemer: redeemerBuilder.makeRedeemer,
        inputs: cloneUTxOs(redeemerBuilder.inputs),
      }
    : {
        kind: "self",
        makeRedeemer: redeemerBuilder.makeRedeemer,
        inputs: selfInputs
          ? cloneUTxOs(selfInputs)
          : redeemerBuilder.inputs
            ? cloneUTxOs(redeemerBuilder.inputs)
            : undefined,
      };

export const cloneRedeemerInput = (
  redeemer: BuildTxRedeemer | undefined,
  selfInputs?: UTxO[],
): BuildTxRedeemer | undefined =>
  isRedeemerBuilder(redeemer)
    ? cloneRedeemerBuilder(redeemer, selfInputs)
    : redeemer;

export const outRefKey = (outRef: OutRef): string =>
  `${outRef.txHash}#${outRef.outputIndex}`;

export const witnessPurposeKey = (purposeKey: WitnessPurposeKey): string => {
  switch (purposeKey.tag) {
    case "spend":
      return `spend:${outRefKey(purposeKey.input)}`;
    case "mint":
      return `mint:${purposeKey.policyId}`;
    case "withdraw":
      return `withdraw:${purposeKey.rewardAddress}`;
    case "publish":
      return `${purposeKey.tag}:${purposeKey.index}`;
    case "propose":
      return "proposalKey" in purposeKey
        ? `propose:proposal:${purposeKey.proposalKey}`
        : `propose:${purposeKey.index}`;
    case "vote":
      return "voterKey" in purposeKey
        ? `vote:voter:${purposeKey.voterKey}`
        : `vote:${purposeKey.index}`;
  }
};

export const purposeToWitnessKey = (
  purpose: RedeemerPurpose,
): WitnessPurposeKey => {
  switch (purpose.tag) {
    case "spend":
      return { tag: "spend", input: purpose.input };
    case "mint":
      return { tag: "mint", policyId: purpose.policyId };
    case "withdraw":
      return { tag: "withdraw", rewardAddress: purpose.rewardAddress };
    case "publish":
      return { tag: purpose.tag, index: purpose.index };
    case "propose":
      return purpose.proposalKey
        ? { tag: "propose", proposalKey: purpose.proposalKey }
        : { tag: "propose", index: purpose.index };
    case "vote":
      return purpose.voterKey
        ? { tag: "vote", voterKey: purpose.voterKey }
        : { tag: "vote", index: purpose.index };
  }
};

export const registerPendingRedeemer = (
  config: TxBuilderConfig,
  pending: PendingRedeemer,
) =>
  Effect.gen(function* () {
    const key = witnessPurposeKey(pending.purposeKey);
    if (config.witnessRegistry.has(key)) {
      yield* redeemerContextError(`Duplicate script witness purpose: ${key}`);
    }
    config.witnessRegistry.add(key);
    config.pendingRedeemers.push(pending);
  });

const resolveInputs = (
  refs: readonly OutRef[],
  candidates: readonly UTxO[],
): UTxO[] => {
  const resolved = new Map<string, UTxO>();
  const score = (u: UTxO) =>
    (u.datum ? 4 : 0) + (u.scriptRef ? 2 : 0) + (u.datumHash ? 1 : 0);
  for (const candidate of candidates) {
    const key = outRefKey(candidate),
      prior = resolved.get(key);
    if (!prior || score(candidate) > score(prior)) resolved.set(key, candidate);
  }
  return refs.map((ref) => {
    const utxo = resolved.get(outRefKey(ref));
    if (!utxo)
      throw new Error(`Unresolved transaction input: ${outRefKey(ref)}`);
    return cloneUTxO(utxo);
  });
};
export const resolveCanonicalInputs = (
  tx: TransactionSnapshot,
  candidates: readonly UTxO[],
) =>
  Effect.try({
    try: () => resolveInputs(tx.body.inputs, candidates),
    catch: redeemerContextError,
  });
export const resolveCanonicalReferenceInputs = (
  tx: TransactionSnapshot,
  candidates: readonly UTxO[],
) =>
  Effect.try({
    try: () => resolveInputs(tx.body.referenceInputs, candidates),
    catch: redeemerContextError,
  });
export const orderedVoters = (tx: TransactionSnapshot): CborValue[] => {
  const voters = tx.body.votes instanceof Map ? [...tx.body.votes.keys()] : [];
  const priority = [1, 0, 3, 2, 4];
  return voters.sort((a, b) => {
    const x = a as CborValue[],
      y = b as CborValue[];
    return (
      priority[Number(x[0])] - priority[Number(y[0])] ||
      toHex(x[1] as Uint8Array).localeCompare(toHex(y[1] as Uint8Array))
    );
  });
};
export const buildCanonicalRedeemerInfo = (
  tx: TransactionSnapshot,
  resolved: readonly UTxO[],
): Effect.Effect<CanonicalRedeemerInfo, TxBuilderError> =>
  Effect.try({
    try: () => {
      const inputs = resolveInputs(tx.body.inputs, resolved),
        referenceInputs = resolveInputs(tx.body.referenceInputs, resolved),
        outputs = tx.body.outputs;
      const mint = tx.body.mint,
        withdrawals = tx.body.withdrawals;
      const policies = [
        ...new Set(Object.keys(mint).map((unit) => unit.slice(0, 56))),
      ].sort();
      const voters = orderedVoters(tx),
        proposals = tx.body.proposals;
      const purposes: RedeemerPurpose[] = tx.redeemers.map((r, listIndex) => {
        const base = {
          tag: r.tag,
          index: r.index,
          redeemerListIndex: BigInt(listIndex),
        };
        switch (r.tag) {
          case "spend": {
            const input = inputs[Number(r.index)];
            if (!input) throw new Error("Invalid spending redeemer index");
            return {
              ...base,
              tag: "spend",
              input: { txHash: input.txHash, outputIndex: input.outputIndex },
            };
          }
          case "mint":
            return {
              ...base,
              tag: "mint",
              policyId: policies[Number(r.index)],
            };
          case "withdraw":
            return {
              ...base,
              tag: "withdraw",
              rewardAddress: withdrawals[Number(r.index)]?.rewardAddress,
            };
          case "publish":
            return { ...base, tag: "publish" };
          case "vote":
            return {
              ...base,
              tag: "vote",
              voterKey: encodeCbor(voters[Number(r.index)], true),
            };
          case "propose":
            return {
              ...base,
              tag: "propose",
              proposalKey: encodeCbor(proposals[Number(r.index)], true),
            };
        }
      });
      const purposeByKey = new Map<string, RedeemerPurpose>(),
        indices = new Map<string, bigint>();
      for (const purpose of purposes) {
        const key = witnessPurposeKey(purposeToWitnessKey(purpose));
        if (purposeByKey.has(key))
          throw new Error(
            `Duplicate final redeemer purpose: ${purpose.tag}:${purpose.index}`,
          );
        purposeByKey.set(key, purpose);
        indices.set(key, purpose.redeemerListIndex!);
        purposeByKey.set(`${purpose.tag}:${purpose.index}`, purpose);
      }
      return {
        txBody: tx.body,
        inputs,
        referenceInputs,
        outputs,
        mint,
        withdrawals,
        redeemers: purposes,
        purposeByKey,
        inputIndex: (ref: OutRef) => {
          const i = inputs.findIndex((u) => outRefKey(u) === outRefKey(ref));
          return i < 0 ? undefined : BigInt(i);
        },
        outputIndex: (predicate: (output: TxOutput) => boolean) => {
          const i = outputs.findIndex(predicate);
          return i < 0 ? undefined : BigInt(i);
        },
        withdrawalIndex: (address: string) => {
          const i = withdrawals.findIndex((w) => w.rewardAddress === address);
          return i < 0 ? undefined : BigInt(i);
        },
        mintPolicyIndex: (policy: string) => {
          const i = policies.indexOf(policy);
          return i < 0 ? undefined : BigInt(i);
        },
        redeemerIndex: (purpose: RedeemerPurpose) =>
          indices.get(witnessPurposeKey(purposeToWitnessKey(purpose))),
      };
    },
    catch: redeemerContextError,
  });
export const contextForPurpose = (
  info: CanonicalRedeemerInfo,
  ownPurpose: RedeemerPurpose,
): RedeemerContext => ({
  txBody: info.txBody,
  inputs: info.inputs,
  referenceInputs: info.referenceInputs,
  outputs: info.outputs,
  mint: info.mint,
  withdrawals: info.withdrawals,
  redeemers: info.redeemers,
  ownPurpose,
  inputIndex: info.inputIndex,
  outputIndex: info.outputIndex,
  withdrawalIndex: info.withdrawalIndex,
  mintPolicyIndex: info.mintPolicyIndex,
  redeemerIndex: info.redeemerIndex,
});

const pendingGroups = (
  pendingRedeemers: ReadonlyArray<PendingRedeemer>,
): Map<number, PendingRedeemer[]> => {
  const groups = new Map<number, PendingRedeemer[]>();
  for (const pending of pendingRedeemers) {
    const group = groups.get(pending.id);
    if (group) group.push(pending);
    else groups.set(pending.id, [pending]);
  }
  return groups;
};

const memoizedRedeemerBuilderResult = (
  cache: RedeemerBuilderCache | undefined,
  pendingId: number,
  signature: string,
  makeRedeemer: () => Redeemer,
): Redeemer => {
  if (!cache) return makeRedeemer();
  let pendingCache = cache.get(pendingId);
  if (!pendingCache) {
    pendingCache = new Map();
    cache.set(pendingId, pendingCache);
  }

  const cached = pendingCache.get(signature);
  if (cached !== undefined) return cached;

  const redeemer = makeRedeemer();
  pendingCache.set(signature, redeemer);
  return redeemer;
};

const selectedSignature = (indices: readonly bigint[]): string =>
  `selected:${indices.map((index) => index.toString()).join(",")}`;

const selfSignature = (index: bigint): string => `self:${index.toString()}`;

export const buildRedeemersFromCanonicalContext = (
  info: CanonicalRedeemerInfo,
  pendingRedeemers: ReadonlyArray<PendingRedeemer>,
  redeemerBuilderCache?: RedeemerBuilderCache,
): Effect.Effect<Map<number, Redeemer>, TxBuilderError> =>
  Effect.gen(function* () {
    const nextRedeemers = new Map<number, Redeemer>();
    for (const [pendingId, group] of pendingGroups(pendingRedeemers)) {
      const source = group[0].source;
      if (isRedeemerBuilder(source)) {
        if (source.kind === "selected") {
          const inputIndices = source.inputs.map((input) =>
            info.inputIndex(input),
          );
          if (inputIndices.some((index) => index === undefined)) {
            yield* redeemerContextError(
              `RedeemerBuilder selected inputs are missing from canonical transaction inputs`,
            );
          }
          const indices = inputIndices as bigint[];
          nextRedeemers.set(
            pendingId,
            memoizedRedeemerBuilderResult(
              redeemerBuilderCache,
              pendingId,
              selectedSignature(indices),
              () => source.makeRedeemer(indices),
            ),
          );
        } else {
          const purposeKey = group[0].purposeKey;
          if (group.length !== 1 || purposeKey.tag !== "spend") {
            yield* redeemerContextError(
              "RedeemerBuilder self is only valid for spend witnesses",
            );
            continue;
          }
          const index = info.inputIndex(purposeKey.input);
          if (index === undefined) {
            yield* redeemerContextError(
              `RedeemerBuilder self input ${outRefKey(purposeKey.input)} is missing from canonical transaction inputs`,
            );
            continue;
          }
          nextRedeemers.set(
            pendingId,
            memoizedRedeemerBuilderResult(
              redeemerBuilderCache,
              pendingId,
              selfSignature(index),
              () => source.makeRedeemer(index),
            ),
          );
        }
      } else {
        if (group.length !== 1) {
          yield* redeemerContextError(
            "BuildTxWithRedeemer expects exactly one canonical script purpose",
          );
        }
        const key = witnessPurposeKey(group[0].purposeKey);
        const ownPurpose = info.purposeByKey.get(key);
        if (!ownPurpose) {
          yield* redeemerContextError(
            `Could not find canonical redeemer purpose for ${key}`,
          );
          continue;
        }
        nextRedeemers.set(
          pendingId,
          source(contextForPurpose(info, ownPurpose)),
        );
      }
    }
    return nextRedeemers;
  });

export const redeemerMapsEqual = (
  a: ReadonlyMap<number, Redeemer>,
  b: ReadonlyMap<number, Redeemer>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    if (b.get(key) !== value) return false;
  }
  return true;
};

export const transactionFixedPointFingerprint = (
  tx: TransactionSnapshot,
): string =>
  tx.bodyCbor +
  "|" +
  tx.redeemers
    .map(
      (r) =>
        `${r.tag}:${r.index}:${r.data}:${r.exUnits.mem}:${r.exUnits.steps}`,
    )
    .join(",");
export const normalizeEvalUTxO = ({
  datumHash,
  datum,
  ...rest
}: UTxO): UTxO => ({
  ...rest,
  datumHash,
  datum: datumHash ? undefined : datum,
});
