import { describe, expect, test } from "vitest";
import { FastCheck } from "effect";
import { toHex, fromHex } from "@lucid-evolution/core-utils";
import {
  ledger,
  decodeCbor,
  encodeCbor,
  CborTag,
  type CborValue,
} from "@lucid-evolution/ledger";
import { canonicalTransactionHex } from "../src/CanonicalTransaction.js";

/*
  canonicalTransaction normalizes uncommitted transaction containers while
  preserving hashed bytes and ordered Plutus data. These tests check that
  contract on random transactions whose CBOR uses
  non-canonical encodings throughout: indefinite lengths, oversized integer
  heads, chunked byte strings, sets with and without tag 258, unsorted maps
  and Plutus data that canonical encoding would reorder.
*/

// ---------------------------------------------------------------------------
// A CBOR writer that controls every encoding choice.

type Item =
  | { uint: bigint; size?: number }
  | { nint: bigint; size?: number }
  | { bytes: Uint8Array; chunks?: number[] }
  | { text: string }
  | { array: Item[]; indefinite?: boolean; size?: number }
  | { map: [Item, Item][]; indefinite?: boolean; size?: number }
  | { tag: bigint; item: Item; size?: number }
  | { simple: "true" | "false" | "null" }
  // Plutus data or a datum option, which canonicalTransaction keeps as they
  // are: written as generated, or as `canonical` re-encodes them.
  | { kept: Item; canonical: (cbor: Uint8Array) => Uint8Array }
  // A byte string holding the CBOR of an item, as tag 24 wraps it.
  | { embedded: Item };

/** Head bytes; `size` forces a longer argument than needed (0, 1, 2, 4, 8). */
const head = (major: number, value: bigint, size?: number): number[] => {
  const minimal =
    value < 24n
      ? 0
      : value < 256n
        ? 1
        : value < 65536n
          ? 2
          : value < 2n ** 32n
            ? 4
            : 8;
  const width = Math.max(minimal, size ?? 0);
  if (width === 0) return [(major << 5) | Number(value)];
  const info = 24 + Math.log2(width);
  const out = [(major << 5) | info];
  for (let i = width - 1; i >= 0; i--) {
    out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  }
  return out;
};

const encodeItem = (
  item: Item,
  out: number[],
  canonicalKept: boolean,
): void => {
  const encodeChild = (child: Item) => encodeItem(child, out, canonicalKept);
  if ("uint" in item) out.push(...head(0, item.uint, item.size));
  else if ("nint" in item) out.push(...head(1, -1n - item.nint, item.size));
  else if ("bytes" in item) {
    if (!item.chunks) {
      out.push(...head(2, BigInt(item.bytes.length)));
      out.push(...item.bytes);
    } else {
      out.push(0x5f);
      let offset = 0;
      for (const length of item.chunks) {
        out.push(...head(2, BigInt(length)));
        out.push(...item.bytes.subarray(offset, offset + length));
        offset += length;
      }
      out.push(0xff);
    }
  } else if ("text" in item) {
    const bytes = new TextEncoder().encode(item.text);
    out.push(...head(3, BigInt(bytes.length)), ...bytes);
  } else if ("array" in item) {
    if (item.indefinite) out.push(0x9f);
    else out.push(...head(4, BigInt(item.array.length), item.size));
    item.array.forEach(encodeChild);
    if (item.indefinite) out.push(0xff);
  } else if ("map" in item) {
    if (item.indefinite) out.push(0xbf);
    else out.push(...head(5, BigInt(item.map.length), item.size));
    item.map.forEach(([key, value]) => {
      encodeChild(key);
      encodeChild(value);
    });
    if (item.indefinite) out.push(0xff);
  } else if ("tag" in item) {
    out.push(...head(6, item.tag, item.size));
    encodeChild(item.item);
  } else if ("kept" in item) {
    const cbor = encode(item.kept);
    out.push(...(canonicalKept ? item.canonical(cbor) : cbor));
  } else if ("embedded" in item) {
    const cbor = encode(item.embedded, canonicalKept);
    out.push(...head(2, BigInt(cbor.length)), ...cbor);
  } else {
    out.push({ false: 0xf4, true: 0xf5, null: 0xf6 }[item.simple]);
  }
};

const encode = (item: Item, canonicalKept = false): Uint8Array => {
  const out: number[] = [];
  encodeItem(item, out, canonicalKept);
  return Uint8Array.from(out);
};

const canonicalCbor = (cbor: Uint8Array): Uint8Array =>
  fromHex(ledger<string>("cbor.canonical", { cbor: toHex(cbor) }));
// Plutus bounds each byte-string chunk at 64 bytes, including canonical data.
const canonicalPlutus = (cbor: Uint8Array): Uint8Array => {
  const canonical = canonicalCbor(cbor);
  const rewrite = (node: Span): number[] => {
    if (node.major === 2 && node.value > 64n) {
      const payload = canonical.subarray(
        node.start + readHead(canonical, node.start).size,
        node.end,
      );
      const out = [0x5f];
      for (let at = 0; at < payload.length; at += 64) {
        const chunk = payload.subarray(at, at + 64);
        out.push(...head(2, BigInt(chunk.length)), ...chunk);
      }
      return [...out, 0xff];
    }
    if (node.major === 5) {
      const entries: [number[], number[]][] = [];
      for (let i = 0; i < node.children.length; i += 2)
        entries.push([
          rewrite(node.children[i]),
          rewrite(node.children[i + 1]),
        ]);
      // Chunking changes encoded key lengths, so Plutus map ordering must be
      // computed after recursively encoding each key with its 64-byte bound.
      entries.sort(([a], [b]) => {
        if (a.length !== b.length) return a.length - b.length;
        for (let i = 0; i < a.length; i++)
          if (a[i] !== b[i]) return a[i] - b[i];
        return 0;
      });
      return [...head(5, BigInt(entries.length)), ...entries.flat(2)];
    }
    if (node.children.length)
      return [
        ...canonical.subarray(
          node.start,
          node.start + readHead(canonical, node.start).size,
        ),
        ...node.children.flatMap(rewrite),
      ];
    return [...raw(canonical, node)];
  };
  return Uint8Array.from(rewrite(span(canonical, 0)));
};
const canonicalMeaning = (cbor: Uint8Array): Uint8Array => {
  const normalize = (value: CborValue): CborValue => {
    if (value instanceof CborTag) {
      return value.tag === 24n && value.value instanceof Uint8Array
        ? new CborTag(24n, canonicalMeaning(value.value))
        : new CborTag(value.tag, normalize(value.value));
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value instanceof Map)
      return new Map(
        [...value].map(([key, item]) => [normalize(key), normalize(item)]),
      );
    return value;
  };
  return fromHex(encodeCbor(normalize(decodeCbor(toHex(cbor))), true));
};
const keptPlutusData = (item: Item): Item => ({
  kept: item,
  canonical: canonicalPlutus,
});
const keptDatumOption = (item: Item): Item => ({
  kept: item,
  canonical: (cbor) => {
    const option = decodeCbor(toHex(cbor)) as CborValue[];
    if (option[0] === 1n) {
      const wrapped = option[1] as CborTag;
      option[1] = new CborTag(
        24n,
        canonicalPlutus(wrapped.value as Uint8Array),
      );
    }
    return fromHex(encodeCbor(option, true));
  },
});

// ---------------------------------------------------------------------------
// Random transactions, every choice drawn from fast-check.

const randomTransaction = (g: FastCheck.GeneratorValue): Item => {
  const int = (n: number) => g(FastCheck.nat, { max: n - 1 });
  const chance = (p: number) => int(100) < p * 100;
  const pick = <T>(values: T[]): T => values[int(values.length)];
  const randomBytes = (length: number) =>
    g(FastCheck.uint8Array, { minLength: length, maxLength: length });
  const shuffle = <T>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const sizeFor = () => (chance(0.15) ? pick([1, 2, 4, 8]) : undefined);
  const uint = (value: bigint | number): Item => ({
    uint: BigInt(value),
    size: sizeFor(),
  });
  const bytes = (value: Uint8Array): Item => {
    if (value.length > 1 && chance(0.15)) {
      const cut = 1 + int(value.length - 1);
      return { bytes: value, chunks: [cut, value.length - cut] };
    }
    return { bytes: value };
  };
  const array = (items: Item[]): Item =>
    chance(0.2)
      ? { array: items, indefinite: true }
      : { array: items, size: sizeFor() };
  const map = (entries: [Item, Item][]): Item =>
    chance(0.2)
      ? { map: entries, indefinite: true }
      : { map: entries, size: sizeFor() };
  /** Sets with and without tag 258; ledger sets keep their elements unique. */
  const set = (items: Item[]): Item =>
    chance(0.5)
      ? { tag: 258n, item: array(items), size: sizeFor() }
      : array(items);
  const many = <T>(min: number, max: number, make: () => T): T[] =>
    Array.from({ length: min + int(max - min + 1) }, make);

  const plutusData = (depth = 0): Item => {
    const leaf = depth > 3 || chance(0.4);
    switch (leaf ? pick([3, 4]) : int(5)) {
      case 0: {
        const alternative = int(140);
        const fields = array(many(0, 3, () => plutusData(depth + 1)));
        if (alternative < 7)
          return { tag: 121n + BigInt(alternative), item: fields };
        if (alternative < 128 && chance(0.7)) {
          return { tag: 1280n + BigInt(alternative - 7), item: fields };
        }
        return { tag: 102n, item: array([uint(alternative), fields]) };
      }
      case 1:
        // Keys out of canonical order, and occasionally repeated.
        return map(
          many(0, 4, () => [plutusData(depth + 1), plutusData(depth + 1)]),
        );
      case 2:
        return array(many(0, 4, () => plutusData(depth + 1)));
      case 3: {
        const r = int(6);
        if (r === 0) return { nint: -1n - BigInt(int(1000)), size: sizeFor() };
        if (r === 1) {
          // A bignum.
          return {
            tag: pick([2n, 3n]),
            item: {
              bytes: Uint8Array.of(1 + int(255), ...randomBytes(8 + int(4))),
            },
          };
        }
        return uint(int(r === 2 ? 2 ** 31 : 30));
      }
      default: {
        const length = pick([0, 3, 28, 32, 64, 70, 130]);
        const value = randomBytes(length);
        if (length > 64) {
          // Byte strings over 64 bytes must be chunked.
          const chunks: number[] = [];
          for (let left = length; left > 0; left -= 64)
            chunks.push(Math.min(64, left));
          return { bytes: value, chunks };
        }
        return bytes(value);
      }
    }
  };

  const keyHash = () => bytes(randomBytes(28));
  const txHash = () => bytes(randomBytes(32));
  const input = (): Item => array([txHash(), uint(int(4))]);
  const inputs = (min: number) => set(many(min, 3, input));
  const address = (): Item =>
    chance(0.5)
      ? bytes(Uint8Array.of(pick([0x60, 0x61, 0x70, 0x71]), ...randomBytes(28)))
      : bytes(
          Uint8Array.of(pick([0x00, 0x01, 0x10, 0x31]), ...randomBytes(56)),
        );
  const multiAsset = (amount: () => Item): Item =>
    map(
      many(1, 2, () => [
        bytes(randomBytes(28)),
        map(many(1, 3, () => [bytes(randomBytes(int(33))), amount()])),
      ]),
    );
  const value = (): Item =>
    chance(0.5)
      ? uint(1_000_000 + int(10_000_000))
      : array([
          uint(1_000_000 + int(10_000_000)),
          multiAsset(() => uint(1 + int(1000))),
        ]);
  const nativeScript = (depth = 0): Item =>
    depth > 1 || chance(0.6)
      ? array([uint(0), keyHash()])
      : array([
          uint(pick([1, 2])),
          array(many(0, 2, () => nativeScript(depth + 1))),
        ]);
  const scriptRef = (): Item => {
    const script = chance(0.3)
      ? array([uint(0), nativeScript()])
      : array([uint(1 + int(3)), bytes(randomBytes(10 + int(40)))]);
    return { tag: 24n, item: { embedded: script } };
  };
  const datumOption = (): Item =>
    keptDatumOption(
      chance(0.3)
        ? array([uint(0), txHash()])
        : array([uint(1), { tag: 24n, item: { embedded: plutusData() } }]),
    );
  const output = (): Item => {
    const address_ = address();
    if (chance(0.3)) {
      return array(
        chance(0.5) ? [address_, value()] : [address_, value(), txHash()],
      );
    }
    const entries: [Item, Item][] = [
      [uint(0), address_],
      [uint(1), value()],
    ];
    if (chance(0.7)) entries.push([uint(2), datumOption()]);
    if (chance(0.3)) entries.push([uint(3), scriptRef()]);
    return map(entries);
  };
  const rewardAccount = () =>
    bytes(Uint8Array.of(pick([0xe0, 0xe1, 0xf0, 0xf1]), ...randomBytes(28)));
  const anchor = (): Item =>
    array([{ text: "https://example.com/" + int(100) }, txHash()]);
  const certificate = (): Item =>
    pick([
      () => array([uint(0), array([uint(0), keyHash()])]),
      () => array([uint(1), array([uint(int(2)), keyHash()])]),
      () => array([uint(2), array([uint(0), keyHash()]), keyHash()]),
    ])();
  const votingProcedures = (): Item =>
    map(
      many(1, 2, () => [
        array([uint(int(5)), keyHash()]),
        map(
          many(1, 2, () => [
            array([txHash(), uint(int(3))]),
            array([uint(int(3)), chance(0.5) ? { simple: "null" } : anchor()]),
          ]),
        ),
      ]),
    );
  const proposal = (): Item =>
    array([uint(100_000_000_000), rewardAccount(), array([uint(6)]), anchor()]);

  const body = (): Item => {
    const entries: [Item, Item][] = [
      [uint(0), inputs(1)],
      [uint(1), array(many(1, 4, output))],
      [uint(2), uint(150_000 + int(500_000))],
    ];
    const optional: [number, () => Item][] = [
      [3, () => uint(int(10_000_000))],
      [4, () => set(many(1, 2, certificate))],
      [5, () => map(many(1, 2, () => [rewardAccount(), uint(int(1_000_000))]))],
      [7, txHash],
      [8, () => uint(int(10_000_000))],
      [
        9,
        () =>
          multiAsset(() =>
            chance(0.3) ? { nint: -1n - BigInt(int(50)) } : uint(1 + int(50)),
          ),
      ],
      [11, txHash],
      [13, () => inputs(1)],
      [14, () => set(many(1, 3, keyHash))],
      [15, () => uint(int(2))],
      [16, output],
      [17, () => uint(int(10_000_000))],
      [18, () => inputs(1)],
      [19, votingProcedures],
      [20, () => set(many(1, 2, proposal))],
      [21, () => uint(int(10_000_000))],
      [22, () => uint(1 + int(10_000_000))],
    ];
    for (const [key, make] of optional) {
      if (chance(0.35)) entries.push([uint(key), make()]);
    }
    // Fields in a random order.
    return map(chance(0.3) ? shuffle(entries) : entries);
  };

  const exUnits = () =>
    array([uint(int(14_000_000)), uint(int(10_000_000_000))]);
  const redeemers = (): Item => {
    const keys = new Set<string>();
    const unique = many(1, 4, () => [int(6), int(4)] as const).filter(
      ([tag, index]) => {
        const key = `${tag}:${index}`;
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      },
    );
    if (chance(0.5)) {
      return array(
        unique.map(([tag, index]) =>
          array([
            uint(tag),
            uint(index),
            keptPlutusData(plutusData()),
            exUnits(),
          ]),
        ),
      );
    }
    return map(
      unique.map(([tag, index]) => [
        array([uint(tag), uint(index)]),
        array([keptPlutusData(plutusData()), exUnits()]),
      ]),
    );
  };

  const witnessSet = (): Item => {
    const entries: [Item, Item][] = [];
    if (chance(0.3))
      entries.push([uint(1), set(many(1, 2, () => nativeScript()))]);
    for (const key of [3, 6, 7]) {
      if (chance(0.25)) {
        entries.push([
          uint(key),
          set(many(1, 2, () => bytes(randomBytes(10 + int(30))))),
        ]);
      }
    }
    if (chance(0.6)) {
      entries.push([
        uint(4),
        set(many(1, 3, () => keptPlutusData(plutusData()))),
      ]);
    }
    if (chance(0.7)) entries.push([uint(5), redeemers()]);
    return map(chance(0.3) ? shuffle(entries) : entries);
  };

  const metadatum = (depth = 0): Item =>
    depth > 1 || chance(0.5)
      ? pick([
          () => uint(int(1000)),
          () => ({ text: "m" + int(100) }),
          () => bytes(randomBytes(int(8))),
        ])()
      : chance(0.5)
        ? array(many(0, 3, () => metadatum(depth + 1)))
        : map(many(0, 3, () => [metadatum(depth + 1), metadatum(depth + 1)]));

  const transaction = (): Item =>
    array([
      body(),
      witnessSet(),
      { simple: chance(0.9) ? "true" : "false" },
      chance(0.3)
        ? map(many(1, 3, () => [uint(int(1000)), metadatum()]))
        : { simple: "null" },
    ]);

  return transaction();
};

// ---------------------------------------------------------------------------
// What canonicalTransaction keeps from the original.

/** The major type, additional info, argument and size of the head at `at`. */
const readHead = (cbor: Uint8Array, at: number) => {
  const major = cbor[at] >> 5;
  const info = cbor[at] & 31;
  if (info < 24 || info === 31) {
    return { major, info, value: BigInt(info), size: 1 };
  }
  const bytes = 2 ** (info - 24);
  let value = 0n;
  for (let i = 1; i <= bytes; i++) value = (value << 8n) | BigInt(cbor[at + i]);
  return { major, info, value, size: 1 + bytes };
};

/**
 * Walks the CBOR item at `at` and returns where it ends. Its bytes, but for
 * every tag 258, go to `out`.
 */
const walk = (cbor: Uint8Array, at: number, out: number[] = []): number => {
  const { major, info, value, size } = readHead(cbor, at);
  if (major === 6 && value === 258n) return walk(cbor, at + size, out);
  out.push(...cbor.subarray(at, at + size));
  at += size;
  if (info === 31) {
    // An indefinite-length item, up to its break.
    while (cbor[at] !== 0xff) at = walk(cbor, at, out);
    out.push(cbor[at]);
    return at + 1;
  }
  if (major === 2 || major === 3) {
    out.push(...cbor.subarray(at, at + Number(value)));
    return at + Number(value);
  }
  if (major === 4 || major === 5) {
    const items = major === 4 ? value : 2n * value;
    for (let i = 0n; i < items; i++) at = walk(cbor, at, out);
  } else if (major === 6) {
    at = walk(cbor, at, out);
  }
  return at;
};

/**
 * The CBOR with every tag 258 dropped. The result tags its ledger sets
 * whether or not the original did, which is the one change to the value.
 */
const withoutSetTags = (cbor: Uint8Array): string => {
  const out: number[] = [];
  walk(cbor, 0, out);
  return toHex(Uint8Array.from(out));
};

/**
 * Body fields that are ledger sets: inputs, certificates, collateral inputs,
 * required signers, reference inputs and proposal procedures.
 */
const BODY_SETS = new Set([0n, 4n, 13n, 14n, 18n, 20n]);
const WITNESS_DATUMS = new Set([4n]);

/** For each ledger set in a transaction, whether it has tag 258. */
const ledgerSetTags = (cbor: Uint8Array): boolean[] => {
  const tagged: boolean[] = [];
  const fields = (at: number, sets: Set<bigint>): number => {
    const map = readHead(cbor, at);
    at += map.size;
    for (let i = 0n; map.info === 31 ? cbor[at] !== 0xff : i < map.value; i++) {
      const key = readHead(cbor, at);
      at = walk(cbor, at);
      if (sets.has(key.value)) {
        const value = readHead(cbor, at);
        tagged.push(value.major === 6 && value.value === 258n);
      }
      at = walk(cbor, at);
    }
    return map.info === 31 ? at + 1 : at;
  };
  fields(
    fields(readHead(cbor, 0).size, BODY_SETS),
    hasCommittedScriptData(cbor) ? new Set() : WITNESS_DATUMS,
  );
  return tagged;
};

type Span = {
  start: number;
  end: number;
  major: number;
  value: bigint;
  children: Span[];
};
/** Independent byte-level inspection keeps deliberately noncanonical fixtures intact. */
const span = (cbor: Uint8Array, start: number): Span => {
  const h = readHead(cbor, start);
  const children: Span[] = [];
  let at = start + h.size;
  if (h.major === 6 || h.major === 4 || h.major === 5 || h.info === 31) {
    const count = h.major === 6 ? 1n : h.major === 5 ? h.value * 2n : h.value;
    for (let n = 0n; h.info === 31 ? cbor[at] !== 0xff : n < count; n++) {
      const child = span(cbor, at);
      children.push(child);
      at = child.end;
    }
    if (h.info === 31) at++;
  } else if (h.major === 2 || h.major === 3) at += Number(h.value);
  return { start, end: at, major: h.major, value: h.value, children };
};
const raw = (cbor: Uint8Array, node: Span) =>
  cbor.subarray(node.start, node.end);
const fields = (node: Span): Map<bigint, Span> => {
  const result = new Map<bigint, Span>();
  for (let n = 0; n < node.children.length; n += 2)
    result.set(node.children[n].value, node.children[n + 1]);
  return result;
};
const sequence = (node: Span | undefined): Span[] =>
  node === undefined
    ? []
    : node.major === 6 && node.value === 258n
      ? node.children[0].children
      : node.children;
const hasCommittedScriptData = (cbor: Uint8Array): boolean =>
  fields(span(cbor, 0).children[0]).has(11n);
const committedAuxiliary = (cbor: Uint8Array): string | undefined => {
  const parts = span(cbor, 0).children;
  return fields(parts[0]).has(7n) ? toHex(raw(cbor, parts[3])) : undefined;
};
const committedWitnesses = (cbor: Uint8Array) =>
  new Map(
    [...fields(span(cbor, 0).children[1])]
      .filter(([key]) => key === 4n || key === 5n)
      .map(([key, node]) => [key, toHex(raw(cbor, node))]),
  );
const outputDatums = (cbor: Uint8Array): (string | undefined)[] => {
  const body = fields(span(cbor, 0).children[0]);
  return [
    ...sequence(body.get(1n)),
    ...(body.has(16n) ? [body.get(16n)!] : []),
  ].map((output) => {
    const datum = output.major === 5 ? fields(output).get(2n) : undefined;
    return datum ? toHex(raw(cbor, datum)) : undefined;
  });
};
const witnessDatums = (cbor: Uint8Array): string[] =>
  sequence(fields(span(cbor, 0).children[1]).get(4n)).map((node) =>
    toHex(raw(cbor, node)),
  );
const nativeScripts = (cbor: Uint8Array): string[] =>
  sequence(fields(span(cbor, 0).children[1]).get(1n)).map((node) =>
    toHex(raw(cbor, node)),
  );
// For the full-container canonicality assertion, normalize protected regions
// separately: hashed scripts, committed data and Plutus chunks stay untouched.
const normalizeProtectedRegions = (cbor: Uint8Array): Uint8Array => {
  const parts = span(cbor, 0).children;
  const witness = fields(parts[1]);
  const protectedNodes = hasCommittedScriptData(cbor)
    ? [witness.get(4n), witness.get(5n)].filter(
        (node): node is Span => node !== undefined,
      )
    : sequence(witness.get(4n));
  const redeemer = witness.get(5n);
  if (!hasCommittedScriptData(cbor) && redeemer?.major === 5) {
    for (let i = 1; i < redeemer.children.length; i += 2)
      protectedNodes.push(redeemer.children[i].children[0]);
  } else if (!hasCommittedScriptData(cbor) && redeemer)
    protectedNodes.push(...redeemer.children.map((tuple) => tuple.children[2]));
  protectedNodes.push(...sequence(witness.get(1n)));
  if (committedAuxiliary(cbor) !== undefined) protectedNodes.push(parts[3]);
  const out: number[] = [];
  let at = 0;
  for (const node of protectedNodes.sort((a, b) => a.start - b.start)) {
    out.push(
      ...cbor.subarray(at, node.start),
      ...canonicalCbor(raw(cbor, node)),
    );
    at = node.end;
  }
  out.push(...cbor.subarray(at));
  return Uint8Array.from(out);
};
const orderedValue = (cbor: Uint8Array): string =>
  // Definite/indefinite containers have the same value; map entry order does not.
  // Read the term AST directly so duplicate map keys survive inspection too.
  JSON.stringify(ledger("cbor.decode", { cbor: toHex(cbor) }), (key, value) =>
    key === "indefinite" ? undefined : value,
  );
/** Each redeemer's exact tuple/value CBOR and ordered Plutus value. */
const redeemers = (cbor: Uint8Array) => {
  const result = new Map<
    string,
    { cbor: string; data: string; value: string }
  >();
  const node = fields(span(cbor, 0).children[1]).get(5n);
  if (!node) return result;
  const add = (tag: Span, index: Span, data: Span, tuple: Span) =>
    result.set(`${tag.value}:${index.value}`, {
      cbor: toHex(raw(cbor, tuple)),
      data: toHex(raw(cbor, data)),
      value: orderedValue(raw(cbor, data)),
    });
  if (node.major === 5) {
    for (let i = 0; i < node.children.length; i += 2) {
      const key = node.children[i],
        value = node.children[i + 1];
      add(key.children[0], key.children[1], value.children[0], value);
    }
  } else
    for (const value of node.children)
      add(value.children[0], value.children[1], value.children[2], value);
  return result;
};
const expectedRedeemers = (cbor: Uint8Array) =>
  new Map(
    [...redeemers(cbor)].map(([key, original]) => {
      const tuple = fromHex(original.cbor),
        node = span(tuple, 0);
      const dataIndex = node.children.length === 4 ? 2 : 0;
      const data = canonicalPlutus(fromHex(original.data));
      const canonical = Uint8Array.from([
        ...head(4, BigInt(node.children.length)),
        ...node.children.flatMap((child, index) => [
          ...(index === dataIndex ? data : canonicalCbor(raw(tuple, child))),
        ]),
      ]);
      return [
        key,
        !hasCommittedScriptData(cbor) && orderedValue(data) === original.value
          ? toHex(canonical)
          : original.cbor,
      ];
    }),
  );

const cborOf = (entries: Map<string, { cbor: string }>) =>
  new Map([...entries].map(([key, value]) => [key, value.cbor]));

describe("canonicalTransaction", () => {
  test("keeps Plutus data and canonicalises everything else", () => {
    let withRedeemers = 0,
      changed = 0,
      untagged = 0;
    FastCheck.assert(
      FastCheck.property(FastCheck.gen(), (g) => {
        const item = randomTransaction(g);
        const tx = encode(item);
        const result = fromHex(canonicalTransactionHex(toHex(tx)));
        expect(withoutSetTags(canonicalMeaning(result))).toBe(
          withoutSetTags(canonicalMeaning(tx)),
        );
        expect(ledgerSetTags(result)).not.toContain(false);
        expect(outputDatums(result)).toEqual(outputDatums(tx));
        expect(witnessDatums(result)).toEqual(witnessDatums(tx));
        expect(nativeScripts(result)).toEqual(nativeScripts(tx));
        if (hasCommittedScriptData(tx))
          expect(committedWitnesses(result)).toEqual(committedWitnesses(tx));
        expect(committedAuxiliary(result)).toBe(committedAuxiliary(tx));
        expect(cborOf(redeemers(result))).toEqual(expectedRedeemers(tx));
        const canonicalDataResult = fromHex(
          canonicalTransactionHex(toHex(encode(item, true))),
        );
        const genericCanonicalData =
          normalizeProtectedRegions(canonicalDataResult);
        expect(toHex(genericCanonicalData)).toBe(
          toHex(canonicalCbor(genericCanonicalData)),
        );
        expect(canonicalTransactionHex(toHex(result))).toBe(toHex(result));
        if (redeemers(tx).size) withRedeemers++;
        if (ledgerSetTags(tx).includes(false)) untagged++;
        if (toHex(result) !== toHex(tx)) changed++;
      }),
      { numRuns: 3000, endOnFailure: true, seed: 2131105921 },
    );
    expect(withRedeemers).toBeGreaterThan(1500);
    expect(untagged).toBeGreaterThan(2000);
    expect(changed).toBeGreaterThan(2400);
  });

  test("keeps signed transaction bytes intact", () => {
    // Deliberately oversized body field and an arbitrary vkey witness: changing
    // the body after it is signed would invalidate that signature.
    const body = "a300800180021b0000000000030d40";
    const signed = `84${body}a10081825820${"11".repeat(32)}5840${"22".repeat(64)}f5f6`;
    expect(canonicalTransactionHex(signed)).toBe(signed);
  });
});
