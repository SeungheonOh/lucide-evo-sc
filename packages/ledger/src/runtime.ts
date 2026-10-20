import {
  WASI,
  File,
  OpenFile,
  ConsoleStdout,
  PreopenDirectory,
} from "@bjorn3/browser_wasi_shim";
import type { LedgerRuntime } from "./types.js";

type ReactorExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  lucid_alloc: (length: number) => number;
  lucid_free: (pointer: number) => void;
  lucid_run: (pointer: number, length: number) => number;
  lucid_result_len: () => number;
  lucid_init?: () => void;
};

let entropy: ((bytes: Uint8Array) => void) | undefined;
export function prepareReactor(random: (bytes: Uint8Array) => void) {
  entropy ??= random;
  let instance: WebAssembly.Instance;
  const wasi = new WASI(
    ["lucid-ledger"],
    [],
    [
      new OpenFile(new File(new Uint8Array())),
      ConsoleStdout.lineBuffered(() => {}),
      ConsoleStdout.lineBuffered(() => {}),
      new PreopenDirectory("/", new Map()),
    ],
    { debug: false },
  );
  // Key generation must never fall back to the shim's Math.random branch.
  wasi.wasiImport.random_get = (pointer, length) => {
    const bytes = new Uint8Array(
      (instance.exports.memory as WebAssembly.Memory).buffer,
      pointer,
      length,
    );
    for (let offset = 0; offset < length; offset += 65536)
      random(bytes.subarray(offset, offset + 65536));
    return 0;
  };
  return {
    imports: { wasi_snapshot_preview1: wasi.wasiImport },
    attach(loaded: WebAssembly.Instance): LedgerRuntime {
      instance = loaded;
      wasi.initialize(instance as Parameters<typeof wasi.initialize>[0]);
      const exports = instance.exports as ReactorExports;
      exports.lucid_init?.();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let active = false;
      const runSync = (payload: Record<string, unknown>): unknown => {
        if (active)
          throw new Error(
            "The Haskell ledger cannot be re-entered during a request",
          );
        const request = encoder.encode(
          JSON.stringify(payload, (_, value) =>
            typeof value === "bigint" ? value.toString() : value,
          ),
        );
        active = true;
        let pointer = 0;
        let resultPointer = 0;
        try {
          pointer = exports.lucid_alloc(request.length);
          if (!pointer)
            throw new Error("Haskell ledger request allocation failed");
          new Uint8Array(exports.memory.buffer, pointer, request.length).set(
            request,
          );
          resultPointer = exports.lucid_run(pointer, request.length);
          const length = exports.lucid_result_len();
          const response = decoder.decode(
            new Uint8Array(exports.memory.buffer, resultPointer, length),
          );
          return JSON.parse(response);
        } finally {
          if (resultPointer) exports.lucid_free(resultPointer);
          if (pointer) exports.lucid_free(pointer);
          active = false;
        }
      };
      return { runSync, run: async (payload) => runSync(payload) };
    },
  };
}

let runtime: LedgerRuntime | undefined;
export function initializeLedger(value: LedgerRuntime): void {
  runtime = value;
}
export function getLedgerRuntime(): LedgerRuntime {
  if (!runtime) throw new Error("Haskell ledger runtime has not initialized");
  return runtime;
}
export function ledger<T>(
  operation: string,
  payload: Record<string, unknown> = {},
): T {
  const response = getLedgerRuntime().runSync({
    action: "ledger",
    operation,
    ...payload,
  }) as { ok: boolean; result?: T; error?: string };
  if (!response?.ok)
    throw new Error(
      response?.error ?? `Haskell ledger operation ${operation} failed`,
    );
  return response.result as T;
}

export async function createLedgerRuntime(
  module: WebAssembly.Module,
): Promise<LedgerRuntime> {
  if (!entropy) throw new Error("Secure entropy source has not initialized");
  const reactor = prepareReactor(entropy);
  return reactor.attach(await WebAssembly.instantiate(module, reactor.imports));
}

/** Host entropy for both reactor and command WASI adapters. */
export function fillSecureRandom(bytes: Uint8Array): void {
  if (!entropy) throw new Error("Secure entropy source has not initialized");
  for (let offset = 0; offset < bytes.length; offset += 65536)
    entropy(bytes.subarray(offset, offset + 65536));
}
