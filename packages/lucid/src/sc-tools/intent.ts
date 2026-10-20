import type {
  Assets,
  Credential,
  Script,
  UTxO,
  TxOutput,
} from "@lucid-evolution/core-types";
import {
  paymentCredentialOf,
  applyDoubleCborEncoding,
  validatorToScriptHash,
} from "@lucid-evolution/utils";
import { encodeCbor, type CborValue } from "@lucid-evolution/ledger";
import { fromHex } from "@lucid-evolution/core-utils";
import { ERROR_MESSAGE } from "../Errors.js";
import type { TxBuilderConfig } from "../tx-builder/TxBuilder.js";

type Block = Record<string, unknown>;
const witnessHashes = new WeakMap<Block, string>();
export const scBlocks = (config: TxBuilderConfig): Block[] => config.blocks;
export const recordScBlock = (config: TxBuilderConfig, block: Block): void => {
  config.blocks.push(block);
};
export const scOutRef = (utxo: Pick<UTxO, "txHash" | "outputIndex">): string =>
  `${utxo.txHash}#${utxo.outputIndex}`;
export function recordScValidity(
  config: TxBuilderConfig,
  bound: "from" | "until",
  slot: number,
): void {
  let block = config.blocks.find((b) => b.type === "validity");
  if (!block) {
    block = { type: "validity" };
    config.blocks.push(block);
  }
  block[bound] = String(slot);
}
export const scScript = (script: Script): Block =>
  script.type === "Native"
    ? { language: "Native", nativeScriptCbor: script.script }
    : {
        language: script.type,
        scriptCbor: applyDoubleCborEncoding(script.script),
      };
export function scWitness(
  config: TxBuilderConfig,
  hash: string,
  redeemer?: string,
): Block {
  const script = config.scripts.get(hash);
  if (!script) throw new Error(ERROR_MESSAGE.MISSING_SCRIPT(hash));
  if (script.type !== "Native" && redeemer === undefined)
    throw new Error(ERROR_MESSAGE.MISSING_REDEEMER);
  const witness = {
    ...scScript(script),
    ...(redeemer !== undefined ? { redeemerCbor: redeemer } : {}),
  };
  witnessHashes.set(witness, hash);
  return witness;
}
export function recordScInput(
  config: TxBuilderConfig,
  utxo: UTxO,
  redeemer?: string,
): void {
  const credential = paymentCredentialOf(utxo.address);
  recordScBlock(config, {
    type: "input",
    input: scOutRef(utxo),
    ...(credential.type === "Script"
      ? { witness: scWitness(config, credential.hash, redeemer) }
      : {}),
    ...(utxo.datumHash && utxo.datum ? { datumCbor: utxo.datum } : {}),
  });
}
export function recordScOutput(
  config: TxBuilderConfig,
  output: TxOutput,
  embedded?: string,
): void {
  recordScBlock(config, {
    type: "output",
    output: {
      address: output.address,
      lovelace: String(output.assets.lovelace ?? 0n),
      assets: scAssets(output.assets),
      ...(embedded
        ? { datumMode: "embedded", datumCbor: embedded }
        : output.datumHash
          ? { datumMode: "hash", datumHash: output.datumHash }
          : output.datum
            ? { datumMode: "inline", datumCbor: output.datum }
            : {}),
      ...(output.scriptRef
        ? { referenceScript: scScript(output.scriptRef) }
        : {}),
    },
  });
}
export const scAssets = (assets: Assets) =>
  Object.entries(assets)
    .filter(([unit]) => unit !== "lovelace")
    .map(([unit, quantity]) => ({
      policyId: unit.slice(0, 56),
      assetName: unit.slice(56),
      quantity: String(quantity),
    }));
export function recordScMint(
  config: TxBuilderConfig,
  assets: Assets,
  redeemer?: string,
): void {
  const tokens = scAssets(assets),
    policyId = tokens[0].policyId;
  recordScBlock(config, {
    type: "mint",
    policyId,
    assets: tokens,
    witness: scWitness(config, policyId, redeemer),
  });
}
export const credentialCbor = (credential: Credential): CborValue => [
  credential.type === "Key" ? 0n : 1n,
  fromHex(credential.hash),
];
export function recordCertificate(
  config: TxBuilderConfig,
  certificate: CborValue,
  credential?: Credential,
  redeemer?: string,
  needsWitness = true,
): void {
  recordScBlock(config, {
    type: "certificate",
    kind: "raw",
    cbor: encodeCbor(certificate),
    ...(credential && needsWitness
      ? {
          credential: credential.hash,
          ...(credential.type === "Script"
            ? { witness: scWitness(config, credential.hash, redeemer) }
            : {}),
        }
      : {}),
  });
}
export function resolveScReferences(
  config: TxBuilderConfig,
  blocks: Block[],
): void {
  const refs = new Map(
    [...config.collectedInputs, ...config.readInputs]
      .filter((u) => u.scriptRef)
      .map((u) => [validatorToScriptHash(u.scriptRef!), scOutRef(u)]),
  );
  const resolve = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const hash = witnessHashes.get(value as Block),
      reference = hash && refs.get(hash);
    return reference ? { ...(value as Block), reference } : value;
  };
  for (const block of blocks) {
    if (block.witness) block.witness = resolve(block.witness);
    if (Array.isArray(block.witnesses))
      block.witnesses = block.witnesses.map((pair) => ({
        ...pair,
        witness: resolve(pair.witness),
      }));
  }
}
