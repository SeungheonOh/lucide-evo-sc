import type { OutRef, TxOutput } from "@lucid-evolution/core-types";
import {
  encodeCbor,
  decodeCbor,
  ledger,
  type CborValue,
} from "@lucid-evolution/ledger";
import {
  utxoToTransactionInput,
  utxoToTransactionOutput,
} from "@lucid-evolution/utils";

export function fixtureTransaction(options: {
  inputs: OutRef[];
  outputs: TxOutput[];
  fee: bigint;
  referenceInputs?: OutRef[];
  collateralInputs?: OutRef[];
  collateralReturn?: TxOutput;
  totalCollateral?: bigint;
  witnesses?: Map<CborValue, CborValue>;
  privateKeys?: string[];
}): string {
  const inputs = (refs: OutRef[]) =>
    refs.map((ref) => decodeCbor(utxoToTransactionInput(ref)));
  const body = new Map<CborValue, CborValue>([
    [0n, inputs(options.inputs)],
    [
      1n,
      options.outputs.map((output) =>
        decodeCbor(utxoToTransactionOutput(output)),
      ),
    ],
    [2n, options.fee],
  ]);
  if (options.referenceInputs?.length)
    body.set(18n, inputs(options.referenceInputs));
  if (options.collateralInputs?.length)
    body.set(13n, inputs(options.collateralInputs));
  if (options.collateralReturn)
    body.set(
      16n,
      decodeCbor(utxoToTransactionOutput(options.collateralReturn)),
    );
  if (options.totalCollateral !== undefined)
    body.set(17n, options.totalCollateral);
  const cbor = encodeCbor([
    body,
    options.witnesses ?? new Map<CborValue, CborValue>(),
    true,
    null,
  ]);
  if (!options.privateKeys?.length) return cbor;
  const witnesses = ledger<string>("tx.sign", {
    cbor,
    privateKeys: options.privateKeys,
  });
  return ledger("tx.mergeWitnesses", { cbor, witnessSets: [witnesses] });
}
