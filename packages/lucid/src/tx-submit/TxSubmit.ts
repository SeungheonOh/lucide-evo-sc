import * as Effect from "effect/Effect";
import { makeReturn } from "../core.js";
import {
  transactionJson,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { Wallet } from "@lucid-evolution/core-types";
import { Either } from "effect/Either";
import { TxSubmitError } from "../Errors.js";
import { canonicalTransactionHex } from "../CanonicalTransaction.js";
import { CBORHex, Hash } from "../tx-builder/types.js";

export interface TxSigned {
  /** Submits the transaction and returns the transaction hash.
   *
   * Supports both canonical and non-canonical formats.
   *
   * Canonical export normalizes uncommitted CBOR while preserving hashed payloads.
   * Transactions with existing signatures retain their original bytes. To produce
   * a canonical body, use `.complete({ canonical: true })` before signing.
   *
   * Non-canonical format example:
   * ```typescript
   * .submit();
   * ```
   * Canonical format example:
   * ```typescript
   * .submit({ canonical: true });
   * ```
   */
  submit: (options?: { canonical: boolean }) => Promise<string>;

  /** Submits the transaction and returns the transaction hash or error as an effect.
   *
   * Supports both canonical and non-canonical formats.
   *
   * Canonical export normalizes uncommitted CBOR while preserving hashed payloads.
   * Transactions with existing signatures retain their original bytes. To produce
   * a canonical body, use `.complete({ canonical: true })` before signing.
   *
   * Non-canonical format example:
   * ```typescript
   * .submitProgram();
   * ```
   * Canonical format example:
   * ```typescript
   * .submitProgram({ canonical: true });
   * ```
   */
  submitProgram: (options?: {
    canonical: boolean;
  }) => Effect.Effect<string, TxSubmitError, never>;

  /** Safely submits the transaction, returning the transaction hash or an error as promise either type.
   *
   * Supports both canonical and non-canonical formats.
   *
   * Canonical export normalizes uncommitted CBOR while preserving hashed payloads.
   * Transactions with existing signatures retain their original bytes. To produce
   * a canonical body, use `.complete({ canonical: true })` before signing.
   *
   * Non-canonical format example:
   * ```typescript
   * .submitSafe();
   * ```
   * Canonical format example:
   * ```typescript
   * .submitSafe({ canonical: true });
   * ```
   */
  submitSafe: (options?: {
    canonical: boolean;
  }) => Promise<Either<string, TxSubmitError>>;

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
  /** Converts the transaction (transaction body and witnesses) to JSON format. */
  toJSON: () => object;
  /** Computes the hash of the transaction. */
  toHash: () => Hash;
}
export const makeSubmit = (
  wallet: Wallet,
  txSigned: TransactionSnapshot,
): TxSigned => {
  const submit = (options: { canonical: boolean }) =>
    Effect.tryPromise({
      try: () =>
        wallet.submitTx(
          options.canonical ? canonicalTransactionHex(txSigned) : txSigned.cbor,
        ),
      catch: (cause) => new TxSubmitError({ cause }),
    });
  return {
    submit: (options = { canonical: false }) =>
      makeReturn(submit(options)).unsafeRun(),
    submitProgram: (options = { canonical: false }) => submit(options),
    submitSafe: (options = { canonical: false }) =>
      makeReturn(submit(options)).safeRun(),
    toCBOR: (options = { canonical: false }) =>
      options.canonical ? canonicalTransactionHex(txSigned) : txSigned.cbor,
    toTransaction: () => txSigned,
    toJSON: () => transactionJson(txSigned),
    toHash: () => txSigned.hash,
  };
};
