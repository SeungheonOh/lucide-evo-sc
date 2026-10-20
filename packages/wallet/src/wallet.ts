import type {
  Address,
  KeyHash,
  Network,
  PrivateKey,
  RewardAddress,
  Transaction,
  UTxO,
} from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
import { mnemonicToEntropy } from "@scure/bip39";

import { wordlist } from "@scure/bip39/wordlists/english";
import { toHex } from "@lucid-evolution/core-utils";

export type FromSeed = {
  address: Address;
  rewardAddress: RewardAddress | null;
  paymentKey: PrivateKey;
  stakeKey: PrivateKey | null;
};

export function walletFromSeed(
  seed: string,
  options: {
    password?: string;
    addressType?: "Base" | "Enterprise";
    accountIndex?: number;
    network?: Network;
  } = {},
): FromSeed {
  return ledger("key.fromSeed", {
    entropy: toHex(mnemonicToEntropy(seed, wordlist)),
    password: options.password ?? "",
    addressType: options.addressType ?? "Base",
    accountIndex: options.accountIndex ?? 0,
    network: (options.network ?? "Mainnet") === "Mainnet" ? 1 : 0,
  });
}

export function discoverOwnUsedTxKeyHashes(
  tx: Transaction,
  ownKeyHashes: KeyHash[],
  ownUtxos: UTxO[],
): KeyHash[] {
  const required = ledger<string[]>("tx.requiredKeys", {
    cbor: tx,
    utxos: ownUtxos,
  });
  const own = new Set(ownKeyHashes);
  return [...new Set(required)].filter((hash) => own.has(hash));
}
