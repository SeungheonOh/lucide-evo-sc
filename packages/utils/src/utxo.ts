import type {
  Assets,
  OutRef,
  TxOutput,
  UTxO,
} from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
import {
  asList,
  asBytes,
  asInteger,
  decodeTerm,
  encodeTerm,
  integer,
} from "./ledger-cbor.js";

export const utxoToTransactionOutput = (utxo: TxOutput): string =>
  ledger("output.encode", { utxo });
export const utxoToTransactionInput = (utxo: OutRef): string =>
  encodeTerm({ list: [{ bytes: utxo.txHash }, integer(utxo.outputIndex)] });
export const utxoToCore = (utxo: UTxO): string =>
  encodeTerm({
    list: [
      decodeTerm(utxoToTransactionInput(utxo)),
      decodeTerm(utxoToTransactionOutput(utxo)),
    ],
  });
export const utxosToCores = (utxos: UTxO[]): string[] => utxos.map(utxoToCore);
export function coreToUtxo(cbor: string): UTxO {
  const [input, output] = asList(decodeTerm(cbor));
  return {
    ...coreToOutRef(encodeTerm(input)),
    ...coreToTxOutput(encodeTerm(output)),
  };
}
export const coresToUtxos = (utxos: string[]): UTxO[] => utxos.map(coreToUtxo);
export function coreToOutRef(cbor: string): OutRef {
  const [hash, index] = asList(decodeTerm(cbor));
  return { txHash: asBytes(hash), outputIndex: Number(asInteger(index)) };
}
export const coresToOutRefs = (inputs: string[]): OutRef[] =>
  inputs.map(coreToOutRef);
export function coreToTxOutput(cbor: string): TxOutput {
  const output = ledger<
    Omit<TxOutput, "assets"> & { assets: Record<string, string> }
  >("output.decode", { cbor });
  return {
    ...output,
    datum: output.datum ?? undefined,
    datumHash: output.datumHash ?? undefined,
    scriptRef: output.scriptRef ?? undefined,
    assets: Object.fromEntries(
      Object.entries(output.assets).map(([unit, amount]) => [
        unit,
        BigInt(amount),
      ]),
    ),
  };
}
export const coresToTxOutputs = (outputs: string[]): TxOutput[] =>
  outputs.map(coreToTxOutput);

/**
 * Returns a list of UTxOs whose total assets are equal to or greater than the asset value provided
 * @param utxos list of available utxos
 * @param totalAssets minimum total assets required
 * @param includeUTxOsWithScriptRef Whether to include UTxOs with scriptRef or not. default = false
 */
export const selectUTxOs = (
  utxos: UTxO[],
  totalAssets: Assets,
  includeUTxOsWithScriptRef: boolean = false,
) => {
  const selectedUtxos: UTxO[] = [];
  let isSelected = false;
  const assetsRequired = new Map<string, bigint>(Object.entries(totalAssets));
  for (const utxo of utxos) {
    if (!includeUTxOsWithScriptRef && utxo.scriptRef) continue;
    isSelected = false;
    for (const [unit, amount] of assetsRequired) {
      if (Object.hasOwn(utxo.assets, unit)) {
        const utxoAmount = utxo.assets[unit];
        if (utxoAmount >= amount) {
          assetsRequired.delete(unit);
        } else {
          assetsRequired.set(unit, amount - utxoAmount);
        }
        isSelected = true;
      }
    }
    if (isSelected) {
      selectedUtxos.push(utxo);
    }
    if (assetsRequired.size == 0) {
      break;
    }
  }
  if (assetsRequired.size > 0) return [];
  return selectedUtxos;
};

/**
 * Union type for specifying sorting order in function "sortUTxOs"
 */
export type SortOrder =
  /**
   * Largest amount of "lovelace" with least number of unique assets first
   */
  | "LargestFirst"
  /**
   * Smallest amount of "lovelace" with least number of unique assets first
   */
  | "SmallestFirst"
  /**
   * Lexicographically sorted as per ledger rules
   */
  | "Canonical";

/**
 * Sorts an array of UTXOs according to specified sort order ("LargestFirst" by default).
 * The provided array is cloned and reference to the new sorted array is returned.
 *
 * @param {UTxO[]} utxos - The array of UTXO objects to be sorted.
 * @param {SortOrder} [order="LargestFirst"] - The order in which to sort the UTXOs.
 * @returns {UTxO[]} - The sorted array of UTXOs.
 *
 */
export const sortUTxOs = (
  utxos: UTxO[],
  order: SortOrder = "LargestFirst",
): UTxO[] => {
  switch (order) {
    case "LargestFirst":
      return [...utxos].sort(largestFirst);
    case "SmallestFirst":
      return [...utxos].sort(smallestFirst);
    case "Canonical":
      return [...utxos].sort(canonical);
  }
};

const largestFirst = (a: UTxO, b: UTxO) => {
  const lovelaceA = Number(a.assets["lovelace"]);
  const lovelaceB = Number(b.assets["lovelace"]);

  if (lovelaceA === lovelaceB) {
    return Object.keys(a.assets).length - Object.keys(b.assets).length;
  }
  return -1 * (lovelaceA - lovelaceB);
};

const smallestFirst = (a: UTxO, b: UTxO) => {
  const lovelaceA = Number(a.assets["lovelace"]);
  const lovelaceB = Number(b.assets["lovelace"]);

  if (lovelaceA == lovelaceB) {
    return Object.keys(a.assets).length - Object.keys(b.assets).length;
  }
  return lovelaceA - lovelaceB;
};

const canonical = (a: UTxO, b: UTxO) => {
  if (a.txHash < b.txHash) {
    return -1;
  } else if (a.txHash > b.txHash) {
    return 1;
  } else {
    return a.outputIndex - b.outputIndex;
  }
};

//TODO: add
// sortBy -> sort by amount of specific unit

export const isEqualUTxO = (self: UTxO, that: UTxO) =>
  self.txHash === that.txHash && self.outputIndex === that.outputIndex;

/**
 * Provides an array of input indices for given "indexInputs" UTxOs.
 * Indices obtained from the list of transaction inputs which are
 * ordered as per ledger rules.
 *
 * @param indexInputs Input utxos whose indices need to be returned
 * @param allInputs All the inputs utxos being spent by the transaction
 * @param sorted Whether the provided "allInputs" are sorted canonically or not
 * @returns Input indices of utxos as they appear in "indexInputs"
 */
export function getInputIndices(
  indexInputs: UTxO[],
  allInputs: UTxO[],
  sorted: Boolean = false,
): bigint[] {
  const sortedInputs = sorted ? allInputs : sortUTxOs(allInputs, "Canonical");
  const indicesMap = new Map<string, bigint>();

  sortedInputs.forEach((value, index) => {
    indicesMap.set(value.txHash + value.outputIndex, BigInt(index));
  });

  return indexInputs.flatMap((value) => {
    const index = indicesMap.get(value.txHash + value.outputIndex);
    if (index !== undefined) return index;
    else return [];
  });
}

export const calculateMinLovelaceFromUTxO = (
  coinsPerUtxoByte: bigint,
  utxo: UTxO,
): bigint =>
  BigInt(
    ledger<string>("output.minAda", {
      output: utxo,
      coinsPerUtxoByte: String(coinsPerUtxoByte),
    }),
  );
