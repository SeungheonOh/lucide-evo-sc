import {
  canonicalTransactionCbor,
  inspectTransaction,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";

/**
 * Normalizes unsigned ledger containers while retaining hash-committed bytes.
 * Datum values and native scripts keep their original encodings. Redeemers and
 * auxiliary data are also preserved when body hashes commit to them; otherwise
 * redeemers normalize only when their ordered Plutus value stays unchanged.
 * Signed transactions are returned unchanged. Protected regions can therefore
 * contain noncanonical CBOR, and an unsigned body's hash can change.
 */
export const canonicalTransactionHex = (
  transaction: TransactionSnapshot | string,
): string => canonicalTransactionCbor(transaction);

/** Returns the inspected form of {@link canonicalTransactionHex}. */
export const canonicalTransaction = (
  transaction: TransactionSnapshot | string,
): TransactionSnapshot =>
  inspectTransaction(canonicalTransactionCbor(transaction));
