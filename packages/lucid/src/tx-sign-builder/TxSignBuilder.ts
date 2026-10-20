import { makeReturn } from "../core.js";
import {
  inspectTransaction,
  transactionJson,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import * as Effect from "effect/Effect";
//TODO: move to commont utils
import {
  PrivateKey,
  SlotConfig,
  TransactionWitnesses,
  UTxO,
  Wallet,
} from "@lucid-evolution/core-types";
import { TransactionSignError } from "../Errors.js";
import { canonicalTransactionHex } from "../CanonicalTransaction.js";
import { TxSigned } from "../tx-submit/TxSubmit.js";
import * as CompleteTxSigner from "./internal/CompleteTxSigner.js";
import { Either } from "effect/Either";
import * as Sign from "./internal/Sign.js";
import { CBORHex, Hash } from "../tx-builder/types.js";
import {
  makeScriptContext,
  makeScriptContexts,
  ScriptContextData,
  ScriptContextOptions,
  ScriptPurposeData,
} from "../script-context/index.js";

export interface TxSignBuilderConfig {
  txComplete: TransactionSnapshot;
  witnessSets: string[];
  programs: Effect.Effect<void, TransactionSignError, never>[];
  wallet: Wallet | undefined;
  fee: number;
  exUnits: { cpu: number; mem: number } | null;
  resolvedInputs: ReadonlyArray<UTxO>;
  slotConfig: SlotConfig | undefined;
}

export interface TxSignBuilder {
  sign: {
    /** Signs the transaction with a wallet. */
    withWallet: () => TxSignBuilder;
    /** Signs the transaction with a private key. */
    withPrivateKey: (privateKey: PrivateKey) => TxSignBuilder;
  };
  partialSign: {
    /** Partially signs the transaction with a wallet. */
    withWallet: () => Promise<TransactionWitnesses>;
    /** Partially signs the transaction with a wallet and returns an effect. */
    withWalletEffect: () => Effect.Effect<
      TransactionWitnesses,
      TransactionSignError
    >;
    /** Safely partially signs the transaction with a wallet. */
    withWalletSafe: () => Promise<
      Either<TransactionWitnesses, TransactionSignError>
    >;
    /** Partially signs the transaction with a private key. */
    withPrivateKey: (privateKey: PrivateKey) => Promise<TransactionWitnesses>;
    /** Partially signs the transaction with a private key and returns an effect. */
    withPrivateKeyEffect: (
      privateKey: PrivateKey,
    ) => Effect.Effect<TransactionWitnesses, TransactionSignError>;
    /** Safely partially signs the transaction with a private key. */
    withPrivateKeySafe: (
      privateKey: PrivateKey,
    ) => Promise<Either<TransactionWitnesses, TransactionSignError>>;
  };
  /** Assembles the transaction with the given witnesses.  */
  assemble: (witnesses: TransactionWitnesses[]) => TxSignBuilder;
  /**
   * Converts the transaction to CBOR (Concise Binary Object Representation) format.
   *
   * Supports both canonical and non-canonical formats.
   *
   * Canonical export normalizes uncommitted CBOR while preserving hashed payloads.
   * Transactions with existing signatures retain their original bytes. To produce
   * a canonical body, use `.complete({ canonical: true })` before signing.
   *
   * Non-canonical format example:
   * ```typescript
   * .toCBOR();
   * ```
   * Canonical format example:
   * ```typescript
   * .toCBOR({ canonical: true });
   * ```
   */
  toCBOR: (options?: { canonical: boolean }) => CBORHex;
  toTransaction: () => TransactionSnapshot;
  /** Builds the Plutus V3 ScriptContext for one script purpose in this transaction. */
  toScriptContext: (
    purpose: ScriptPurposeData,
    options?: ScriptContextOptions,
  ) => ScriptContextData;
  /** Builds Plutus V3 ScriptContexts for every redeemer-bearing script purpose. */
  toScriptContexts: (options?: ScriptContextOptions) => ScriptContextData[];
  /** Converts the transaction body to JSON format. */
  toJSON: () => object;
  /** Computes the hash of the transaction body. */
  toHash: () => Hash;
  complete: () => Promise<TxSigned>;
  /** Completes the transaction and returns an effect. */
  completeProgram: () => Effect.Effect<TxSigned, TransactionSignError, never>;
  /** Safely completes the transaction. */
  completeSafe: () => Promise<Either<TxSigned, TransactionSignError>>;
}

export const makeTxSignBuilder = (
  wallet: Wallet | undefined,
  transaction: TransactionSnapshot | string,
  options: {
    resolvedInputs?: ReadonlyArray<UTxO>;
    slotConfig?: SlotConfig;
  } = {},
): TxSignBuilder => {
  const tx =
    typeof transaction === "string"
      ? inspectTransaction(transaction)
      : transaction;
  const exUnits = tx.redeemers.reduce(
    (total, redeemer) => ({
      cpu: total.cpu + Number(redeemer.exUnits.steps),
      mem: total.mem + Number(redeemer.exUnits.mem),
    }),
    { cpu: 0, mem: 0 },
  );
  const config: TxSignBuilderConfig = {
    txComplete: tx,
    witnessSets: [],
    programs: [],
    wallet: wallet,
    fee: Number(tx.body.fee),
    exUnits: exUnits,
    resolvedInputs: options.resolvedInputs ?? [],
    slotConfig: options.slotConfig,
  };

  const scriptContextOptions = (
    overrides: ScriptContextOptions = {},
  ): ScriptContextOptions => ({
    resolvedInputs: overrides.resolvedInputs ?? config.resolvedInputs,
    slotConfig: overrides.slotConfig ?? config.slotConfig,
  });

  const txSignBuilder: TxSignBuilder = {
    sign: {
      withWallet: () => {
        const program = Sign.withWallet(config);
        config.programs.push(program);
        return txSignBuilder;
      },
      withPrivateKey: (privateKey: PrivateKey) => {
        const program = Sign.withPrivateKey(config, privateKey);
        config.programs.push(program);
        return txSignBuilder;
      },
    },
    partialSign: {
      withWallet: () => makeReturn(Sign.partialWithWallet(config)).unsafeRun(),
      withWalletEffect: () => Sign.partialWithWallet(config),
      withWalletSafe: () =>
        makeReturn(Sign.partialWithWallet(config)).safeRun(),
      withPrivateKey: (privateKey: PrivateKey) =>
        makeReturn(Sign.partialWithPrivateKey(config, privateKey)).unsafeRun(),
      withPrivateKeyEffect: (privateKey: PrivateKey) =>
        Sign.partialWithPrivateKey(config, privateKey),
      withPrivateKeySafe: (privateKey: PrivateKey) =>
        makeReturn(Sign.partialWithPrivateKey(config, privateKey)).safeRun(),
    },
    assemble: (witnesses: TransactionWitnesses[]) => {
      const program = Sign.assemble(config, witnesses);
      config.programs.push(program);
      return txSignBuilder;
    },
    toCBOR: (options = { canonical: false }) =>
      options.canonical
        ? canonicalTransactionHex(config.txComplete)
        : config.txComplete.cbor,
    toTransaction: () => config.txComplete,
    toScriptContext: (purpose, options) =>
      makeScriptContext(
        config.txComplete,
        purpose,
        scriptContextOptions(options),
      ),
    toScriptContexts: (options) =>
      makeScriptContexts(config.txComplete, scriptContextOptions(options)),
    toJSON: () => transactionJson(config.txComplete),
    toHash: () => config.txComplete.hash,
    complete: () =>
      makeReturn(CompleteTxSigner.completeTxSigner(config)).unsafeRun(),
    completeProgram: () => CompleteTxSigner.completeTxSigner(config),
    completeSafe: () =>
      makeReturn(CompleteTxSigner.completeTxSigner(config)).safeRun(),
  };
  return txSignBuilder;
};
