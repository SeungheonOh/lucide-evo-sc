import { expect, test } from "vitest";
import {
  CborTag,
  encodeCbor,
  hexToBytes,
  type CborValue,
} from "@lucid-evolution/ledger";
import { discoverOwnUsedTxKeyHashes } from "../src/index.js";

const author = "12".repeat(28);
const target = "34".repeat(28);
const authorCredential: CborValue = [0n, hexToBytes(author)];
const targetCredential: CborValue = [0n, hexToBytes(target)];

function certificateTransaction(certificate: CborValue): string {
  return encodeCbor([
    new Map<CborValue, CborValue>([
      [0n, new CborTag(258n, [])],
      [1n, []],
      [2n, 0n],
      [4n, new CborTag(258n, [certificate])],
    ]),
    new Map(),
    true,
    null,
  ]);
}

test.each<{ name: string; certificate: CborValue; expected: string[] }>([
  {
    name: "legacy stake registration needs no credential signature",
    certificate: [0n, authorCredential],
    expected: [],
  },
  {
    name: "stake delegation signs with the delegator, not the target pool",
    certificate: [2n, authorCredential, hexToBytes(target)],
    expected: [author],
  },
  {
    name: "vote delegation signs with the delegator, not the target DRep",
    certificate: [9n, authorCredential, targetCredential],
    expected: [author],
  },
  {
    name: "committee hot-key authorization needs the cold credential",
    certificate: [14n, authorCredential, targetCredential],
    expected: [author],
  },
])("$name", ({ certificate, expected }) => {
  expect(
    discoverOwnUsedTxKeyHashes(
      certificateTransaction(certificate),
      [author, target],
      [],
    ),
  ).toEqual(expected);
});
