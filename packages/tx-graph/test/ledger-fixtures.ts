import {
  decodeCbor,
  encodeCbor,
  hexToBytes,
  inspectTransaction,
  type CborValue,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { utxoToTransactionOutput } from "@lucid-evolution/utils";
import type { TraceOutRef } from "../src/model.js";
export const fixtureAddress =
  "addr_test1qrngfyc452vy4twdrepdjc50d4kvqutgt0hs9w6j2qhcdjfx0gpv7rsrjtxv97rplyz3ymyaqdwqa635zrcdena94ljs0xy950";
export const inputList = (refs: ReadonlyArray<TraceOutRef>): CborValue[] =>
  refs.map((ref) => [hexToBytes(ref.txHash), BigInt(ref.outputIndex)]);
export const output = (lovelace: bigint): CborValue =>
  decodeCbor(
    utxoToTransactionOutput({
      address: fixtureAddress,
      assets: { lovelace },
    }),
  );
export function transaction(
  inputs: ReadonlyArray<TraceOutRef>,
  outputs: ReadonlyArray<bigint>,
  configure?: (body: Map<CborValue, CborValue>) => void,
  witnesses: Map<CborValue, CborValue> = new Map(),
): TransactionSnapshot {
  const body = new Map<CborValue, CborValue>([
    [0n, inputList(inputs)],
    [1n, outputs.map(output)],
    [2n, 170_000n],
  ]);
  configure?.(body);
  return inspectTransaction(encodeCbor([body, witnesses, true, null]));
}
