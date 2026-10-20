import {
  inspectTransaction,
  encodeCbor,
  decodeCbor,
  ledger,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { describe, expect, test } from "vitest";
import {
  datumToHash,
  getAddressDetails,
  calculateMinLovelaceFromUTxO,
  fromHex,
  Emulator,
  generateEmulatorAccount,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  RedeemerContext,
  validatorToAddress,
} from "../src/index.js";
import { canonicalTransaction } from "../src/CanonicalTransaction.js";
import { alwaysSucceedV3Script } from "./fixtures/scripts.js";

// {h'616c706861': 5, h'62657461': 7}: "alpha" precedes "beta", but canonical
// CBOR sorts shorter keys first and would put "beta" first.
const tokenMap = "a245616c70686105446265746107";
const datum = `d8799f${tokenMap}9f${tokenMap}ffff`;
const redeemerData = `d87a9f${tokenMap}ff`;

const datumHash = datumToHash;

type DataView = {
  inlineDatums: string[];
  witnessDatums: string[];
  redeemerData: string[];
  redeemerExUnits: { mem: bigint; steps: bigint }[];
};

const plutusDataOf = (tx: TransactionSnapshot): DataView => ({
  inlineDatums: tx.body.outputs.flatMap((output) =>
    output.datum ? [output.datum] : [],
  ),
  witnessDatums: tx.datums?.map((datum) => datum.cbor) ?? [],
  redeemerData: tx.redeemers.map((redeemer) => redeemer.data),
  redeemerExUnits: tx.redeemers.map((redeemer) => redeemer.exUnits),
});

const expectOriginalPlutusData = (tx: TransactionSnapshot): void => {
  const view = plutusDataOf(tx);
  expect(view.inlineDatums).toEqual([datum]);
  expect(view.witnessDatums).toEqual([datum]);
  expect(view.redeemerData).toEqual([redeemerData, redeemerData]);
  for (const exUnits of view.redeemerExUnits) {
    expect(exUnits.mem).toBeGreaterThan(0n);
    expect(exUnits.steps).toBeGreaterThan(0n);
  }
  const auxiliaryData = tx.auxiliaryData;
  expect(auxiliaryData).toBeDefined();
  expect(
    ledger("hash.blake2b", { hex: encodeCbor(auxiliaryData!), size: 32 }),
  ).toBe(tx.body.auxiliaryDataHash);
};

test("the fixture's Plutus maps are not in canonical order", () => {
  const canonical = encodeCbor(decodeCbor(datum), true);
  expect(canonical).not.toBe(datum);
  expect(datumHash(canonical)).not.toBe(datumHash(datum));
});

describe.each(["static", "canonical", "delayed"] as const)(
  "%s completion keeps ordered Plutus data",
  (mode) => {
    test("inline datums, witness datums and redeemer data survive completion and canonical serialization", async () => {
      const account = generateEmulatorAccount({ lovelace: 1_000_000_000n });
      const emulator = new Emulator([account], PROTOCOL_PARAMETERS_DEFAULT);
      const lucid = await Lucid(emulator, "Custom");
      lucid.selectWallet.fromSeed(account.seedPhrase);
      const address = await lucid.wallet().address();
      const scriptAddress = validatorToAddress("Custom", alwaysSucceedV3Script);

      const setup = await lucid
        .newTx()
        .pay.ToContract(
          scriptAddress,
          { kind: "inline", value: datum },
          { lovelace: 20_000_000n },
        )
        .pay.ToContract(
          scriptAddress,
          { kind: "asHash", value: datum },
          { lovelace: 20_000_000n },
        )
        .pay.ToAddressWithData(
          address,
          { kind: "inline", value: datum },
          { lovelace: 2_000_000n },
        )
        .complete();
      await lucid.awaitTx(
        await (await setup.sign.withWallet().complete()).submit(),
      );

      const scriptUtxos = await lucid.utxosAt(scriptAddress);
      const inlineInput = scriptUtxos.find((utxo) => utxo.datum != null)!;
      const hashInput = scriptUtxos.find((utxo) => utxo.datumHash != null)!;
      const reference = (await lucid.utxosAt(address)).find(
        (utxo) => utxo.datum != null,
      )!;
      expect(inlineInput.datum).toBe(datum);
      expect(reference.datum).toBe(datum);
      expect(hashInput.datumHash).toBe(datumHash(datum));

      let callbacks = 0;
      const redeemer =
        mode === "delayed"
          ? (context: RedeemerContext) => {
              callbacks++;
              const output = context.outputs.find(
                (output) => output.datum != null,
              );
              // Delayed redeemers see the datum the transaction will carry.
              expect(output?.datum).toBe(datum);
              return redeemerData;
            }
          : redeemerData;
      const completed = await lucid
        .newTx()
        .collectFrom([inlineInput], redeemer)
        .collectFrom([{ ...hashInput, datum }], redeemer)
        .readFrom([reference])
        .attach.SpendingValidator(alwaysSucceedV3Script)
        .attachMetadata(674, { msg: ["ordered Plutus data"] })
        // Below the minimum, so the builder tops the output up to min ADA.
        .pay.ToAddressWithData(
          address,
          { kind: "inline", value: datum },
          { lovelace: 1n },
        )
        .complete({ canonical: mode === "canonical" });
      expect(callbacks > 0).toBe(mode === "delayed");

      const signed = await completed.sign.withWallet().complete();
      const completedTx = completed.toTransaction();
      const signedTx = inspectTransaction(signed.toCBOR());
      const canonicalCompletedTx = inspectTransaction(
        completed.toCBOR({ canonical: true }),
      );
      const canonicalSignedTx = inspectTransaction(
        signed.toCBOR({ canonical: true }),
      );
      for (const tx of [
        completedTx,
        signedTx,
        canonicalCompletedTx,
        canonicalSignedTx,
      ]) {
        expectOriginalPlutusData(tx);
      }

      // Canonical and delayed completion already produce a canonical body,
      // so serializing canonically again must not change its hash.
      const canonicalSubmission = mode !== "static";
      if (canonicalSubmission) {
        for (const tx of [canonicalCompletedTx, canonicalSignedTx]) {
          expect(tx.hash).toBe(completed.toHash());
        }
      }

      const outputs = completedTx.body.outputs;
      const outputIndex = outputs.findIndex(
        (output) => output.datum !== undefined,
      );
      const minimumAda = calculateMinLovelaceFromUTxO(
        PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte,
        { ...outputs[outputIndex], txHash: completedTx.hash, outputIndex },
      );
      expect(outputs[outputIndex].assets.lovelace).toBe(minimumAda);

      const txHash = await signed.submit({ canonical: canonicalSubmission });
      expect(txHash).toBe(completed.toHash());
      await lucid.awaitTx(txHash);
      const [created] = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
      expect(created.datum).toBe(datum);
      expect(created.assets.lovelace).toBe(minimumAda);
    });
  },
);

describe("canonicalTransaction", () => {
  // The test fixture deliberately retains raw noncanonical datum bytes.
  const makeTransaction = (
    redeemers: string,
    outputDatum: string,
  ): TransactionSnapshot => {
    const address = getAddressDetails(
      "addr_test1qrngfyc452vy4twdrepdjc50d4kvqutgt0hs9w6j2qhcdjfx0gpv7rsrjtxv97rplyz3ymyaqdwqa635zrcdena94ljs0xy950",
    ).address.hex;
    const output = `a300${encodeCbor(fromHex(address))}011a001e8480028201d818${encodeCbor(fromHex(outputDatum))}`;
    const body = `a30081825820${"11".repeat(32)}000181${output}021a00030d40`;
    return inspectTransaction(
      `84${body}a20481${outputDatum}05${redeemers}f5f6`,
    );
  };
  const listData = "9f0102ff";
  test("keeps map-format redeemer data whose order canonical encoding would change", () => {
    const tx = makeTransaction(
      `a282000082${redeemerData}82010282010082${listData}820102`,
      datum,
    );
    const view = plutusDataOf(canonicalTransaction(tx));
    expect(view.inlineDatums).toEqual([datum]);
    expect(view.witnessDatums).toEqual([datum]);
    expect(view.redeemerData).toEqual([redeemerData, "820102"]);
  });
  test("keeps legacy redeemer data whose order canonical encoding would change", () => {
    const tx = makeTransaction(
      `82840000${redeemerData}820102840100${listData}820102`,
      datum,
    );
    const view = plutusDataOf(canonicalTransaction(tx));
    expect(view.inlineDatums).toEqual([datum]);
    expect(view.witnessDatums).toEqual([datum]);
    expect(view.redeemerData).toEqual([redeemerData, "820102"]);
  });
  test("is idempotent when no Plutus data is reordered", () => {
    const tx = makeTransaction("81840000d87980820102", "d87980");
    const canonical = canonicalTransaction(tx);
    expect(canonicalTransaction(canonical).cbor).toBe(canonical.cbor);
    expect(canonical.cbor).toBe(encodeCbor(decodeCbor(canonical.cbor), true));
  });
});
