import { fromHex, toHex } from "@lucid-evolution/core-utils";
import type {
  KeyHash,
  Payload,
  PrivateKey,
  SignedMessage,
} from "@lucid-evolution/core-types";
import {
  ledger,
  encodeCbor,
  decodeCbor,
  CborTag,
  type CborValue,
} from "@lucid-evolution/ledger";

export function signData(
  addressHex: string,
  payload: Payload,
  privateKey: PrivateKey,
): SignedMessage {
  const headers = fromHex(
    encodeCbor(
      new Map<CborValue, CborValue>([
        [1n, -8n],
        ["address", fromHex(addressHex)],
      ]),
    ),
  );
  const bytes = fromHex(payload);
  const message = encodeCbor(["Signature1", headers, new Uint8Array(), bytes]);
  const signature = ledger<string>("key.sign", { privateKey, message });
  const { publicKeyHex } = ledger<{ publicKeyHex: string }>("key.fromPrivate", {
    privateKey,
  });
  return {
    signature: encodeCbor([
      headers,
      new Map<CborValue, CborValue>([["hashed", false]]),
      bytes,
      fromHex(signature),
    ]),
    key: encodeCbor(
      new Map<CborValue, CborValue>([
        [1n, 1n],
        [3n, -8n],
        [-1n, 6n],
        [-2n, fromHex(publicKeyHex)],
      ]),
    ),
  };
}

const map = (value: CborValue): Map<CborValue, CborValue> => {
  if (!(value instanceof Map)) throw new Error("Expected a COSE map");
  return value;
};
const bytes = (value: CborValue | undefined): Uint8Array => {
  if (!(value instanceof Uint8Array))
    throw new Error("Expected a COSE byte string");
  return value;
};

export function verifyData(
  addressHex: string,
  keyHash: KeyHash,
  payload: Payload,
  signedMessage: SignedMessage,
): boolean {
  let envelope = decodeCbor(signedMessage.signature);
  if (envelope instanceof CborTag) envelope = envelope.value;
  if (!Array.isArray(envelope) || envelope.length !== 4)
    throw new Error("Invalid COSE Sign1");
  const [protectedBytes, , payloadBytes, signature] = envelope;
  const headers = map(decodeCbor(toHex(bytes(protectedBytes))));
  const key = map(decodeCbor(signedMessage.key));
  const publicKey = toHex(bytes(key.get(-2n)));
  if (
    toHex(bytes(headers.get("address"))) !== addressHex ||
    toHex(bytes(payloadBytes)) !== payload
  )
    return false;
  if (
    headers.get(1n) !== -8n ||
    key.get(3n) !== -8n ||
    key.get(-1n) !== 6n ||
    key.get(1n) !== 1n
  )
    return false;
  if (ledger<string>("key.hash", { publicKey }) !== keyHash) return false;
  const message = encodeCbor([
    "Signature1",
    bytes(protectedBytes),
    new Uint8Array(),
    bytes(payloadBytes),
  ]);
  return ledger("key.verify", {
    publicKey,
    message,
    signature: toHex(bytes(signature)),
  });
}
