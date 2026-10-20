import {
  Data,
  type Data as PlutusData,
  slotToBeginUnixTime,
} from "@lucid-evolution/plutus";
import * as Effect from "effect/Effect";
import type {
  Credential,
  SlotConfig,
  UTxO,
  TxOutput,
} from "@lucid-evolution/core-types";
import {
  datumToHash,
  getAddressDetails,
  validatorToScriptHash,
} from "@lucid-evolution/utils";
import {
  CborTag,
  encodeCbor,
  inspectTransaction,
  type CborValue,
  type TransactionSnapshot,
  type LedgerRedeemer,
} from "@lucid-evolution/ledger";
import { toHex } from "@lucid-evolution/core-utils";
import {
  buildCanonicalRedeemerInfo,
  orderedVoters,
  type CanonicalRedeemerInfo,
} from "../tx-builder/internal/RedeemerContext.js";
import { ScriptPurposeData } from "./Schema.js";
import type {
  CredentialData,
  DRepData,
  GovernanceActionData,
  GovernanceActionIdData,
  ProposalProcedureData,
  ScriptContextData,
  ScriptInfoData,
  TxCertData,
  TxInInfoData,
  TxInfoData,
  TxOutData,
  TxOutRefData,
  ValueData,
  VoteData,
  VoterData,
} from "./Schema.js";
export type ScriptContextOptions = {
  resolvedInputs?: ReadonlyArray<UTxO>;
  slotConfig?: SlotConfig;
};
export type ScriptContext = ScriptContextData;
export type ScriptPurpose = ScriptPurposeData;
const array = (value: CborValue | undefined): CborValue[] =>
  value instanceof CborTag
    ? array(value.value)
    : Array.isArray(value)
      ? value
      : [];
const map = (value: CborValue | undefined): Map<CborValue, CborValue> =>
  value instanceof Map ? value : new Map();
const hex = (value: CborValue | undefined): string => {
  if (!(value instanceof Uint8Array))
    throw new Error("Expected ledger bytes in ScriptContext");
  return toHex(value);
};
const int = (value: CborValue): bigint => BigInt(value as bigint);
const compareInteger = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const sortedMap = <K, V>(
  entries: ReadonlyArray<readonly [K, V]>,
  compare: (a: K, b: K) => number,
): Map<K, V> => new Map([...entries].sort(([a], [b]) => compare(a, b)));
const credential = (value: CborValue): CredentialData => {
  const [kind, hash] = array(value);
  return kind === 0n
    ? { PubKeyCredential: [hex(hash)] }
    : { ScriptCredential: [hex(hash)] };
};
const coreCredential = (c: Credential): CredentialData =>
  c.type === "Key"
    ? { PubKeyCredential: [c.hash] }
    : { ScriptCredential: [c.hash] };
const rewardCredential = (value: string | CborValue): CredentialData => {
  if (typeof value === "string") {
    const c = getAddressDetails(value).stakeCredential;
    if (!c) throw new Error("Expected reward credential");
    return coreCredential(c);
  }
  const bytes = value as Uint8Array;
  return bytes[0] >> 4 === 14
    ? { PubKeyCredential: [toHex(bytes.subarray(1))] }
    : { ScriptCredential: [toHex(bytes.subarray(1))] };
};
const compareCredential = (a: CredentialData, b: CredentialData): number => {
  const ak = "PubKeyCredential" in a,
    bk = "PubKeyCredential" in b;
  if (ak !== bk) return ak ? 1 : -1;
  const ah = ak ? a.PubKeyCredential[0] : a.ScriptCredential[0],
    bh = bk ? b.PubKeyCredential[0] : b.ScriptCredential[0];
  return ah.localeCompare(bh);
};
const valueData = (assets: Record<string, bigint>): ValueData => {
  const result = new Map<string, Map<string, bigint>>();
  for (const [unit, q] of Object.entries(assets).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (q === 0n) continue;
    const policy = unit === "lovelace" ? "" : unit.slice(0, 56),
      name = unit === "lovelace" ? "" : unit.slice(56),
      tokens = result.get(policy) ?? new Map();
    tokens.set(name, q);
    result.set(policy, tokens);
  }
  return sortedMap(
    [...result].map(
      ([policy, tokens]) =>
        [policy, sortedMap([...tokens], (a, b) => a.localeCompare(b))] as const,
    ),
    (a, b) => a.localeCompare(b),
  );
};
const output = (o: TxOutput): TxOutData => {
  const address = getAddressDetails(o.address);
  if (!address.paymentCredential)
    throw new Error(
      "ScriptContext transaction outputs require a payment credential",
    );
  if (address.type === "Pointer")
    throw new Error(
      "Pointer address ScriptContext translation is not supported",
    );
  return {
    txOutAddress: {
      addressCredential: coreCredential(address.paymentCredential),
      addressStakingCredential: address.stakeCredential
        ? { StakingHash: [coreCredential(address.stakeCredential)] }
        : null,
    },
    txOutValue: valueData(o.assets),
    txOutDatum: o.datumHash
      ? { OutputDatumHash: [o.datumHash] }
      : o.datum
        ? { OutputDatum: [Data.from(o.datum)] }
        : "NoOutputDatum",
    txOutReferenceScript: o.scriptRef
      ? validatorToScriptHash(o.scriptRef)
      : null,
  };
};
const input = (u: UTxO): TxInInfoData => ({
  txInInfoOutRef: { txOutRefId: u.txHash, txOutRefIdx: BigInt(u.outputIndex) },
  txInInfoResolved: output(u),
});
const drep = (term: CborValue): DRepData => {
  const [kind] = array(term);
  return kind === 2n
    ? "DRepAlwaysAbstain"
    : kind === 3n
      ? "DRepAlwaysNoConfidence"
      : { DRep: [credential(term)] };
};
const certificate = (term: CborValue): TxCertData => {
  const [kind, c, a, b, d] = array(term);
  switch (Number(kind)) {
    case 0:
      return { TxCertRegStaking: [credential(c), null] };
    case 7:
      return { TxCertRegStaking: [credential(c), int(a)] };
    case 1:
      return { TxCertUnRegStaking: [credential(c), null] };
    case 8:
      return { TxCertUnRegStaking: [credential(c), int(a)] };
    case 2:
      return { TxCertDelegStaking: [credential(c), { DelegStake: [hex(a)] }] };
    case 3:
      return { TxCertPoolRegister: [hex(c), hex(a)] };
    case 4:
      return { TxCertPoolRetire: [hex(c), int(a)] };
    case 9:
      return { TxCertDelegStaking: [credential(c), { DelegVote: [drep(a)] }] };
    case 10:
      return {
        TxCertDelegStaking: [
          credential(c),
          { DelegStakeVote: [hex(a), drep(b)] },
        ],
      };
    case 11:
      return {
        TxCertRegDeleg: [credential(c), { DelegStake: [hex(a)] }, int(b)],
      };
    case 12:
      return {
        TxCertRegDeleg: [credential(c), { DelegVote: [drep(a)] }, int(b)],
      };
    case 13:
      return {
        TxCertRegDeleg: [
          credential(c),
          { DelegStakeVote: [hex(a), drep(b)] },
          int(d),
        ],
      };
    case 14:
      return { TxCertAuthHotCommittee: [credential(c), credential(a)] };
    case 15:
      return { TxCertResignColdCommittee: [credential(c)] };
    case 16:
      return { TxCertRegDRep: [credential(c), int(a)] };
    case 17:
      return { TxCertUnRegDRep: [credential(c), int(a)] };
    case 18:
      return { TxCertUpdateDRep: [credential(c)] };
    default:
      throw new Error(`Unsupported certificate ${kind} in ScriptContext`);
  }
};
const actionId = (value: CborValue): GovernanceActionIdData | null =>
  value === null
    ? null
    : { gaidTxId: hex(array(value)[0]), gaidGovActionIx: int(array(value)[1]) };
const compareAction = (a: GovernanceActionIdData, b: GovernanceActionIdData) =>
  a.gaidTxId.localeCompare(b.gaidTxId) ||
  compareInteger(a.gaidGovActionIx, b.gaidGovActionIx);
const rational = (value: CborValue): [bigint, bigint] => {
  const [a, b] = array(value);
  return [int(a), int(b)];
};
const parameterData = (value: CborValue): PlutusData => {
  if (value instanceof CborTag) return parameterData(value.value);
  if (typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(parameterData);
  if (value instanceof Map)
    return new Map(
      [...value].map(([k, v]) => [parameterData(k), parameterData(v)]),
    );
  throw new Error("Unsupported protocol parameter in ScriptContext");
};
const governance = (term: CborValue): GovernanceActionData => {
  const [kind, a, b, c, d] = array(term);
  switch (Number(kind)) {
    case 0: {
      if (map(b).has(18n))
        throw new Error(
          "Protocol parameter cost model updates are not yet supported in ScriptContext translation.",
        );
      return {
        ParameterChange: [
          actionId(a),
          parameterData(b),
          c === null ? null : hex(c),
        ],
      };
    }
    case 1: {
      const [major, minor] = array(b);
      return {
        HardForkInitiation: [
          actionId(a),
          { pvMajor: int(major), pvMinor: int(minor) },
        ],
      };
    }
    case 2:
      return {
        TreasuryWithdrawals: [
          sortedMap(
            [...map(a)].map(
              ([address, amount]) =>
                [rewardCredential(address), int(amount)] as const,
            ),
            compareCredential,
          ),
          b === null ? null : hex(b),
        ],
      };
    case 3:
      return { NoConfidence: [actionId(a)] };
    case 4:
      return {
        UpdateCommittee: [
          actionId(a),
          array(b).map(credential).sort(compareCredential),
          sortedMap(
            [...map(c)].map(
              ([cr, epoch]) => [credential(cr), int(epoch)] as const,
            ),
            compareCredential,
          ),
          rational(d),
        ],
      };
    case 5: {
      const constitution = array(b);
      return {
        NewConstitution: [
          actionId(a),
          {
            constitutionScript:
              constitution[1] === null ? null : hex(constitution[1]),
          },
        ],
      };
    }
    case 6:
      return "InfoAction";
    default:
      throw new Error("Unsupported governance action in ScriptContext");
  }
};
const proposal = (term: CborValue): ProposalProcedureData => {
  const [deposit, address, action] = array(term);
  return {
    ppDeposit: int(deposit),
    ppReturnAddr: rewardCredential(address),
    ppGovernanceAction: governance(action),
  };
};
const voter = (term: CborValue): VoterData => {
  const [kind, hash] = array(term),
    k = Number(kind);
  if (k === 4) return { StakePoolVoter: [hex(hash)] };
  const c = credential([BigInt(k % 2), hash]);
  return k < 2 ? { CommitteeVoter: [c] } : { DRepVoter: [c] };
};
const voterRank = (v: VoterData) =>
  "CommitteeVoter" in v ? 0 : "DRepVoter" in v ? 1 : 2;
const compareVoter = (a: VoterData, b: VoterData): number => {
  const rank = voterRank(a) - voterRank(b);
  if (rank) return rank;
  if ("StakePoolVoter" in a && "StakePoolVoter" in b)
    return a.StakePoolVoter[0].localeCompare(b.StakePoolVoter[0]);
  if ("StakePoolVoter" in a || "StakePoolVoter" in b) return 0;
  return compareCredential(
    "CommitteeVoter" in a ? a.CommitteeVoter[0] : a.DRepVoter[0],
    "CommitteeVoter" in b ? b.CommitteeVoter[0] : b.DRepVoter[0],
  );
};
const purposeRank = (p: ScriptPurposeData) =>
  "Spending" in p
    ? 0
    : "Minting" in p
      ? 1
      : "Certifying" in p
        ? 2
        : "Rewarding" in p
          ? 3
          : "Voting" in p
            ? 4
            : 5;
const comparePurpose = (a: ScriptPurposeData, b: ScriptPurposeData): number => {
  const rank = purposeRank(a) - purposeRank(b);
  if (rank) return rank;
  if ("Spending" in a && "Spending" in b)
    return (
      a.Spending[0].txOutRefId.localeCompare(b.Spending[0].txOutRefId) ||
      compareInteger(a.Spending[0].txOutRefIdx, b.Spending[0].txOutRefIdx)
    );
  if ("Minting" in a && "Minting" in b)
    return a.Minting[0].localeCompare(b.Minting[0]);
  if ("Certifying" in a && "Certifying" in b)
    return compareInteger(a.Certifying[0], b.Certifying[0]);
  if ("Rewarding" in a && "Rewarding" in b)
    return compareCredential(a.Rewarding[0], b.Rewarding[0]);
  if ("Voting" in a && "Voting" in b)
    return compareVoter(a.Voting[0], b.Voting[0]);
  if ("Proposing" in a && "Proposing" in b)
    return compareInteger(a.Proposing[0], b.Proposing[0]);
  return 0;
};
const purpose = (
  r: LedgerRedeemer,
  tx: TransactionSnapshot,
  info: CanonicalRedeemerInfo,
): ScriptPurposeData => {
  const index = Number(r.index);
  switch (r.tag) {
    case "spend":
      return {
        Spending: [
          {
            txOutRefId: info.inputs[index].txHash,
            txOutRefIdx: BigInt(info.inputs[index].outputIndex),
          },
        ],
      };
    case "mint":
      return {
        Minting: [
          [
            ...new Set(Object.keys(tx.body.mint).map((u) => u.slice(0, 56))),
          ].sort()[index],
        ],
      };
    case "withdraw":
      return {
        Rewarding: [rewardCredential(tx.body.withdrawals[index].rewardAddress)],
      };
    case "publish":
      return {
        Certifying: [r.index, certificate(tx.body.certificates[index])],
      };
    case "vote":
      return { Voting: [voter(orderedVoters(tx)[index])] };
    case "propose":
      return { Proposing: [r.index, proposal(tx.body.proposals[index])] };
  }
};
const scriptInfo = (
  p: ScriptPurposeData,
  info: CanonicalRedeemerInfo,
  datums: Map<string, PlutusData>,
): ScriptInfoData => {
  if ("Minting" in p) return { MintingScript: p.Minting };
  if ("Rewarding" in p) return { RewardingScript: p.Rewarding };
  if ("Certifying" in p) return { CertifyingScript: p.Certifying };
  if ("Voting" in p) return { VotingScript: p.Voting };
  if ("Proposing" in p) return { ProposingScript: p.Proposing };
  const ref = p.Spending[0],
    u = info.inputs.find(
      (u) =>
        u.txHash === ref.txOutRefId &&
        BigInt(u.outputIndex) === ref.txOutRefIdx,
    );
  return {
    SpendingScript: [
      ref,
      u?.datum
        ? Data.from(u.datum)
        : u?.datumHash
          ? (datums.get(u.datumHash) ?? null)
          : null,
    ],
  };
};
export const makeScriptContexts = (
  transaction: TransactionSnapshot | string,
  options: ScriptContextOptions = {},
): ScriptContextData[] => {
  const tx =
      typeof transaction === "string"
        ? inspectTransaction(transaction)
        : transaction,
    body = tx.body;
  const info = Effect.runSync(
    buildCanonicalRedeemerInfo(tx, options.resolvedInputs ?? []),
  );
  const datums = sortedMap<string, PlutusData>(
    (
      tx.datums ??
      array(tx.witnesses.get(4n)).map((d) => {
        const cbor = encodeCbor(d);
        return { hash: datumToHash(cbor), cbor };
      })
    ).map((d) => [d.hash, Data.from<PlutusData>(d.cbor)] as const),
    (a, b) => a.localeCompare(b),
  );
  const entries = tx.redeemers
    .map((r) => [purpose(r, tx, info), Data.from(r.data)] as const)
    .sort(([a], [b]) => comparePurpose(a, b));
  const time = (slot: bigint): bigint => {
    if (!options.slotConfig?.slotLength)
      throw new Error(
        "ScriptContext translation requires a valid slotConfig to translate the transaction validity interval.",
      );
    return BigInt(slotToBeginUnixTime(Number(slot), options.slotConfig));
  };
  const votes = sortedMap(
    [...map(body.votes)].map(
      ([v, procedures]) =>
        [
          voter(v),
          sortedMap(
            [...map(procedures)].map(
              ([id, procedure]) =>
                [
                  actionId(id)!,
                  ["VoteNo", "VoteYes", "Abstain"][
                    Number(array(procedure)[0])
                  ] as VoteData,
                ] as const,
            ),
            compareAction,
          ),
        ] as const,
    ),
    compareVoter,
  );
  const txInfo: TxInfoData = {
    txInfoInputs: info.inputs.map(input),
    txInfoReferenceInputs: info.referenceInputs.map(input),
    txInfoOutputs: body.outputs.map(output),
    txInfoFee: body.fee,
    txInfoMint: valueData(body.mint),
    txInfoTxCerts: body.certificates.map(certificate),
    txInfoWdrl: sortedMap(
      body.withdrawals.map(
        (w) => [rewardCredential(w.rewardAddress), w.amount] as const,
      ),
      compareCredential,
    ),
    txInfoValidRange: {
      ivFrom: {
        lowerBoundLimit:
          body.validFrom === undefined
            ? "NegInf"
            : { Finite: [time(body.validFrom)] },
        lowerBoundClosed: true,
      },
      ivTo: {
        upperBoundLimit:
          body.validUntil === undefined
            ? "PosInf"
            : { Finite: [time(body.validUntil)] },
        upperBoundClosed: body.validUntil === undefined,
      },
    },
    txInfoSignatories: [...body.requiredSigners].sort(),
    txInfoRedeemers: new Map(entries),
    txInfoData: datums,
    txInfoId: tx.hash,
    txInfoVotes: votes,
    txInfoProposalProcedures: body.proposals.map(proposal),
    txInfoCurrentTreasuryAmount: body.currentTreasury ?? null,
    txInfoTreasuryDonation: body.treasuryDonation ?? null,
  };
  return entries.map(([p, redeemer]) => ({
    scriptContextTxInfo: txInfo,
    scriptContextRedeemer: redeemer,
    scriptContextScriptInfo: scriptInfo(p, info, datums),
  }));
};
export const makeScriptContext = (
  transaction: TransactionSnapshot | string,
  requested: ScriptPurposeData,
  options: ScriptContextOptions = {},
): ScriptContextData => {
  const contexts = makeScriptContexts(transaction, options),
    key = Data.to(requested, ScriptPurposeData);
  const purposes = contexts[0]
    ? [...contexts[0].scriptContextTxInfo.txInfoRedeemers.keys()]
    : [];
  const index = purposes.findIndex(
    (p) => Data.to(p, ScriptPurposeData) === key,
  );
  if (index < 0) throw new Error("No redeemer found for ScriptContext purpose");
  return contexts[index];
};
