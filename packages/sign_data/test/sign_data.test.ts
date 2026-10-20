import { describe, expect, test } from "vitest";
import { signData, verifyData } from "../src/sign_data.js";
import {
  decodeCbor,
  encodeCbor,
  type CborValue,
} from "@lucid-evolution/ledger";

const privateKey =
  "ed25519e_sk1krszcw3ujfs3qnsjwl6wynw7dwudgnq69w9lrrtdf46yqnd25dgv4f5ttaqxr2v6n6azee489c7mryudvhu8n4x4tcvd5hvhtwswsuc4s4c2d";
const address = "614eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442a";
const keyHash = address.slice(2);
const payload = "48656c6c6f";
const signed = {
  signature:
    "84582aa201276761646472657373581d614eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442aa166686173686564f44548656c6c6f58409e1fdc06d6daa557f80fc3b755f1b6f12754d32461a68de19c359ac58601c9858781d4919a4c8c23287f0ba5eb33cddddf9a51ce057c64ed00a3431719f36f0a",
  key: "a40101032720062158202fb9f0602d041e550ebb8bc5050241b9f42aa585ad911d9017a8be6a0a878170",
};

describe("CIP-8 messages", () => {
  test("preserves the recorded Lucid signature and key encoding", () => {
    expect(signData(address, payload, privateKey)).toEqual(signed);
    expect(verifyData(address, keyHash, payload, signed)).toBe(true);
  });
  test("rejects a changed address, payload, key hash, or signature", () => {
    expect(verifyData("60" + address.slice(2), keyHash, payload, signed)).toBe(
      false,
    );
    expect(verifyData(address, keyHash, "00", signed)).toBe(false);
    expect(verifyData(address, "00".repeat(28), payload, signed)).toBe(false);
    expect(
      verifyData(address, keyHash, payload, {
        ...signed,
        signature: signed.signature.slice(0, -2) + "00",
      }),
    ).toBe(false);
  });
  test("rejects a COSE key with a different algorithm", () => {
    const key = decodeCbor(signed.key) as Map<CborValue, CborValue>;
    key.set(3n, -7n);
    expect(
      verifyData(address, keyHash, payload, {
        ...signed,
        key: encodeCbor(key),
      }),
    ).toBe(false);
  });
});
