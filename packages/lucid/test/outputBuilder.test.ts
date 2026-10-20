import { expect, test } from "vitest";
import {
  applyDoubleCborEncoding,
  coreToTxOutput,
  utxoToTransactionOutput,
} from "@lucid-evolution/utils";
import type { TxOutput, Script } from "@lucid-evolution/core-types";

const address =
  "addr1q98wl3hnya9l94rt58ky533deyqe9t8zz5n9su26k8e5g23yar4q0adtaax9q9g0kphpv2ws7vxqwu6ln6pqx7j29nfqsfy9mg";
const scriptRef: Script = { type: "PlutusV3", script: "450100002499" };
const datum = "d8799f44deadbeefff";
// Original output fixtures retain address, value, datum bytes, and script identity.
const fixtures = [
  "825839014eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442a24e8ea07f5abef4c50150fb06e1629d0f30c07735f9e82037a4a2cd20a",
  "a3005839014eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442a24e8ea07f5abef4c50150fb06e1629d0f30c07735f9e82037a4a2cd2010a028201d81849d8799f44deadbeefff",
  "a3005839014eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442a24e8ea07f5abef4c50150fb06e1629d0f30c07735f9e82037a4a2cd2010a03d81849820346450100002499",
  "a4005839014eefc6f3274bf2d46ba1ec4a462dc90192ace2152658715ab1f3442a24e8ea07f5abef4c50150fb06e1629d0f30c07735f9e82037a4a2cd2010a028201d81849d8799f44deadbeefff03d81849820346450100002499",
];

test.each([{}, { datum }, { scriptRef }, { datum, scriptRef }])(
  "Haskell output roundtrip retains %j",
  (extra) => {
    const output: TxOutput = { address, assets: { lovelace: 10n }, ...extra };
    const index = (extra.datum ? 1 : 0) + (extra.scriptRef ? 2 : 0);
    const expected = coreToTxOutput(fixtures[index]);
    expect(coreToTxOutput(utxoToTransactionOutput(output))).toEqual(expected);
    expect(expected.address).toBe(address);
    expect(expected.assets).toEqual({ lovelace: 10n });
    expect(expected.datum).toBe(extra.datum);
    expect(expected.scriptRef).toEqual(
      extra.scriptRef
        ? {
            ...extra.scriptRef,
            script: applyDoubleCborEncoding(extra.scriptRef.script),
          }
        : undefined,
    );
  },
);
