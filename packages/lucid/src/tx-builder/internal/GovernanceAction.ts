import * as Effect from "effect/Effect";
import type {
  Anchor,
  GovernanceAction,
  GovernanceActionId,
  GovernanceProposal,
  GovernanceVote,
  GovernanceVoter,
  Redeemer,
} from "@lucid-evolution/core-types";
import {
  encodeCbor,
  decodeCbor,
  CborTag,
  type CborValue,
} from "@lucid-evolution/ledger";
import { fromHex, toHex } from "@lucid-evolution/core-utils";
import { getAddressDetails } from "@lucid-evolution/utils";
import {
  credentialCbor,
  recordScBlock,
  scWitness,
} from "../../sc-tools/intent.js";
import { TxBuilderError } from "../../Errors.js";
import { anchorCbor, poolHash } from "./Governance.js";
import { validateAndGetStakeCredential } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
import type { TxBuilderConfig } from "../TxBuilder.js";
export const governanceActionError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ GovernanceAction: ${cause} }` });
export const cloneGovernanceVoter = (voter: GovernanceVoter): GovernanceVoter =>
  structuredClone(voter);
export const cloneGovernanceAction = (
  action: GovernanceAction,
): GovernanceAction => {
  const snapshot = structuredClone(action);
  if (
    action.type === "ParameterChange" &&
    typeof action.protocolParamUpdate !== "string"
  ) {
    return {
      ...snapshot,
      type: "ParameterChange",
      protocolParamUpdate: encodeCbor(action.protocolParamUpdate),
    } as GovernanceAction;
  }
  return snapshot;
};
export const cloneGovernanceProposal = (
  proposal: GovernanceProposal,
): GovernanceProposal => ({
  ...structuredClone(proposal),
  action: cloneGovernanceAction(proposal.action),
});
const actionIdTerm = (id?: GovernanceActionId | null): CborValue =>
  id ? [fromHex(id.txHash), BigInt(id.index)] : null;
const hashTerm = (hash?: string | null): CborValue =>
  hash ? fromHex(hash) : null;
export const governancePolicyHash = (
  action: GovernanceAction,
): string | undefined => {
  if (
    action.type === "ParameterChange" ||
    action.type === "TreasuryWithdrawals"
  )
    return action.policyHash ?? undefined;
  if (action.type === "Cbor") {
    const fields = decodeCbor(action.cbor) as CborValue[],
      tag = Number(fields[0]);
    const hash = fields[tag === 0 ? 3 : tag === 2 ? 2 : -1];
    return hash instanceof Uint8Array ? toHex(hash) : undefined;
  }
  return undefined;
};
const actionTerm = (action: GovernanceAction): CborValue => {
  switch (action.type) {
    case "ParameterChange":
      return [
        0n,
        actionIdTerm(action.actionId),
        typeof action.protocolParamUpdate === "string"
          ? decodeCbor(action.protocolParamUpdate)
          : action.protocolParamUpdate,
        hashTerm(action.policyHash),
      ];
    case "HardForkInitiation":
      return [
        1n,
        actionIdTerm(action.actionId),
        [
          BigInt(action.protocolVersion.major),
          BigInt(action.protocolVersion.minor),
        ],
      ];
    case "TreasuryWithdrawals": {
      const seen = new Set<string>();
      return [
        2n,
        new Map(
          action.withdrawals.map((w) => {
            const address = getAddressDetails(w.rewardAddress).address.hex;
            if (seen.has(address))
              throw new Error(
                `Duplicate treasury withdrawal address: ${w.rewardAddress}`,
              );
            seen.add(address);
            return [fromHex(address), w.amount] as const;
          }),
        ),
        hashTerm(action.policyHash),
      ];
    }
    case "NoConfidence":
      return [3n, actionIdTerm(action.actionId)];
    case "UpdateCommittee":
      return [
        4n,
        actionIdTerm(action.actionId),
        action.remove.map(credentialCbor),
        new Map(
          action.add.map((m) => [
            credentialCbor(m.credential),
            BigInt(m.epoch),
          ]),
        ),
        new CborTag(30n, [
          BigInt(action.threshold.numerator),
          BigInt(action.threshold.denominator),
        ]),
      ];
    case "NewConstitution":
      return [
        5n,
        actionIdTerm(action.actionId),
        [
          anchorCbor(action.constitution.anchor),
          hashTerm(action.constitution.scriptHash),
        ],
      ];
    case "InfoAction":
      return [6n];
    case "Cbor":
      return decodeCbor(action.cbor);
  }
};
export const voterTerm = (voter: GovernanceVoter): CborValue =>
  voter.type === "StakePool"
    ? [4n, "poolId" in voter ? poolHash(voter.poolId) : fromHex(voter.hash)]
    : [
        BigInt(
          (voter.type === "DRep" ? 2 : 0) +
            (voter.credential.type === "Script" ? 1 : 0),
        ),
        fromHex(voter.credential.hash),
      ];
export const governanceVoterKey = (voter: GovernanceVoter): string =>
  encodeCbor(voterTerm(voter));
const proposalTerm = (
  proposal: GovernanceProposal,
  config: TxBuilderConfig,
): CborValue => [
  proposal.deposit ?? config.lucidConfig.protocolParameters.govActionDeposit,
  fromHex(getAddressDetails(proposal.returnAddress).address.hex),
  actionTerm(proposal.action),
  anchorCbor(proposal.anchor),
];
export const governanceProposalKey = (
  proposal: GovernanceProposal,
  config: TxBuilderConfig,
): Effect.Effect<string, TxBuilderError> =>
  Effect.try({
    try: () => encodeCbor(proposalTerm(proposal, config)),
    catch: governanceActionError,
  });
export const vote = (
  voter: GovernanceVoter,
  actionId: GovernanceActionId,
  choice: GovernanceVote,
  anchor?: Anchor,
  redeemer?: Redeemer,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    yield* Effect.try({
      try: () => {
        const key = governanceVoterKey(voter),
          entry = config.votes.get(key) ?? {
            voter: voterTerm(voter),
            procedures: new Map<string, unknown>(),
            witness: undefined as Record<string, unknown> | undefined,
          };
        const actionKey = encodeCbor(actionIdTerm(actionId));
        if (entry.procedures.has(actionKey))
          throw new Error(
            "Vote already exists for this voter and governance action",
          );
        entry.procedures.set(actionKey, [
          BigInt(choice === "No" ? 0 : choice === "Yes" ? 1 : 2),
          anchorCbor(anchor),
        ]);
        if (voter.type !== "StakePool" && voter.credential.type === "Script") {
          const script = config.scripts.get(voter.credential.hash);
          if (script && script.type !== "Native" && script.type !== "PlutusV3")
            throw new Error("Governance voting scripts must use PlutusV3");
          if (script?.type !== "Native" && entry.witness)
            throw new Error(
              "Multiple Plutus voting procedures for the same voter are not supported in one transaction",
            );
          entry.witness = scWitness(config, voter.credential.hash, redeemer);
        }
        config.votes.set(key, entry);
      },
      catch: governanceActionError,
    });
  });
export const finalizeVotes = () =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    if (!config.votes.size) return;
    yield* Effect.try({
      try: () =>
        recordScBlock(config, {
          type: "vote",
          cbor: encodeCbor(
            new Map(
              [...config.votes].map(([, entry]) => [
                entry.voter as CborValue,
                new Map(
                  [...entry.procedures].map(([key, value]) => [
                    decodeCbor(key),
                    value as CborValue,
                  ]),
                ),
              ]),
            ),
          ),
          witnesses: [...config.votes]
            .filter(([, entry]) => entry.witness)
            .map(([voterCbor, entry]) => ({
              voterCbor,
              witness: entry.witness,
            })),
        }),
      catch: governanceActionError,
    });
  });
export const propose = (proposal: GovernanceProposal, redeemer?: Redeemer) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    yield* validateAndGetStakeCredential(proposal.returnAddress, config);
    if (proposal.action.type === "TreasuryWithdrawals") {
      for (const withdrawal of proposal.action.withdrawals) {
        yield* validateAndGetStakeCredential(withdrawal.rewardAddress, config);
      }
    }
    yield* Effect.try({
      try: () => {
        const hash = governancePolicyHash(proposal.action),
          script = hash ? config.scripts.get(hash) : undefined;
        if (script && script.type !== "Native" && script.type !== "PlutusV3")
          throw new Error("Governance proposal scripts must use PlutusV3");
        const cbor = encodeCbor(proposalTerm(proposal, config));
        if (
          !config.blocks.some((b) => b.type === "proposal" && b.cbor === cbor)
        ) {
          recordScBlock(config, {
            type: "proposal",
            cbor,
            ...(hash ? { witness: scWitness(config, hash, redeemer) } : {}),
          });
          config.governanceProposalCount++;
        }
      },
      catch: governanceActionError,
    });
  });
