import { protocolOverrides } from "./context.js";
import { CML } from "../core.js";
import { Emulator, type EmulatorAccount } from "@lucid-evolution/provider";
import type {
  Address,
  Credential,
  DatumHash,
  EvalRedeemer,
  Lovelace,
  OutRef,
  ProtocolParameters,
  RewardAddress,
  RewardAccountState,
  Transaction,
  TransactionStatusOptions,
  TxHash,
  Unit,
  UTxO,
} from "@lucid-evolution/core-types";
import {
  coreToTxOutput,
  PROTOCOL_PARAMETERS_DEFAULT,
  utxoToCore,
} from "@lucid-evolution/utils";
import { withCMLScope } from "@lucid-evolution/core-utils";
import type {
  ScToolsBalancer,
  ScToolsChainContext,
  ScToolsRuntime,
} from "./types.js";

type Snapshot = {
  ok: true;
  state: Record<string, unknown>;
  chain: ScToolsChainContext;
  utxos: Array<{ input: string; cbor: string }>;
  datums: Array<{ hash: string; cbor: string }>;
  accounts: Array<{ address: string; rewards: string; poolId: string | null }>;
  treasury: string;
  txHash?: string;
  registered?: boolean;
  rewards?: string;
  poolId?: string | null;
};

export type ScToolsEmulatorOptions = {
  /** Pools present at genesis, with zero deposit and default mockchain pool data. */
  stakePools?: string[];
};

const encodeUtxo = (utxo: UTxO) =>
  withCMLScope((own) => own(utxoToCore(utxo)).to_cbor_hex());

/**
 * Emulator's clock, accounts, queries, and pending/confirmed transaction API,
 * backed by the actual convex-mockchain Conway ledger in WASM.
 * The first three constructor arguments are identical to Emulator's.
 */
export class ScToolsEmulator extends Emulator {
  readonly balancer: ScToolsBalancer;
  private readonly runtime: ScToolsRuntime;
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
    runtime: ScToolsRuntime,
    options: ScToolsEmulatorOptions = {},
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
        const utxo: UTxO = withCMLScope((own) => ({
          txHash,
          outputIndex: Number(index),
          ...coreToTxOutput(own(CML.TransactionOutput.from_cbor_hex(cbor))),
        }));
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

  async getChainContext(): Promise<ScToolsChainContext> {
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

  override submitTx(tx: Transaction): Promise<TxHash> {
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

  override async evaluateTx(
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
    const changeAddress = withCMLScope((own) => {
      const hash = own(CML.Ed25519KeyHash.from_hex("00".repeat(28)));
      const credential = own(CML.Credential.new_pub_key(hash));
      const enterprise = own(CML.EnterpriseAddress.new(0, credential));
      return own(enterprise.to_address()).to_bech32(undefined);
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
