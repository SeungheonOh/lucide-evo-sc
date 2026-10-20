import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import {
  BuildTxWithRedeemer,
  Provider,
  Script,
  UTxO,
  makeTxBuilder,
} from "../src/index.js";
import { makeTxConfig } from "../src/tx-builder/TxConfig.js";
import {
  buildCanonicalRedeemerInfo,
  buildRedeemersFromCanonicalContext,
  transactionFixedPointFingerprint,
} from "../src/tx-builder/internal/RedeemerContext.js";
import {
  createCostModels,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/utils";
import { Data } from "@lucid-evolution/plutus";
import {
  decodeCbor,
  encodeCbor,
  hexToBytes,
  inspectTransaction,
  type CborValue,
} from "@lucid-evolution/ledger";
import {
  getAddressDetails,
  credentialToRewardAddress,
  utxoToTransactionOutput,
} from "@lucid-evolution/utils";

const address =
  "addr_test1qrngfyc452vy4twdrepdjc50d4kvqutgt0hs9w6j2qhcdjfx0gpv7rsrjtxv97rplyz3ymyaqdwqa635zrcdena94ljs0xy950";

const provider = {} as Provider;
const protocolParameters = PROTOCOL_PARAMETERS_DEFAULT;
const costModels = createCostModels(protocolParameters.costModels);
const lucidConfig = {
  provider,
  network: "Custom" as const,
  wallet: undefined,
  txbuilderconfig: makeTxConfig(protocolParameters, costModels),
  costModels,
  protocolParameters,
  slotConfig: { zeroTime: 0, zeroSlot: 0, slotLength: 1_000 },
};

const makeRedeemerMap = (
  order: ReadonlyArray<readonly [number, bigint, bigint]>,
): CborValue =>
  new Map(
    order.map(([tag, index, value]) => [
      [BigInt(tag), index],
      [decodeCbor(Data.to(value)), [value, value + 100n]],
    ]),
  );
const makeRedeemerList = (
  order: ReadonlyArray<readonly [number, bigint, bigint]>,
): CborValue =>
  order.map(([tag, index, value]) => [
    BigInt(tag),
    index,
    decodeCbor(Data.to(value)),
    [value, value + 100n],
  ]);

const makeContextTx = (redeemers: CborValue) => {
  const txHash = "11".repeat(32);
  const utxo: UTxO = {
    txHash,
    outputIndex: 0,
    address,
    assets: { lovelace: 1_000_000n },
  };
  const rewardAddress = credentialToRewardAddress("Custom", {
    type: "Script",
    hash: "22".repeat(28),
  });
  const body = new Map<CborValue, CborValue>([
    [0n, [[hexToBytes(txHash), 0n]]],
    [1n, [decodeCbor(utxoToTransactionOutput(utxo))]],
    [2n, 0n],
    [
      9n,
      new Map([
        [hexToBytes("00".repeat(28)), new Map([[new Uint8Array(), 1n]])],
      ]),
    ],
    [
      5n,
      new Map([[hexToBytes(getAddressDetails(rewardAddress).address.hex), 1n]]),
    ],
  ]);
  return {
    tx: inspectTransaction(
      encodeCbor([
        body,
        new Map<CborValue, CborValue>([[5n, redeemers]]),
        true,
        null,
      ]),
    ),
    utxo,
  };
};
const redeemerLabels = (redeemers: CborValue): string[] =>
  makeContextTx(redeemers).tx.redeemers.map(
    (entry) => `${entry.tag}:${entry.index}`,
  );

describe("context-dependent redeemers", () => {
  test("static config replay uses action snapshots without mutating source debug state", async () => {
    const assets = { lovelace: 2_000_000n };
    const tx = makeTxBuilder(lucidConfig).pay.ToAddress(address, assets);
    assets.lovelace = 10_000_000n;

    const replayedConfig = await tx.config();

    expect(replayedConfig.payToOutputs).toHaveLength(1);
    expect(replayedConfig.payToOutputs[0].assets.lovelace).toBe(2_000_000n);
    expect(tx.rawConfig().payToOutputs).toHaveLength(0);
  });

  test("compose merges minted assets without double-counting parent assets", () => {
    const unit = "aa".repeat(28) + "01";
    const firstMint = makeTxBuilder(lucidConfig).mintAssets({ [unit]: 5n });
    const secondMint = makeTxBuilder(lucidConfig).mintAssets({ [unit]: 7n });
    const emptyTx = makeTxBuilder(lucidConfig);

    const composed = makeTxBuilder(lucidConfig)
      .compose(firstMint)
      .compose(emptyTx);
    expect(composed.rawConfig().mintedAssets).toEqual({ [unit]: 5n });

    const composedWithMoreMint = makeTxBuilder(lucidConfig)
      .compose(firstMint)
      .compose(secondMint);
    expect(composedWithMoreMint.rawConfig().mintedAssets).toEqual({
      [unit]: 12n,
    });
  });

  test("config rejects delayed redeemers", async () => {
    const redeemer: BuildTxWithRedeemer = (ctx) => {
      ctx.inputs[0]?.txHash;
      ctx.referenceInputs[0]?.assets;
      return Data.void();
    };

    await expect(
      makeTxBuilder(lucidConfig)
        .collectFrom(
          [
            {
              txHash: "00".repeat(32),
              outputIndex: 0,
              address,
              assets: { lovelace: 2_000_000n },
            },
          ],
          redeemer,
        )
        .config(),
    ).rejects.toThrow(/BuildTxWithRedeemer|RedeemerBuilder/);
  });

  test("redeemer context exposes canonical tx body and resolved UTxO inputs in one field", async () => {
    const { tx, utxo } = makeContextTx(makeRedeemerMap([[0, 0n, 1n]]));
    const info = await Effect.runPromise(
      buildCanonicalRedeemerInfo(tx, [utxo]),
    );

    const redeemer: BuildTxWithRedeemer = (ctx) => {
      expect(encodeCbor(decodeCbor(ctx.txBody.cbor), true)).toBe(
        encodeCbor(decodeCbor(tx.body.cbor), true),
      );
      expect(ctx.inputs).toEqual([utxo]);
      expect(ctx.referenceInputs).toEqual([]);

      return Data.to(BigInt(ctx.inputs.length));
    };

    const redeemers = await Effect.runPromise(
      buildRedeemersFromCanonicalContext(info, [
        {
          id: 1,
          actionId: 0,
          source: redeemer,
          purposeKey: {
            tag: "spend",
            input: { txHash: utxo.txHash, outputIndex: utxo.outputIndex },
          },
        },
      ]),
    );

    expect(redeemers.get(1)).toBe(Data.to(1n));
  });

  test("canonical input resolution prefers the most complete duplicate UTxO", async () => {
    const { tx, utxo } = makeContextTx(makeRedeemerMap([[0, 0n, 1n]]));
    const scriptRef: Script = { type: "PlutusV3", script: "00" };
    const lessComplete: UTxO = {
      ...utxo,
      datumHash: "12".repeat(32),
    };
    const moreComplete: UTxO = {
      ...utxo,
      datum: Data.void(),
      scriptRef,
    };

    const info = await Effect.runPromise(
      buildCanonicalRedeemerInfo(tx, [lessComplete, moreComplete]),
    );

    expect(info.inputs[0].datum).toBe(Data.void());
    expect(info.inputs[0].scriptRef).toEqual(scriptRef);
  });

  test("canonical redeemer entries are sorted independently of map insertion order", () => {
    const redeemers = makeRedeemerMap([
      [3, 0n, 3n],
      [1, 0n, 2n],
      [0, 0n, 1n],
    ]);

    expect(redeemerLabels(redeemers)).toEqual([
      "spend:0",
      "mint:0",
      "withdraw:0",
    ]);
  });

  test("canonical redeemer entries are sorted independently of legacy array order", () => {
    const redeemers = makeRedeemerList([
      [3, 0n, 3n],
      [1, 0n, 2n],
      [0, 0n, 1n],
    ]);

    expect(redeemerLabels(redeemers)).toEqual([
      "spend:0",
      "mint:0",
      "withdraw:0",
    ]);
  });

  test("redeemerListIndex follows canonical redeemer order while purpose index remains body index", async () => {
    const { tx, utxo } = makeContextTx(
      makeRedeemerMap([
        [3, 0n, 3n],
        [1, 0n, 2n],
        [0, 0n, 1n],
      ]),
    );

    const info = await Effect.runPromise(
      buildCanonicalRedeemerInfo(tx, [utxo]),
    );

    expect(
      info.redeemers.map(
        (purpose) =>
          `${purpose.tag}:${purpose.index}:${purpose.redeemerListIndex}`,
      ),
    ).toEqual(["spend:0:0", "mint:0:1", "withdraw:0:2"]);
  });

  test("fixed-point fingerprint is stable across equivalent redeemer map insertion order", () => {
    const first = makeContextTx(
      makeRedeemerMap([
        [3, 0n, 3n],
        [1, 0n, 2n],
        [0, 0n, 1n],
      ]),
    );
    const second = makeContextTx(
      makeRedeemerMap([
        [0, 0n, 1n],
        [3, 0n, 3n],
        [1, 0n, 2n],
      ]),
    );

    expect(transactionFixedPointFingerprint(first.tx)).toEqual(
      transactionFixedPointFingerprint(second.tx),
    );
  });
});
