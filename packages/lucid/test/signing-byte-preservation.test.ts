import { beforeAll, expect, test } from "vitest";
import {
  bytesToHex,
  CborTag,
  decodeCbor,
  encodeCbor,
  hexToBytes,
  inspectTransaction,
  ledger,
  type CborValue,
} from "@lucid-evolution/ledger";
import {
  Constr,
  Data,
  Emulator,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  Lucid,
  mintingPolicyToId,
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
  type EmulatorAccount,
  type LucidEvolution,
} from "../src/index.js";

let lucid: LucidEvolution;
let accounts: EmulatorAccount[];
let unsigned: string;
let privateKey: string;
let vkeyOnly: string;
let committedRedeemers: string;

beforeAll(async () => {
  const account = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  privateKey = account.privateKey;
  const script = { type: "PlutusV3" as const, script: "46450100002499" };
  const address = validatorToAddress("Custom", script);
  accounts = [
    account,
    {
      ...account,
      address,
      assets: { lovelace: 10_000_000n },
      outputData: { inline: Data.void() },
    },
  ];
  const emulator = new Emulator(accounts);
  lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(privateKey);
  const [input] = await emulator.getUtxos(address);
  const completed = await lucid
    .newTx()
    .collectFrom([input], Data.to(new Constr(0, [1n])))
    .attach.SpendingValidator(script)
    .setMinFee(1_000_000n)
    .complete();
  const transaction = decodeCbor(completed.toCBOR()) as CborValue[];
  const body = transaction[0] as Map<CborValue, CborValue>;
  const witnesses = transaction[1] as Map<CborValue, CborValue>;
  const redeemerMap = witnesses.get(5n) as Map<CborValue, CborValue>;
  const legacy = [...redeemerMap].map(([purpose, value]) => [
    ...(purpose as CborValue[]),
    ...(value as CborValue[]),
  ]);
  witnesses.set(5n, legacy);
  committedRedeemers = encodeCbor(legacy);
  // With no witness datums, the script integrity hash commits to the redeemer
  // bytes followed by the Plutus V3 language view. Every codec/hash is Haskell.
  const languageView = encodeCbor(
    new Map<CborValue, CborValue>([
      [2n, PROTOCOL_PARAMETERS_DEFAULT.costModels.PlutusV3.map(BigInt)],
    ]),
  );
  body.set(
    11n,
    hexToBytes(
      ledger<string>("hash.blake2b", {
        hex: committedRedeemers + languageView,
        size: 32,
      }),
    ),
  );
  unsigned = encodeCbor(transaction);
  const partial = decodeCbor(
    ledger<string>("tx.sign", { cbor: unsigned, privateKeys: [privateKey] }),
  ) as Map<CborValue, CborValue>;
  vkeyOnly = encodeCbor(
    new Map<CborValue, CborValue>([[0n, partial.get(0n)!]]),
  );
  witnesses.set(0n, partial.get(0n)!);
  const signedFixture = encodeCbor(transaction);
  // Establish that this legacy representation is a valid consensus transaction,
  // independently of the witness-merging operation under test.
  expect(await new Emulator(accounts).submitTx(signedFixture)).toBe(
    inspectTransaction(unsigned).hash,
  );
});

test("partial signing returns only the requested key witnesses", () => {
  const partial = decodeCbor(
    ledger<string>("tx.sign", { cbor: unsigned, privateKeys: [privateKey] }),
  ) as Map<CborValue, CborValue>;
  expect([...partial.keys()]).toEqual([0n]);
});

test("adding a key witness preserves a valid legacy redeemer encoding and its committed hash", async () => {
  const original = inspectTransaction(unsigned);
  const signed = await lucid.fromTx(unsigned).assemble([vkeyOnly]).complete();
  const result = inspectTransaction(signed.toCBOR());
  expect(encodeCbor(result.witnesses.get(5n)!)).toBe(committedRedeemers);
  expect(result.bodyCbor).toBe(original.bodyCbor);
  expect(result.body.scriptDataHash).toBe(original.body.scriptDataHash);
  expect(result.hash).toBe(original.hash);
  expect(await new Emulator(accounts).submitTx(signed.toCBOR())).toBe(
    original.hash,
  );
});

test("canonical export preserves redeemer bytes already committed by an unsigned transaction", async () => {
  const original = inspectTransaction(unsigned);
  const canonical = lucid.fromTx(unsigned).toCBOR({ canonical: true });
  const exported = inspectTransaction(canonical);
  // Definite and indefinite constructor fields are the same Plutus value, but
  // changing their CBOR would invalidate the existing script integrity hash.
  expect(encodeCbor(exported.witnesses.get(5n)!)).toBe(committedRedeemers);
  expect(exported.body.scriptDataHash).toBe(original.body.scriptDataHash);
  const signed = await lucid
    .fromTx(canonical)
    .sign.withPrivateKey(privateKey)
    .complete();
  expect(await new Emulator(accounts).submitTx(signed.toCBOR())).toBe(
    exported.hash,
  );
});

test("canonical export preserves metadata bytes already committed by an unsigned transaction", async () => {
  const completed = await lucid
    .newTx()
    .pay.ToAddress(accounts[0].address, { lovelace: 2_000_000n })
    .attachMetadata(1, { z: 1, a: 2 })
    .complete();
  const original = inspectTransaction(completed.toCBOR());
  const signedOriginal = await lucid
    .fromTx(original.cbor)
    .sign.withPrivateKey(privateKey)
    .complete();
  expect(await new Emulator(accounts).submitTx(signedOriginal.toCBOR())).toBe(
    original.hash,
  );
  const canonical = completed.toCBOR({ canonical: true });
  const exported = inspectTransaction(canonical);
  expect(encodeCbor(exported.auxiliaryData)).toBe(
    encodeCbor(original.auxiliaryData),
  );
  expect(exported.body.auxiliaryDataHash).toBe(original.body.auxiliaryDataHash);
  const signed = await lucid
    .fromTx(canonical)
    .sign.withPrivateKey(privateKey)
    .complete();
  expect(await new Emulator(accounts).submitTx(signed.toCBOR())).toBe(
    exported.hash,
  );
});

test("canonical export preserves native script bytes committed by a minting policy", async () => {
  const keyHash = getAddressDetails(accounts[0].address).paymentCredential!
    .hash;
  const canonicalScript = `8200581c${keyHash}`;
  const originalScript = `9f00581c${keyHash}ff`;
  const policy = { type: "Native" as const, script: canonicalScript };
  const canonicalPolicyId = mintingPolicyToId(policy);
  const originalPolicyId = ledger<string>("hash.blake2b", {
    hex: `00${originalScript}`,
    size: 28,
  });
  const completed = await lucid
    .newTx()
    .mintAssets({ [`${canonicalPolicyId}00`]: 1n })
    .attach.MintingPolicy(policy)
    .setMinFee(1_000_000n)
    .complete();
  const transaction = decodeCbor(completed.toCBOR()) as CborValue[];
  const body = transaction[0] as Map<CborValue, CborValue>;
  const witnesses = transaction[1] as Map<CborValue, CborValue>;
  witnesses.set(1n, new CborTag(258n, [decodeCbor(originalScript)]));
  const mint = body.get(9n) as Map<CborValue, CborValue>;
  const assets = [...mint.values()][0];
  mint.clear();
  mint.set(hexToBytes(originalPolicyId), assets);
  let changedOutputs = 0;
  for (const output of body.get(1n) as CborValue[]) {
    const value =
      output instanceof Map ? output.get(1n) : (output as CborValue[])[1];
    if (!Array.isArray(value)) continue;
    const outputAssets = value[1] as Map<CborValue, CborValue>;
    for (const [policyHash, tokens] of outputAssets) {
      if (bytesToHex(policyHash as Uint8Array) !== canonicalPolicyId) continue;
      outputAssets.delete(policyHash);
      outputAssets.set(hexToBytes(originalPolicyId), tokens);
      changedOutputs++;
    }
  }
  expect(changedOutputs).toBe(1);
  const original = inspectTransaction(encodeCbor(transaction));
  const signedOriginal = await lucid
    .fromTx(original.cbor)
    .sign.withPrivateKey(privateKey)
    .complete();
  expect(await new Emulator(accounts).submitTx(signedOriginal.toCBOR())).toBe(
    original.hash,
  );
  const canonical = lucid.fromTx(original.cbor).toCBOR({ canonical: true });
  const exported = inspectTransaction(canonical);
  expect(encodeCbor(exported.witnesses.get(1n)!)).toBe(
    encodeCbor(original.witnesses.get(1n)!),
  );
  const signed = await lucid
    .fromTx(canonical)
    .sign.withPrivateKey(privateKey)
    .complete();
  expect(await new Emulator(accounts).submitTx(signed.toCBOR())).toBe(
    exported.hash,
  );
});

test("native script hashing preserves the CBOR representation accepted by the ledger", () => {
  const keyHash = getAddressDetails(accounts[0].address).paymentCredential!
    .hash;
  const script = `9f00581c${keyHash}ff`;
  expect(mintingPolicyToId({ type: "Native", script })).toBe(
    ledger<string>("hash.blake2b", { hex: `00${script}`, size: 28 }),
  );
});

test("minting preserves an attached native script's original ledger encoding", async () => {
  const keyHash = getAddressDetails(accounts[0].address).paymentCredential!
    .hash;
  const script = `9f00581c${keyHash}ff`;
  const policy = { type: "Native" as const, script };
  const policyId = ledger<string>("hash.blake2b", {
    hex: `00${script}`,
    size: 28,
  });
  const completed = await lucid
    .newTx()
    .mintAssets({ [`${policyId}00`]: 1n })
    .attach.MintingPolicy(policy)
    .setMinFee(1_000_000n)
    .complete();
  const snapshot = inspectTransaction(completed.toCBOR());
  const nativeSet = snapshot.witnesses.get(1n)!;
  const scripts = (
    nativeSet instanceof CborTag ? nativeSet.value : nativeSet
  ) as CborValue[];
  expect(encodeCbor(scripts[0])).toBe(script);
  const signed = await completed.sign.withPrivateKey(privateKey).complete();
  expect(await new Emulator(accounts).submitTx(signed.toCBOR())).toBe(
    snapshot.hash,
  );
});

test("native reference scripts keep their committed bytes through minting and confirmation", async () => {
  const keyHash = getAddressDetails(accounts[0].address).paymentCredential!
    .hash;
  const script = `9f00581c${keyHash}ff`;
  const policy = { type: "Native" as const, script };
  const policyId = ledger<string>("hash.blake2b", {
    hex: `00${script}`,
    size: 28,
  });
  const emulator = new Emulator([
    accounts[0],
    {
      ...accounts[0],
      assets: { lovelace: 10_000_000n },
      outputData: { scriptRef: policy },
    },
  ]);
  const client = await Lucid(emulator, "Custom");
  client.selectWallet.fromPrivateKey(privateKey);
  const reference = (await emulator.getUtxos(accounts[0].address)).find(
    (utxo) => utxo.scriptRef,
  )!;
  expect(reference.scriptRef).toEqual(policy);
  const completed = await client
    .newTx()
    .readFrom([reference])
    .mintAssets({ [`${policyId}00`]: 1n })
    .setMinFee(1_000_000n)
    .complete();
  const signed = await completed.sign.withPrivateKey(privateKey).complete();
  expect(await signed.submit()).toBe(completed.toHash());
  emulator.awaitBlock();
  expect((await emulator.getUtxosByOutRef([reference]))[0].scriptRef).toEqual(
    policy,
  );
});
