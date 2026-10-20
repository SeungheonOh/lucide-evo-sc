import type { Transaction } from "@lucid-evolution/core-types";
import {
  inspectTransaction,
  encodeCbor,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { toTraceTxOutput } from "./resolve.js";
import type { TraceAssets, TraceStatus, TraceTransaction } from "./model.js";

export type TxGraphTransactionInput =
  | Transaction
  | TransactionSnapshot
  | { toCBOR: (options?: { canonical: boolean }) => Transaction }
  | { toTransaction: () => TransactionSnapshot };
export type ParseTransactionOptions = {
  readonly label?: string;
  readonly status?: TraceStatus;
};
const certificateNames = [
  "StakeRegistration",
  "StakeDeregistration",
  "StakeDelegation",
  "PoolRegistration",
  "PoolRetirement",
  "RegCert",
  "UnregCert",
  "VoteDelegCert",
  "StakeVoteDelegCert",
  "StakeRegDelegCert",
  "VoteRegDelegCert",
  "StakeVoteRegDelegCert",
  "AuthCommitteeHotCert",
  "ResignCommitteeColdCert",
  "RegDrepCert",
  "UnregDrepCert",
  "UpdateDrepCert",
];
export function parseTransaction(
  input: TxGraphTransactionInput,
  options: ParseTransactionOptions = {},
): TraceTransaction {
  const tx =
    typeof input === "string"
      ? inspectTransaction(input)
      : "toCBOR" in input
        ? inspectTransaction(input.toCBOR())
        : "toTransaction" in input
          ? input.toTransaction()
          : input;
  const body = tx.body;
  const mint: TraceAssets = {},
    mintedAssets: TraceAssets = {},
    burnedAssets: TraceAssets = {};
  for (const unit of Object.keys(body.mint).sort()) {
    const quantity = body.mint[unit];
    if (quantity === 0n) continue;
    mint[unit] = String(quantity);
    if (quantity > 0n) mintedAssets[unit] = String(quantity);
    else burnedAssets[unit] = String(-quantity);
  }
  return {
    hash: tx.hash,
    label: options.label,
    status: options.status ?? "built",
    cbor: tx.cbor,
    sizeBytes: tx.cbor.length / 2,
    fee: String(body.fee),
    validityInterval: {
      validFrom: body.validFrom?.toString(),
      validTo: body.validUntil?.toString(),
    },
    inputs: body.inputs,
    referenceInputs: body.referenceInputs,
    collateralInputs: body.collateralInputs,
    collateralReturn: body.collateralReturn
      ? toTraceTxOutput(body.collateralReturn)
      : undefined,
    totalCollateral: body.totalCollateral?.toString(),
    outputs: body.outputs.map((output, outputIndex) => ({
      txHash: tx.hash,
      outputIndex,
      ...toTraceTxOutput(output),
      resolution: "resolved",
      tags: [],
    })),
    mint,
    mintedAssets,
    burnedAssets,
    withdrawals: body.withdrawals.map((w) => ({
      rewardAddress: w.rewardAddress,
      amount: String(w.amount),
    })),
    certificates: body.certificates.map((certificate, index) => {
      if (!Array.isArray(certificate))
        throw new Error("Invalid certificate in transaction snapshot");
      const tag = Number(certificate[0]);
      const kind = tag >= 7 ? tag - 2 : tag;
      return {
        index,
        kind,
        kindName: certificateNames[kind] ?? `Unknown(${kind})`,
        cbor: encodeCbor(certificate),
      };
    }),
    redeemers: tx.redeemers.map((redeemer, redeemerListIndex) => ({
      tag: redeemer.tag,
      index: String(redeemer.index),
      redeemerListIndex,
      data: redeemer.data,
      exUnits: {
        mem: String(redeemer.exUnits.mem),
        steps: String(redeemer.exUnits.steps),
      },
    })),
    requiredSigners: body.requiredSigners,
    auxiliaryDataHash: body.auxiliaryDataHash,
  };
}
export const parseTransactionCbor = (
  cbor: Transaction,
  options: ParseTransactionOptions = {},
) => parseTransaction(cbor, options);
