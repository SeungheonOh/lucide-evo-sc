/** Native values crossing the generic CBOR bridge. Integer values decode to bigint. */
export type CborValue =
  | null
  | boolean
  | bigint
  | number
  | string
  | Uint8Array
  | CborValue[]
  | Map<CborValue, CborValue>
  | CborTag;
export class CborTag {
  constructor(
    readonly tag: bigint,
    readonly value: CborValue,
  ) {}
}
export type LedgerScript = {
  type: "Native" | "PlutusV1" | "PlutusV2" | "PlutusV3";
  script: string;
};
export type LedgerOutRef = { txHash: string; outputIndex: number };
export type LedgerOutput = {
  address: string;
  assets: Record<string, bigint>;
  datumHash?: string | null;
  datum?: string | null;
  scriptRef?: LedgerScript | null;
};
export type LedgerRedeemer = {
  tag: "spend" | "mint" | "publish" | "withdraw" | "vote" | "propose";
  index: bigint;
  data: string;
  exUnits: { mem: bigint; steps: bigint };
};
export type TransactionBodySnapshot = {
  cbor: string;
  inputs: LedgerOutRef[];
  referenceInputs: LedgerOutRef[];
  collateralInputs: LedgerOutRef[];
  outputs: LedgerOutput[];
  fee: bigint;
  mint: Record<string, bigint>;
  withdrawals: { rewardAddress: string; amount: bigint }[];
  certificates: CborValue[];
  votes: CborValue | undefined;
  proposals: CborValue[];
  requiredSigners: string[];
  validFrom?: bigint;
  validUntil?: bigint;
  collateralReturn?: LedgerOutput;
  totalCollateral?: bigint;
  treasuryDonation?: bigint;
  currentTreasury?: bigint;
  auxiliaryDataHash?: string;
  scriptDataHash?: string;
  networkId?: number;
  /** Decoded ledger fields; use cbor for the original committed encoding. */
  fields: Map<CborValue, CborValue>;
};
export type TransactionSnapshot = {
  cbor: string;
  canonicalCbor?: string;
  bodyCbor: string;
  hash: string;
  body: TransactionBodySnapshot;
  redeemers: LedgerRedeemer[];
  datums?: { hash: string; cbor: string }[];
  witnesses: Map<CborValue, CborValue>;
  auxiliaryData: CborValue;
  isValid: boolean;
};
export interface LedgerRuntime {
  run(payload: Record<string, unknown>): Promise<unknown>;
  runSync(payload: Record<string, unknown>): unknown;
}
