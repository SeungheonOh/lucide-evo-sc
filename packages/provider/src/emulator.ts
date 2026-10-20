import type {
  Address,
  Assets,
  Credential,
  Datum,
  DatumHash,
  Delegation,
  EvalRedeemer,
  Lovelace,
  OutputData,
  OutRef,
  ProtocolParameters,
  Provider,
  RewardAddress,
  RewardAccountState,
  Transaction,
  TransactionStatus,
  TransactionStatusOptions,
  TxHash,
  Unit,
  UnixTime,
  UTxO,
} from "@lucid-evolution/core-types";
import {
  coreToTxOutput,
  credentialToAddress,
  datumToHash,
  generatePrivateKey,
  generateSeedPhrase,
  PROTOCOL_PARAMETERS_DEFAULT,
  utxoToCore,
} from "@lucid-evolution/utils";
import { ledger, getLedgerRuntime } from "@lucid-evolution/ledger";
import { walletFromSeed } from "@lucid-evolution/wallet";
import {
  EmulatorLedger,
  type FlatOutRef,
  type LedgerEntry,
} from "./internal/emulator-ledger.js";

export type EmulatorChainContext = {
  network: "mainnet" | "preprod" | "preview" | "custom";
  networkMagic?: number;
  stakePools?: string[];
  stakeDeposits?: Array<{
    type: "Key" | "Script";
    hash: string;
    deposit: string;
  }>;
  drepDeposits?: Array<{
    type: "Key" | "Script";
    hash: string;
    deposit: string;
  }>;
  systemStart: string;
  protocolParameters: Record<string, unknown>;
  eraSummaries: Array<{
    start: { time: number; slot: number; epoch: number };
    end: { time: number; slot: number; epoch: number };
    parameters: {
      epoch_length: number;
      slot_length: number;
      safe_zone?: number;
    };
  }>;
};

export interface EmulatorRuntime {
  run(payload: Record<string, unknown>): Promise<unknown>;
}
export type EmulatorBalancer = {
  type: "sc-tools";
  runtime: EmulatorRuntime;
  chainContext: () => Promise<EmulatorChainContext>;
};
function protocolOverrides(p: ProtocolParameters): Record<string, unknown> {
  return {
    protocolVersion: {
      // Preserve the original Emulator ledger rules when the version is omitted.
      major: p.protocolMajorVersion ?? 11,
      minor: p.protocolMinorVersion ?? 0,
    },
    txFeePerByte: p.minFeeA,
    txFeeFixed: p.minFeeB,
    maxTxSize: p.maxTxSize,
    maxValueSize: p.maxValSize,
    stakeAddressDeposit: String(p.keyDeposit),
    stakePoolDeposit: String(p.poolDeposit),
    dRepDeposit: String(p.drepDeposit),
    govActionDeposit: String(p.govActionDeposit),
    executionUnitPrices: { priceMemory: p.priceMem, priceSteps: p.priceStep },
    maxTxExecutionUnits: {
      memory: String(p.maxTxExMem),
      steps: String(p.maxTxExSteps),
    },
    utxoCostPerByte: String(p.coinsPerUtxoByte),
    collateralPercentage: p.collateralPercentage,
    maxCollateralInputs: p.maxCollateralInputs,
    minFeeRefScriptCostPerByte: p.minFeeRefScriptCostPerByte,
    costModels: p.costModels,
  };
}

type TransactionHistory = Record<
  TxHash,
  | { status: "pending" }
  | { status: "confirmed"; blockHeight: number; slot: number }
>;

const EMULATOR_PROVIDER_BRAND = Symbol.for(
  "@lucid-evolution/provider/Emulator",
);

export const isEmulatorProvider = (
  provider: Provider | undefined,
): provider is Emulator =>
  Boolean(
    provider &&
      (provider as Provider & { [EMULATOR_PROVIDER_BRAND]?: boolean })[
        EMULATOR_PROVIDER_BRAND
      ],
  );

export type EmulatorAccount = {
  seedPhrase: string;
  address: Address;
  assets: Assets;
  outputData?: OutputData;
  privateKey: string;
};

export function generateEmulatorAccountFromPrivateKey(
  assets: Assets,
): EmulatorAccount {
  const privateKey = generatePrivateKey();
  const { keyHash } = ledger<{ keyHash: string }>("key.fromPrivate", {
    privateKey,
  });
  const address = credentialToAddress("Custom", { type: "Key", hash: keyHash });
  return {
    seedPhrase: "",
    address: address,
    assets,
    privateKey: privateKey,
  };
}

export function generateEmulatorAccount(assets: Assets): EmulatorAccount {
  const seedPhrase = generateSeedPhrase();
  return {
    seedPhrase,
    address: walletFromSeed(seedPhrase, {
      addressType: "Base",
      accountIndex: 0,
      network: "Custom",
    }).address,
    assets,
    privateKey: "",
  };
}

class EmulatorFixtures {
  readonly [EMULATOR_PROVIDER_BRAND] = true;
  #confirmed = new EmulatorLedger();
  /**
   * The confirmed UTxO set, keyed by txHash + outputIndex: a plain record
   * that callers may read, edit, replace or snapshot freely. It is an own
   * enumerable property, defined here so it keeps its place among the
   * instance's keys.
   */
  declare ledger: Record<FlatOutRef, LedgerEntry>;
  #ledgerProperty = Object.defineProperty(this, "ledger", {
    configurable: true,
    enumerable: true,
    get: () => this.#confirmed.expose(),
    set: (entries: Record<FlatOutRef, LedgerEntry>) =>
      this.#confirmed.replace(entries),
  });
  mempool: Record<FlatOutRef, LedgerEntry> = {};
  /** Public stake-account projection of the ledger state. */
  chain: Record<
    RewardAddress,
    { registeredStake: boolean; delegation: Delegation }
  > = {};
  blockHeight: number;
  slot: number;
  time: UnixTime;
  protocolParameters: ProtocolParameters;
  datumTable: Record<DatumHash, Datum> = {};
  treasury: Lovelace;
  #history: TransactionHistory = {};
  /** Whether a caller holds `transactionHistory`, and may edit it. */
  #historyExposed = false;
  /** Every transaction status, keyed by hash; a plain record, like `ledger`. */
  declare transactionHistory: TransactionHistory;
  #historyProperty = Object.defineProperty(this, "transactionHistory", {
    configurable: true,
    enumerable: true,
    get: () => {
      this.#historyExposed = true;
      return this.#history;
    },
    set: (history: TransactionHistory) => {
      this.#historyExposed = true;
      this.#history = history;
    },
  });
  /**
   * Transactions submitted since the last block. While no caller holds
   * `transactionHistory`, these are its only pending entries.
   */
  #pendingTxHashes: TxHash[] = [];
  constructor(
    accounts: EmulatorAccount[],
    protocolParameters: ProtocolParameters = PROTOCOL_PARAMETERS_DEFAULT,
    treasury: Lovelace = 0n,
  ) {
    const GENESIS_HASH = "00".repeat(32);
    this.blockHeight = 0;
    this.slot = 0;
    this.time = Date.now();
    accounts.forEach(({ address, assets, outputData }, index) => {
      if (
        [outputData?.hash, outputData?.asHash, outputData?.inline].filter(
          (b) => b,
        ).length > 1
      ) {
        throw new Error(
          "Not allowed to set hash, asHash and inline at the same time.",
        );
      }

      this.#confirmed.set(GENESIS_HASH + index, {
        utxo: {
          txHash: GENESIS_HASH,
          outputIndex: index,
          address,
          assets,
          datumHash: outputData?.asHash
            ? datumToHash(outputData.asHash)
            : outputData?.hash,
          datum: outputData?.inline,
          scriptRef: outputData?.scriptRef,
        },
        spent: false,
      });
    });
    this.protocolParameters = protocolParameters;
    this.treasury = treasury;
  }

  now(): UnixTime {
    return this.time;
  }

  /** Confirms every pending transaction in `transactionHistory`. */
  private confirmPendingTransactions(blockHeight: number, slot: number) {
    const history = this.#history;
    if (this.#historyExposed) {
      for (const [txHash, { status }] of Object.entries(history)) {
        if (status === "pending") {
          history[txHash] = { status: "confirmed", blockHeight, slot };
        }
      }
    } else {
      for (const txHash of this.#pendingTxHashes) {
        if (history[txHash].status === "pending") {
          history[txHash] = { status: "confirmed", blockHeight, slot };
        }
      }
    }
    this.#pendingTxHashes = [];
  }

  /** Moves the mempool into the ledger and drops spent entries. */
  private applyMempool() {
    this.#confirmed.applyMempool(this.mempool);
    this.mempool = {};
  }

  awaitSlot(length = 1) {
    this.slot += length;
    this.time += length * 1000;
    const currentHeight = this.blockHeight;
    this.blockHeight = Math.floor(this.slot / 20);

    if (this.blockHeight > currentHeight) {
      this.confirmPendingTransactions(
        currentHeight + 1,
        (currentHeight + 1) * 20,
      );
      this.applyMempool();
    }
  }

  awaitBlock(height = 1) {
    const previousHeight = this.blockHeight;
    const previousSlot = this.slot;
    this.blockHeight += height;
    this.slot += height * 20;
    this.time += height * 20 * 1000;

    if (height > 0) {
      this.confirmPendingTransactions(previousHeight + 1, previousSlot + 20);
    }

    this.applyMempool();
  }

  getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    return Promise.resolve(this.#confirmed.utxosAt(addressOrCredential));
  }

  getProtocolParameters(): Promise<ProtocolParameters> {
    return Promise.resolve(this.protocolParameters);
  }

  getTreasury(): Promise<bigint> {
    return Promise.resolve(this.treasury);
  }

  getDatum(datumHash: DatumHash): Promise<Datum> {
    return Promise.resolve(this.datumTable[datumHash]);
  }

  getUtxosWithUnit(
    addressOrCredential: Address | Credential,
    unit: Unit,
  ): Promise<UTxO[]> {
    return Promise.resolve(this.#confirmed.utxosAt(addressOrCredential, unit));
  }

  getUtxosByOutRef(outRefs: OutRef[]): Promise<UTxO[]> {
    return Promise.resolve(
      outRefs.flatMap((outRef) => {
        const entry = this.#confirmed.get(outRef.txHash + outRef.outputIndex);
        return entry && !entry.spent ? entry.utxo : [];
      }),
    );
  }

  getUtxoByUnit(unit: string): Promise<UTxO> {
    const utxos = this.#confirmed.utxosWithUnit(unit);

    if (utxos.length > 1) {
      throw new Error("Unit needs to be an NFT or only held by one address.");
    }

    return Promise.resolve(utxos[0]);
  }

  getRewardAccount(rewardAddress: RewardAddress): Promise<RewardAccountState> {
    const account = this.chain[rewardAddress];
    return Promise.resolve({
      registered: account?.registeredStake ?? false,
      poolId: account?.delegation.poolId ?? null,
      rewards: account?.delegation.rewards ?? 0n,
    });
  }

  getDelegation(rewardAddress: RewardAddress): Promise<Delegation> {
    return Promise.resolve({
      poolId: this.chain[rewardAddress]?.delegation?.poolId || null,
      rewards: this.chain[rewardAddress]?.delegation?.rewards || 0n,
    });
  }

  awaitTx(txHash: string): Promise<boolean> {
    if (this.#history[txHash]?.status === "pending") {
      this.awaitBlock();
      return Promise.resolve(true);
    }
    return Promise.resolve(true);
  }

  getTransactionStatus(
    txHash: TxHash,
    options: TransactionStatusOptions = {},
  ): Promise<TransactionStatus> {
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    }

    const status = this.#history[txHash];
    if (!status) return Promise.resolve({ status: "not_found", txHash });
    if (status.status === "pending") {
      return Promise.resolve({ status: "pending", txHash });
    }
    return Promise.resolve({
      status: "confirmed",
      txHash,
      confirmation: {
        txHash,
        blockHeight: status.blockHeight,
        slot: status.slot,
        confirmations: this.blockHeight - status.blockHeight + 1,
      },
    });
  }

  /**
   * Emulates the behaviour of the reward distribution at epoch boundaries.
   * Stake keys need to be registered and delegated like on a real chain in order to receive rewards.
   */
  distributeRewards(rewards: Lovelace) {
    for (const [
      rewardAddress,
      { registeredStake, delegation },
    ] of Object.entries(this.chain)) {
      if (registeredStake && delegation.poolId) {
        this.chain[rewardAddress] = {
          registeredStake,
          delegation: {
            poolId: delegation.poolId,
            rewards: (delegation.rewards += rewards),
          },
        };
      }
    }
    this.awaitBlock();
  }

  log() {
    function getRandomColor(unit: Unit) {
      const seed = unit === "lovelace" ? "1" : unit;
      // Convert the seed string to a number
      let num = 0;
      for (let i = 0; i < seed.length; i++) {
        num += seed.charCodeAt(i);
      }

      // Generate a color based on the seed number
      const r = (num * 123) % 256;
      const g = (num * 321) % 256;
      const b = (num * 213) % 256;

      // Return the color as a hex string
      return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    const totalBalances: Assets = {};

    const balances: Record<Address, Assets> = {};
    for (const { utxo } of Object.values(this.#confirmed.record)) {
      for (const [unit, quantity] of Object.entries(utxo.assets)) {
        if (!balances[utxo.address]) {
          balances[utxo.address] = { [unit]: quantity };
        } else if (!balances[utxo.address]?.[unit]) {
          balances[utxo.address][unit] = quantity;
        } else {
          balances[utxo.address][unit] += quantity;
        }

        if (!totalBalances[unit]) {
          totalBalances[unit] = quantity;
        } else {
          totalBalances[unit] += quantity;
        }
      }
    }

    console.log("\n%cBlockchain state", "color:purple");
    console.log(
      `
    Block height:   %c${this.blockHeight}%c
    Slot:           %c${this.slot}%c
    Unix time:      %c${this.time}
  `,
      "color:yellow",
      "color:white",
      "color:yellow",
      "color:white",
      "color:yellow",
    );
    console.log("\n");
    for (const [address, assets] of Object.entries(balances)) {
      console.log(`Address: %c${address}`, "color:blue", "\n");
      for (const [unit, quantity] of Object.entries(assets)) {
        const barLength = Math.max(
          Math.floor(60 * (Number(quantity) / Number(totalBalances[unit]))),
          1,
        );
        console.log(
          `%c${"\u2586".repeat(barLength) + " ".repeat(60 - barLength)}`,
          `color: ${getRandomColor(unit)}`,
          "",
          `${unit}:`,
          quantity,
          "",
        );
      }
      console.log(`\n${"\u2581".repeat(60)}\n`);
    }
  }
}

type Snapshot = {
  ok: true;
  state: Record<string, unknown>;
  chain: EmulatorChainContext;
  utxos: Array<{ input: string; cbor: string }>;
  datums: Array<{ hash: string; cbor: string }>;
  accounts: Array<{ address: string; rewards: string; poolId: string | null }>;
  treasury: string;
  txHash?: string;
  registered?: boolean;
  rewards?: string;
  poolId?: string | null;
};

export type EmulatorOptions = {
  /** Pools present at genesis, with zero deposit and default mockchain pool data. */
  stakePools?: string[];
};

const encodeUtxo = utxoToCore;

/**
 * Emulator's clock, accounts, queries, and pending/confirmed transaction API,
 * backed by the actual convex-mockchain Conway ledger in WASM.
 * The first three constructor arguments are identical to Emulator's.
 */
export class Emulator extends EmulatorFixtures implements Provider {
  readonly balancer: EmulatorBalancer;
  private readonly runtime: EmulatorRuntime;
  private readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private snapshot!: Snapshot;
  private deferredError?: unknown;
  private pendingRewards = 0;
  private fixtureFingerprint: string;

  constructor(
    accounts: EmulatorAccount[],
    protocolParameters: ProtocolParameters = PROTOCOL_PARAMETERS_DEFAULT,
    treasury: Lovelace = 0n,
    runtime: EmulatorRuntime = getLedgerRuntime(),
    options: EmulatorOptions = {},
  ) {
    super(accounts, protocolParameters, treasury);
    this.runtime = runtime;
    this.fixtureFingerprint = JSON.stringify(this.fixtures());
    this.balancer = {
      type: "sc-tools",
      runtime,
      chainContext: async () => this.getChainContext(),
    };
    const genesis = Object.values(this.ledger).map(({ utxo }) =>
      encodeUtxo(utxo),
    );
    const datums = accounts.flatMap(({ outputData }) =>
      [outputData?.asHash, outputData?.inline].filter(
        (d): d is string => d !== undefined,
      ),
    );
    this.ready = this.request({
      operation: "init",
      stakePools: options.stakePools ?? [],
      utxos: genesis,
      datums,
      protocolParameters: protocolOverrides(protocolParameters),
      systemStart: String(this.time / 1000),
      treasury: String(treasury),
      slot: 0,
    }).then((snapshot) => {
      if (JSON.stringify(this.fixtures()) === this.fixtureFingerprint) {
        this.applySnapshot(snapshot, true);
      } else {
        // Preserve fixture edits made immediately after construction.
        this.snapshot = snapshot;
      }
    });
    // Initialization errors are reported by every asynchronous provider method.
    void this.ready.catch(() => {});
  }

  private async request(payload: Record<string, unknown>): Promise<Snapshot> {
    const response = await this.runtime.run({
      action: "mockchain",
      ...payload,
    });
    if (
      !response ||
      typeof response !== "object" ||
      !("ok" in response) ||
      response.ok !== true
    ) {
      throw new Error(
        `convex-mockchain: ${String((response as { error?: unknown } | null)?.error ?? "invalid response")}`,
      );
    }
    return response as Snapshot;
  }

  private async settled(): Promise<void> {
    await this.ready;
    await this.pending;
    if (this.deferredError) {
      const error = this.deferredError;
      this.deferredError = undefined;
      throw error;
    }
  }

  private enqueue<T>(
    operation: () => Promise<T>,
    synchronize = true,
  ): Promise<T> {
    const result = this.pending.then(async () => {
      await this.ready;
      if (synchronize) await this.syncFixtures();
      return operation();
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private fixtures() {
    return {
      utxos: Object.values({ ...this.ledger, ...this.mempool })
        .filter(({ spent }) => !spent)
        .map(({ utxo }) => encodeUtxo(utxo))
        .sort(),
      accounts:
        this.pendingRewards > 0 && this.snapshot
          ? this.snapshot.accounts
          : Object.entries(this.chain)
              .filter(([, a]) => a.registeredStake)
              .map(([address, a]) => ({
                address,
                rewards: String(a.delegation.rewards),
                poolId: a.delegation.poolId,
              })),
      treasury: String(this.treasury),
      datums: Object.values(this.datumTable).sort(),
      protocolParameters: protocolOverrides(this.protocolParameters),
    };
  }

  private async syncFixtures(edits?: {
    updated: Snapshot["accounts"];
    removed: Set<string>;
  }): Promise<void> {
    const fixtures = this.fixtures();
    if (edits) {
      const accounts = new Map(
        this.snapshot.accounts.map((a) => [a.address, a]),
      );
      for (const address of edits.removed) accounts.delete(address);
      for (const account of edits.updated)
        accounts.set(account.address, account);
      fixtures.accounts = [...accounts.values()];
    }
    const fingerprint = JSON.stringify(fixtures);
    if (fingerprint === this.fixtureFingerprint) return;
    const chain = {
      ...this.snapshot.chain,
      protocolParameters: {
        ...this.snapshot.chain.protocolParameters,
        ...fixtures.protocolParameters,
      },
    };
    const snapshot = await this.request({
      operation: "setFixtures",
      state: this.snapshot.state,
      chain,
      slot: this.slot,
      ...fixtures,
    });
    // These are explicit public fixture edits. Keep their confirmed/pending
    // placement, but make the actual ledger authoritative for validation too.
    this.snapshot = snapshot;
    this.fixtureFingerprint = fingerprint;
  }

  private applySnapshot(snapshot: Snapshot, initial = false): void {
    const available = new Map(
      snapshot.utxos.map(({ input, cbor }) => {
        const [txHash, index] = input.split("#");
        const utxo: UTxO = {
          txHash,
          outputIndex: Number(index),
          ...coreToTxOutput(cbor),
        };
        return [txHash + index, utxo] as const;
      }),
    );
    for (const entries of [this.ledger, this.mempool]) {
      for (const [key, entry] of Object.entries(entries))
        entry.spent = !available.has(key);
    }
    for (const [key, utxo] of available) {
      if (!this.ledger[key] && !this.mempool[key])
        (initial ? this.ledger : this.mempool)[key] = { utxo, spent: false };
    }
    for (const { hash, cbor } of snapshot.datums) this.datumTable[hash] = cbor;
    for (const account of Object.values(this.chain)) {
      account.registeredStake = false;
      account.delegation = { poolId: null, rewards: 0n };
    }
    Object.assign(
      this.chain,
      Object.fromEntries(
        snapshot.accounts.map(({ address, rewards, poolId }) => [
          address,
          {
            registeredStake: true,
            delegation: { rewards: BigInt(rewards), poolId },
          },
        ]),
      ),
    );
    this.treasury = BigInt(snapshot.treasury);
    this.snapshot = snapshot;
    this.fixtureFingerprint = JSON.stringify(this.fixtures());
  }

  async getChainContext(): Promise<EmulatorChainContext> {
    await this.settled();
    await this.enqueue(async () => {});
    return structuredClone(this.snapshot.chain);
  }

  override async getProtocolParameters() {
    await this.settled();
    return super.getProtocolParameters();
  }
  override async getTreasury() {
    await this.settled();
    return super.getTreasury();
  }
  override async getDatum(hash: DatumHash) {
    await this.settled();
    return super.getDatum(hash);
  }
  override async getUtxos(address: Address | Credential) {
    await this.settled();
    return super.getUtxos(address);
  }
  override async getUtxosWithUnit(address: Address | Credential, unit: Unit) {
    await this.settled();
    return super.getUtxosWithUnit(address, unit);
  }
  override getUtxoByUnit(unit: Unit): Promise<UTxO> {
    // Emulator throws synchronously when more than one UTxO holds the unit.
    // Preserve that observable API, then re-query after queued ledger updates.
    super.getUtxoByUnit(unit);
    return this.settled().then(() => super.getUtxoByUnit(unit));
  }
  override async getUtxosByOutRef(refs: OutRef[]) {
    await this.settled();
    return super.getUtxosByOutRef(refs);
  }
  async getUtxosWithPolicy(address: Address | Credential, policyId: string) {
    return (await this.getUtxos(address)).filter((u) =>
      Object.keys(u.assets).some(
        (unit) =>
          unit !== "lovelace" &&
          unit.startsWith(policyId) &&
          u.assets[unit] > 0n,
      ),
    );
  }
  override async getRewardAccount(
    address: RewardAddress,
  ): Promise<RewardAccountState> {
    await this.settled();
    return super.getRewardAccount(address);
  }
  override async getDelegation(address: RewardAddress) {
    await this.settled();
    return super.getDelegation(address);
  }
  override async getTransactionStatus(
    hash: TxHash,
    options: TransactionStatusOptions = {},
  ) {
    await this.settled();
    return super.getTransactionStatus(hash, options);
  }
  override async awaitTx(hash: TxHash) {
    await this.settled();
    return super.awaitTx(hash);
  }

  override distributeRewards(rewards: Lovelace): void {
    if (rewards < 0n) throw new Error("Negative reward");
    const slot = this.slot;
    // Capture explicit account edits before the synchronous reward projection.
    // Apply only changed accounts after earlier queued submissions have settled.
    const before = this.fixtures().accounts;
    const previous = new Map(
      (this.snapshot?.accounts ?? []).map((a) => [a.address, a]),
    );
    const current = new Set(before.map((a) => a.address));
    const edits =
      this.pendingRewards === 0
        ? {
            updated: before.filter(
              (a) =>
                JSON.stringify(a) !== JSON.stringify(previous.get(a.address)),
            ),
            removed: new Set(
              [...previous.keys()].filter((a) => !current.has(a)),
            ),
          }
        : undefined;
    this.pendingRewards++;
    void this.enqueue(async () => {
      await this.syncFixtures(edits);
      const next = await this.request({
        operation: "reward",
        state: this.snapshot.state,
        chain: this.snapshot.chain,
        slot,
        amount: String(rewards),
      });
      this.applySnapshot(next);
    }, false)
      .catch((error) => {
        this.applySnapshot(this.snapshot);
        this.deferredError = error;
      })
      .finally(() => {
        this.pendingRewards--;
      });
    super.distributeRewards(rewards);
  }

  submitTx(tx: Transaction): Promise<TxHash> {
    const slot = this.slot;
    return this.enqueue(async () => {
      const next = await this.request({
        operation: "submit",
        state: this.snapshot.state,
        chain: this.snapshot.chain,
        slot,
        cbor: tx,
      });
      if (!next.txHash)
        throw new Error("convex-mockchain did not return a transaction hash");
      this.applySnapshot(next);
      this.transactionHistory[next.txHash] = { status: "pending" };
      return next.txHash;
    });
  }

  async evaluateTx(
    tx: Transaction,
    additionalUTxOs: UTxO[] = [],
  ): Promise<EvalRedeemer[]> {
    const chain = await this.getChainContext();
    const known = new Map<string, UTxO>();
    for (const { utxo, spent } of [
      ...Object.values(this.ledger),
      ...Object.values(this.mempool),
    ])
      if (!spent) known.set(utxo.txHash + utxo.outputIndex, utxo);
    for (const utxo of additionalUTxOs)
      known.set(utxo.txHash + utxo.outputIndex, utxo);
    const changeAddress = credentialToAddress("Custom", {
      type: "Key",
      hash: "00".repeat(28),
    });
    const response = (await this.runtime.run({
      action: "evaluateV2",
      chain,
      blocks: [],
      wallet: { changeAddress, utxos: [] },
      resolvedInputs: [...known.values()].map(encodeUtxo),
      cbor: tx,
    })) as {
      ok?: boolean;
      error?: unknown;
      exUnits?: Array<{
        purpose: { tag: EvalRedeemer["redeemer_tag"]; index: number };
        mem: number;
        steps: number;
      }>;
    };
    if (!response?.ok || !response.exUnits)
      throw new Error(`sc-tools evaluation failed: ${String(response?.error)}`);
    return response.exUnits.map(({ purpose, mem, steps }) => ({
      redeemer_tag: purpose.tag,
      redeemer_index: purpose.index,
      ex_units: { mem, steps },
    }));
  }
}
