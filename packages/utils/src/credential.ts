import {
  Address,
  Network,
  Credential,
  ScriptHash,
  KeyHash,
  RewardAddress,
} from "@lucid-evolution/core-types";
import { networkToId } from "./network.js";
import { ledger } from "@lucid-evolution/ledger";
import { getAddressDetails } from "./address.js";
import { toHex } from "@lucid-evolution/core-utils";
import { bech32 } from "@scure/base";

export function credentialToAddress(
  network: Network,
  paymentCredential: Credential,
  stakeCredential?: Credential,
): Address {
  return ledger("address.fromCredentials", {
    network: networkToId(network),
    payment: paymentCredential,
    stake: stakeCredential,
  });
}

export function scriptHashToCredential(scriptHash: ScriptHash): Credential {
  return {
    type: "Script",
    hash: scriptHash,
  };
}

export function keyHashToCredential(keyHash: KeyHash): Credential {
  return {
    type: "Key",
    hash: keyHash,
  };
}

export function paymentCredentialOf(address: Address): Credential {
  const { paymentCredential } = getAddressDetails(address);
  if (!paymentCredential) {
    throw new Error(
      "The specified address does not contain a payment credential.",
    );
  }
  return paymentCredential;
}

export function stakeCredentialOf(rewardAddress: RewardAddress): Credential {
  const { stakeCredential } = getAddressDetails(rewardAddress);
  if (!stakeCredential) {
    throw new Error(
      "The specified address does not contain a stake credential.",
    );
  }
  return stakeCredential;
}

/**
 * Accepts CIP-105 IDs (`drep` or `drep_script` and the bare hash) and CIP-129
 * IDs (`drep`, a header byte and the hash). A CIP-129 header must identify
 * a DRep key hash (`0x22`) or script hash (`0x23`).
 *
 * @example
 * import { drepIDToCredential } from "@lucid-evolution/utils";
 *
 * drepIDToCredential("drep1y2sm9s75uhmqwxpf8f94cmt737g2rvkr6njlvpcc9yaykhq23nmjy");
 * // { type: "Key", hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c" }
 *
 * @since 0.1.65
 * @category Credentials
 */
export const drepIDToCredential = (drepID: string): Credential => {
  const decoded = bech32.decodeUnsafe(drepID, 1023);
  if (!decoded) throw new Error(`Invalid DRep ID: ${drepID}`);
  const { prefix, words } = decoded;
  const isValid =
    (prefix === "drep" && (words.length === 47 || words.length === 45)) ||
    (prefix === "drep_script" && words.length === 45);
  if (!isValid) throw new Error(`Invalid DRep ID: ${drepID}`);

  const payload = bech32.fromWords(words);
  if (payload.length === 28) {
    return {
      type: drepID.includes("drep_script") ? "Script" : "Key",
      hash: toHex(payload),
    };
  }
  const header = payload[0];
  if (header !== 0x22 && header !== 0x23) {
    throw new Error(
      `Invalid DRep ID: ${drepID}, header 0x${header.toString(16).padStart(2, "0")} is neither a DRep key hash (0x22) nor a script hash (0x23)`,
    );
  }
  return {
    type: header === 0x23 ? "Script" : "Key",
    hash: toHex(payload.subarray(1)),
  };
};

export function poolIdToHex(poolId: string): string {
  if (/^[a-fA-F0-9]{56}$/.test(poolId)) return poolId.toLowerCase();
  const { prefix, words } = bech32.decode(
    poolId as `${string}1${string}`,
    1023,
  );
  const bytes = bech32.fromWords(words);
  if (prefix !== "pool" || bytes.length !== 28)
    throw new Error("Invalid pool ID");
  return toHex(bytes);
}

export function hashToBech32(prefix: string, hash: string): string {
  if (!/^[a-fA-F0-9]{56}$/.test(hash))
    throw new Error("Invalid credential hash");
  const bytes = Uint8Array.from(hash.match(/../g)!, (b) => parseInt(b, 16));
  return bech32.encode(prefix, bech32.toWords(bytes), 1023);
}

export const poolIdFromHex = (hash: string): string =>
  hashToBech32("pool", hash);
