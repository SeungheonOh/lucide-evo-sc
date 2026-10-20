import type { Assets, PolicyId, UTxO, Unit } from "@lucid-evolution/core-types";
import { fromHex, toHex } from "@lucid-evolution/core-utils";
import { fromLabel, toLabel } from "./label.js";
import { pipe } from "effect/Function";
import {
  asBytes,
  asInteger,
  asList,
  asMap,
  decodeTerm,
  encodeTerm,
  integer,
  type CborTerm,
} from "./ledger-cbor.js";

export function valueToAssets(cbor: string): Assets {
  const value = decodeTerm(cbor);
  if (value && typeof value === "object" && "int" in value)
    return { lovelace: BigInt(value.int) };
  const [coin, policies] = asList(value);
  const assets: Assets = { lovelace: asInteger(coin) };
  for (const [policy, names] of asMap(policies))
    for (const [name, amount] of asMap(names))
      assets[asBytes(policy) + asBytes(name)] = asInteger(amount);
  return assets;
}

export function assetsToValue(assets: Assets): string {
  const policies = new Map<string, [CborTerm, CborTerm][]>();
  for (const [unit, amount] of Object.entries(assets)) {
    if (unit === "lovelace") continue;
    const policy = unit.slice(0, 56);
    const names = policies.get(policy) ?? [];
    names.push([{ bytes: unit.slice(56) }, integer(amount)]);
    policies.set(policy, names);
  }
  const coin = integer(assets.lovelace ?? 0n);
  return encodeTerm(
    policies.size
      ? {
          list: [
            coin,
            {
              map: [...policies].map(([policy, names]) => [
                { bytes: policy },
                { map: names },
              ]),
            },
          ],
        }
      : coin,
  );
}

/**
 * Splits unit into policy id, asset name (entire asset name), name (asset name without label) and label if applicable.
 * name will be returned in Hex.
 */
export function fromUnit(unit: Unit): {
  policyId: PolicyId;
  assetName: string | null;
  name: string | null;
  label: number | null;
} {
  const policyId = unit.slice(0, 56);
  const assetName = unit.slice(56) || null;
  const label = fromLabel(unit.slice(56, 64));
  const name = (() => {
    const hexName = Number.isInteger(label) ? unit.slice(64) : unit.slice(56);
    return hexName || null;
  })();
  return { policyId, assetName, name, label };
}

/**
 * @param name Hex encoded
 */
export function toUnit(
  policyId: PolicyId,
  name?: string | null,
  label?: number | null,
): Unit {
  const hexLabel = Number.isInteger(label) ? toLabel(label!) : "";
  const n = name ? name : "";
  if ((n + hexLabel).length > 64) {
    throw new Error("Asset name size exceeds 32 bytes.");
  }
  if (policyId.length !== 56) {
    throw new Error(`Policy id invalid: ${policyId}.`);
  }
  return policyId + hexLabel + n;
}

export function addAssets(...assets: Assets[]): Assets {
  return assets.reduce((a, b) => {
    for (const k in b) {
      if (Object.hasOwn(b, k)) {
        const sum = (a[k] || 0n) + b[k];
        if (sum === 0n) {
          delete a[k];
        } else {
          a[k] = sum;
        }
      }
    }
    return a;
  }, {});
}

/**
 * Returns a unique token name which is SHA3-256 hash of UTxO's txid and idx
 * @param utxo UTxO whose OutRef will be used
 */
export async function getUniqueTokenName(utxo: UTxO): Promise<string> {
  const id = fromHex(utxo.txHash);
  const data = new Uint8Array([utxo.outputIndex, ...id]);

  const hash = new Uint8Array(await crypto.subtle.digest("SHA3-256", data));

  return toHex(hash);
}

/**
 *
 * Sort Assets following [RFC 7049 Section 3.9](https://datatracker.ietf.org/doc/html/rfc7049#section-3.9) sorting rules
 */
export const sortCanonical = (assets: Assets): Assets =>
  pipe(
    Object.entries(assets).sort(([aUnit], [bUnit]) => {
      const a = fromUnit(aUnit);
      const b = fromUnit(bUnit);
      // Compare policy lengths
      // NOTE: all policies have the same length, because they must be 28 bytes
      // but because Lovelace is in the assets we must compare the length
      if (a.policyId.length !== b.policyId.length)
        return a.policyId.length - b.policyId.length;
      // If policy IDs are the same, compare asset names length
      if (a.policyId === b.policyId) {
        const aAssetName = a.assetName || "";
        const bAssetName = b.assetName || "";
        if (aAssetName.length !== bAssetName.length)
          return aAssetName.length - bAssetName.length;
        // If asset names have same length but are different, compare them lexicographically
        return aAssetName.localeCompare(bAssetName);
      }
      // If policy IDs have same length but are different, compare them lexicographically
      return a.policyId.localeCompare(b.policyId);
    }),
    Object.fromEntries,
  );
