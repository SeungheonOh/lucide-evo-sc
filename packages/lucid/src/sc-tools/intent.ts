import type { Assets, Script, UTxO } from "@lucid-evolution/core-types";
import { withCMLScope } from "@lucid-evolution/core-utils";
import {
  coreToTxOutput,
  paymentCredentialOf,
  applyDoubleCborEncoding,
  validatorToScriptHash,
} from "@lucid-evolution/utils";
import { CML } from "../core.js";
import { ERROR_MESSAGE } from "../Errors.js";
import type { TxBuilderConfig } from "../tx-builder/TxBuilder.js";

type Block = Record<string, unknown>;
const witnessHashes = new WeakMap<Block, string>();
const intents = new WeakMap<TxBuilderConfig, Block[]>();
export const scBlocks = (config: TxBuilderConfig): Block[] =>
  intents.get(config) ?? [];
export function recordScBlock(config: TxBuilderConfig, block: Block): void {
  if (!config.lucidConfig.balancer) return;
  if (!intents.has(config)) intents.set(config, []);
  intents.get(config)!.push(block);
}
export const scOutRef = (utxo: UTxO): string =>
  `${utxo.txHash}#${utxo.outputIndex}`;
export function recordScValidity(
  config: TxBuilderConfig,
  bound: "from" | "until",
  slot: number,
): void {
  if (!config.lucidConfig.balancer) return;
  let block = scBlocks(config).find((block) => block.type === "validity");
  if (!block) {
    block = { type: "validity" };
    recordScBlock(config, block);
  }
  block[bound] = String(slot);
}
export function scScript(script: Script): Block {
  return script.type === "Native"
    ? { language: "Native", nativeScriptCbor: script.script }
    : {
        language: script.type,
        scriptCbor: applyDoubleCborEncoding(script.script),
      };
}
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
  if (!config.lucidConfig.balancer) return;
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
  output: CML.TransactionOutput,
  result: CML.SingleOutputBuilderResult,
): void {
  if (!config.lucidConfig.balancer) return;
  withCMLScope((own) => {
    const out = coreToTxOutput(output);
    const communication = own(result.communication_datum());
    recordScBlock(config, {
      type: "output",
      output: {
        address: out.address,
        lovelace: String(out.assets.lovelace ?? 0n),
        assets: scAssets(out.assets),
        ...(communication
          ? { datumMode: "embedded", datumCbor: communication.to_cbor_hex() }
          : out.datumHash
            ? { datumMode: "hash", datumHash: out.datumHash }
            : out.datum
              ? { datumMode: "inline", datumCbor: out.datum }
              : {}),
        ...(out.scriptRef ? { referenceScript: scScript(out.scriptRef) } : {}),
      },
    });
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
  if (!config.lucidConfig.balancer) return;
  const tokens = scAssets(assets);
  const policyId = tokens[0].policyId;
  recordScBlock(config, {
    type: "mint",
    policyId,
    assets: tokens,
    witness: scWitness(config, policyId, redeemer),
  });
}

/** Record ledger certificate CBOR before handing the same value to CML. */
export function scCertificateBuilder(
  config: TxBuilderConfig,
  redeemer: string | undefined,
  certificate: CML.Certificate,
): CML.SingleCertificateBuilder {
  if (config.lucidConfig.balancer) {
    // JSON is used only for credential hashes; amounts remain in the original CBOR.
    const decoded = JSON.parse(certificate.to_json()) as Record<
      string,
      Record<string, { PubKey?: { hash: string }; Script?: { hash: string } }>
    >;
    const kind = Object.keys(decoded)[0];
    const fields = decoded[kind];
    const credential =
      fields.stake_credential ??
      fields.drep_credential ??
      fields.committee_cold_credential;
    const needsWitness = kind !== "StakeRegistration";
    recordScBlock(config, {
      type: "certificate",
      kind: "raw",
      cbor: certificate.to_cbor_hex(),
      ...(credential && needsWitness
        ? {
            credential: credential.PubKey?.hash ?? credential.Script?.hash,
            ...(credential.Script
              ? { witness: scWitness(config, credential.Script.hash, redeemer) }
              : {}),
          }
        : {}),
    });
  }
  return CML.SingleCertificateBuilder.new(certificate);
}

const votes = new WeakMap<
  TxBuilderConfig,
  Map<string, { procedures: Map<string, string>; witness?: Block }>
>();
const mapHeader = (size: number): string =>
  size < 24
    ? (0xa0 + size).toString(16)
    : size < 256
      ? "b8" + size.toString(16).padStart(2, "0")
      : "b9" + size.toString(16).padStart(4, "0");
export function recordScVote(
  config: TxBuilderConfig,
  voter: CML.Voter,
  action: CML.GovActionId,
  procedure: CML.VotingProcedure,
  credential?: import("@lucid-evolution/core-types").Credential,
  redeemer?: string,
): void {
  if (!config.lucidConfig.balancer) return;
  if (!votes.has(config)) votes.set(config, new Map());
  const entries = votes.get(config)!;
  const key = voter.to_cbor_hex();
  const entry = entries.get(key) ?? { procedures: new Map<string, string>() };
  entry.procedures.set(action.to_cbor_hex(), procedure.to_cbor_hex());
  if (credential?.type === "Script")
    entry.witness = scWitness(config, credential.hash, redeemer);
  entries.set(key, entry);
  let block = scBlocks(config).find((b) => b.type === "vote");
  if (!block) {
    block = { type: "vote" };
    recordScBlock(config, block);
  }
  block.cbor =
    mapHeader(entries.size) +
    [...entries]
      .map(
        ([voter, entry]) =>
          voter +
          mapHeader(entry.procedures.size) +
          [...entry.procedures]
            .map(([action, procedure]) => action + procedure)
            .join(""),
      )
      .join("");
  block.witnesses = [...entries]
    .filter(([, e]) => e.witness)
    .map(([voterCbor, e]) => ({ voterCbor, witness: e.witness }));
}

export function resolveScReferences(
  config: TxBuilderConfig,
  blocks: Block[],
): void {
  const refs = new Map(
    config.readInputs
      .filter((u) => u.scriptRef)
      .map((u) => [validatorToScriptHash(u.scriptRef!), scOutRef(u)]),
  );
  const resolve = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const witness = value as Block;
    const hash = witnessHashes.get(witness);
    const reference = hash && refs.get(hash);
    return reference ? { ...witness, reference } : value;
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
