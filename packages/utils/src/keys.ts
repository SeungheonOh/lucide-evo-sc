import type { PrivateKey, PublicKey } from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
import { generateMnemonic } from "@scure/bip39";

import { wordlist } from "@scure/bip39/wordlists/english";

export function generatePrivateKey(): PrivateKey {
  return ledger("key.generate", {});
}
export function generateSeedPhrase(): string {
  return generateMnemonic(wordlist, 256);
}
export function toPublicKey(privateKey: PrivateKey): PublicKey {
  return ledger<{ publicKey: string }>("key.fromPrivate", { privateKey })
    .publicKey;
}
