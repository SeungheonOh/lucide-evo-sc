import type {
  Address,
  Delegation,
  Network,
  Payload,
  PrivateKey,
  Provider,
  RewardAddress,
  SignedMessage,
  Transaction,
  TxHash,
  UTxO,
  Wallet,
  WalletApi,
} from "@lucid-evolution/core-types";
import { ledger, decodeCbor, encodeCbor } from "@lucid-evolution/ledger";
import {
  coreToUtxo,
  credentialToAddress,
  credentialToRewardAddress,
  getAddressDetails,
  isEqualUTxO,
  utxoToCore,
} from "@lucid-evolution/utils";
import { signData } from "@lucid-evolution/sign_data";
import { discoverOwnUsedTxKeyHashes, walletFromSeed } from "./wallet.js";

const submitTxsSequentially = async (
  txs: Transaction[],
  submit: (tx: Transaction) => Promise<TxHash>,
): Promise<TxHash[]> => {
  const results: unknown[] = [];
  let failed = false;
  for (const tx of txs) {
    try {
      results.push(await submit(tx));
    } catch (error) {
      results.push(error);
      failed = true;
    }
  }
  if (failed) throw results;
  return results as TxHash[];
};

const mapSequentially = async <A, B>(
  values: A[],
  f: (value: A) => Promise<B>,
): Promise<B[]> => {
  const result: B[] = [];
  for (const value of values) result.push(await f(value));
  return result;
};

function walletState(
  provider: Provider,
  address: Address,
  rewardAddress: RewardAddress | null,
  initial?: UTxO[],
) {
  let override = initial;
  const getUtxos = async () =>
    override === undefined ? provider.getUtxos(address) : override;
  return {
    overrideUTxOs: (utxos: UTxO[]) => {
      override = utxos;
    },
    clearUTxOOverride: () => {
      override = undefined;
    },
    address: async () => address,
    rewardAddress: async () => rewardAddress,
    getUtxos,
    getUtxosCore: async () => (await getUtxos()).map(utxoToCore),
    getDelegation: async (): Promise<Delegation> =>
      rewardAddress
        ? provider.getDelegation(rewardAddress)
        : { poolId: null, rewards: 0n },
    submitTx: (tx: Transaction) => provider.submitTx(tx),
    submitTxs: (txs: Transaction[]) =>
      submitTxsSequentially(txs, (tx) => provider.submitTx(tx)),
  };
}

export const makeWalletFromSeed = (
  provider: Provider,
  network: Network,
  seed: string,
  options?: {
    addressType?: "Base" | "Enterprise";
    accountIndex?: number;
    password?: string;
  },
): Wallet => {
  const { address, rewardAddress, paymentKey, stakeKey } = walletFromSeed(
    seed,
    { ...options, network },
  );
  const state = walletState(provider, address, rewardAddress);
  const keys = new Map<string, string>();
  for (const privateKey of [paymentKey, stakeKey])
    if (privateKey)
      keys.set(
        ledger<{ keyHash: string }>("key.fromPrivate", { privateKey }).keyHash,
        privateKey,
      );
  const signTx = async (cbor: Transaction): Promise<string> => {
    const required = discoverOwnUsedTxKeyHashes(
      cbor,
      [...keys.keys()],
      await state.getUtxos(),
    );
    return ledger("tx.sign", {
      cbor,
      privateKeys: required.map((hash) => keys.get(hash)!),
    });
  };
  return {
    ...state,
    signTx,
    signTxs: (txs) => mapSequentially(txs, signTx),
    signMessage: async (address, payload) => {
      const details = getAddressDetails(address);
      const hash =
        details.paymentCredential?.hash ?? details.stakeCredential?.hash;
      const privateKey = hash && keys.get(hash);
      if (!privateKey)
        throw new Error(`Cannot sign message for address: ${address}.`);
      return signData(details.address.hex, payload, privateKey);
    },
  };
};

export const makeWalletFromPrivateKey = (
  provider: Provider,
  network: Network,
  privateKey: PrivateKey,
): Wallet => {
  const { keyHash } = ledger<{ keyHash: string }>("key.fromPrivate", {
    privateKey,
  });
  const address = credentialToAddress(network, { type: "Key", hash: keyHash });
  const state = walletState(provider, address, null);
  const signTx = async (cbor: Transaction): Promise<string> =>
    ledger("tx.sign", { cbor, privateKeys: [privateKey] });
  return {
    ...state,
    signTx,
    signTxs: (txs) => mapSequentially(txs, signTx),
    signMessage: async (address, payload) => {
      const details = getAddressDetails(address);
      if (details.paymentCredential?.hash !== keyHash)
        throw new Error(`Cannot sign message for address: ${address}.`);
      return signData(details.address.hex, payload, privateKey);
    },
  };
};

export const makeWalletFromAPI = (
  provider: Provider,
  api: WalletApi,
): Wallet => {
  let override: UTxO[] | undefined;
  const address = async () => {
    const [used] = await api.getUsedAddresses();
    const raw = used ?? (await api.getUnusedAddresses())[0];
    return getAddressDetails(raw).address.bech32;
  };
  const rewardAddress = async () => {
    const [raw] = await api.getRewardAddresses();
    return raw ? getAddressDetails(raw).address.bech32 : null;
  };
  const signTx = async (tx: Transaction) => {
    const witnesses = await api.signTx(tx, true);
    decodeCbor(witnesses);
    return witnesses;
  };
  return {
    overrideUTxOs: (utxos) => {
      override = utxos;
    },
    clearUTxOOverride: () => {
      override = undefined;
    },
    address,
    rewardAddress,
    getUtxos: async () =>
      override ?? ((await api.getUtxos()) ?? []).map(coreToUtxo),
    getUtxosCore: async () =>
      override ? override.map(utxoToCore) : ((await api.getUtxos()) ?? []),
    ...(typeof api.getCollateral !== "function"
      ? {}
      : {
          getCollateral: async (amount?: bigint) => {
            const params =
              amount === undefined ? undefined : { amount: encodeCbor(amount) };
            const candidates = ((await api.getCollateral!(params)) ?? []).map(
              coreToUtxo,
            );
            return override === undefined
              ? candidates
              : candidates.filter((candidate) =>
                  override!.some((utxo) => isEqualUTxO(utxo, candidate)),
                );
          },
        }),
    getDelegation: async () => {
      const reward = await rewardAddress();
      return reward
        ? provider.getDelegation(reward)
        : { poolId: null, rewards: 0n };
    },
    signTx,
    signTxs: async (txs) => {
      const batch =
        api.cip103?.signTxs?.bind(api.cip103) ??
        api.experimental?.signTxs?.bind(api.experimental) ??
        api.signTxs?.bind(api);
      const witnesses = batch
        ? await batch(txs.map((cbor) => ({ cbor, partialSign: true })))
        : await mapSequentially(txs, signTx);
      if (witnesses.length !== txs.length)
        throw new Error(
          "Wallet returned an unexpected number of witness sets.",
        );
      witnesses.forEach(decodeCbor);
      return witnesses;
    },
    signMessage: (address, payload) =>
      api.signData(getAddressDetails(address).address.hex, payload),
    submitTx: (tx) => api.submitTx(tx),
    submitTxs: async (txs) => {
      const batch = api.cip103?.submitTxs?.bind(api.cip103);
      const hashes = batch
        ? await batch(txs)
        : await submitTxsSequentially(txs, (tx) => api.submitTx(tx));
      if (hashes.length !== txs.length)
        throw new Error(
          "Wallet returned an unexpected number of transaction hashes.",
        );
      return hashes;
    },
  };
};

export const makeWalletFromAddress = (
  provider: Provider,
  network: Network,
  address: Address,
  utxos: UTxO[],
): Wallet => {
  const stake = getAddressDetails(address).stakeCredential;
  const reward = stake ? credentialToRewardAddress(network, stake) : null;
  return {
    ...walletState(provider, address, reward, utxos),
    signTx: async () => {
      throw new Error("Not implemented");
    },
    signTxs: async () => {
      throw new Error("Not implemented");
    },
    signMessage: async () => {
      throw new Error("Not implemented");
    },
  };
};
