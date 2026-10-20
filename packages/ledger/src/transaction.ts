import { ledger } from "./runtime.js";
import { bytesToHex, decodeCbor } from "./cbor.js";
import {
  CborTag,
  type CborValue,
  type LedgerOutRef,
  type LedgerOutput,
  type LedgerRedeemer,
  type TransactionSnapshot,
} from "./types.js";

const tags = [
  "spend",
  "mint",
  "publish",
  "withdraw",
  "vote",
  "propose",
] as const;
const sequence = (value: CborValue | undefined): CborValue[] => {
  if (value instanceof CborTag) return sequence(value.value);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Expected a ledger sequence");
  return value;
};
const map = (value: CborValue | undefined): Map<CborValue, CborValue> => {
  if (value === undefined) return new Map();
  if (!(value instanceof Map)) throw new Error("Expected a ledger map");
  return value;
};
const hex = (value: CborValue | undefined): string => {
  if (!(value instanceof Uint8Array)) throw new Error("Expected ledger bytes");
  return bytesToHex(value);
};
const integer = (value: CborValue | undefined): bigint | undefined =>
  value === undefined ? undefined : BigInt(value as bigint);
const refs = (value: CborValue | undefined): LedgerOutRef[] =>
  sequence(value).map((item) => {
    const [hash, index] = sequence(item);
    return { txHash: hex(hash), outputIndex: Number(index) };
  });
type WireOutput = Omit<LedgerOutput, "assets"> & {
  assets: Record<string, string>;
};
export function outputFromWire(output: WireOutput): LedgerOutput {
  return {
    ...output,
    assets: Object.fromEntries(
      Object.entries(output.assets).map(([unit, amount]) => [
        unit,
        BigInt(amount),
      ]),
    ),
  };
}
export function inspectTransaction(cbor: string): TransactionSnapshot {
  const result = ledger<{
    cborHex: string;
    txId: string;
    bodyCbor: string;
    lucidOutputs: WireOutput[];
    lucidCollateralReturn?: WireOutput | null;
    withdrawals: { address: string; lovelace: string }[];
    datums: { hash: string; cbor: string }[];
    redeemers: {
      tag: LedgerRedeemer["tag"];
      index: string;
      data: string;
      exUnits: { mem: string; steps: string };
    }[];
  }>("tx.inspect", { cbor });
  const transaction = sequence(decodeCbor(cbor));
  const fields = map(transaction[0]);
  const witnesses = map(transaction[1]);
  const mint: Record<string, bigint> = {};
  for (const [policy, assets] of map(fields.get(9n))) {
    for (const [name, amount] of map(assets))
      mint[hex(policy) + hex(name)] = BigInt(amount as bigint);
  }
  // These are the ledger's memoized bytes. Generic CBOR roundtripping could
  // change a committed datum/redeemer and therefore its integrity hash.
  const redeemers = result.redeemers.map((r) => ({
    ...r,
    index: BigInt(r.index),
    exUnits: { mem: BigInt(r.exUnits.mem), steps: BigInt(r.exUnits.steps) },
  }));
  redeemers.sort(
    (a, b) =>
      tags.indexOf(a.tag) - tags.indexOf(b.tag) ||
      (a.index < b.index ? -1 : a.index > b.index ? 1 : 0),
  );
  return {
    cbor: result.cborHex,
    hash: result.txId,
    bodyCbor: result.bodyCbor,
    body: {
      cbor: result.bodyCbor,
      fields,
      inputs: refs(fields.get(0n)),
      referenceInputs: refs(fields.get(18n)),
      collateralInputs: refs(fields.get(13n)),
      outputs: result.lucidOutputs.map(outputFromWire),
      fee: integer(fields.get(2n)) ?? 0n,
      mint,
      withdrawals: result.withdrawals.map((w) => ({
        rewardAddress: w.address,
        amount: BigInt(w.lovelace),
      })),
      certificates: sequence(fields.get(4n)),
      votes: fields.get(19n),
      proposals: sequence(fields.get(20n)),
      requiredSigners: sequence(fields.get(14n)).map(hex),
      validFrom: integer(fields.get(8n)),
      validUntil: integer(fields.get(3n)),
      collateralReturn: result.lucidCollateralReturn
        ? outputFromWire(result.lucidCollateralReturn)
        : undefined,
      totalCollateral: integer(fields.get(17n)),
      treasuryDonation: integer(fields.get(22n)),
      currentTreasury: integer(fields.get(21n)),
      auxiliaryDataHash: fields.has(7n) ? hex(fields.get(7n)) : undefined,
      scriptDataHash: fields.has(11n) ? hex(fields.get(11n)) : undefined,
      networkId: fields.has(15n) ? Number(fields.get(15n)) : undefined,
    },
    redeemers,
    datums: result.datums,
    witnesses,
    auxiliaryData: transaction[3] ?? null,
    isValid: transaction[2] !== false,
  };
}
export function canonicalTransactionCbor(
  transaction: TransactionSnapshot | string,
): string {
  return ledger<string>("tx.canonical", {
    cbor: typeof transaction === "string" ? transaction : transaction.cbor,
  });
}
export function transactionJson(transaction: TransactionSnapshot): object {
  return JSON.parse(
    JSON.stringify(transaction, (_, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Uint8Array) return bytesToHex(value);
      if (value instanceof Map) return Array.from(value);
      return value;
    }),
  );
}
