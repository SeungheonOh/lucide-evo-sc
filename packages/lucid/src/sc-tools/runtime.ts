import { createLedgerRuntime, fillSecureRandom } from "@lucid-evolution/ledger";
import type { ScToolsRuntime } from "./types.js";

/** Attach the worker shipped in sc-tools-wasm/output/browser/worker.js. */
export function createScToolsWorkerRuntime(worker: Worker): ScToolsRuntime & {
  close(): void;
} {
  let nextId = 0;
  let failure: Error | undefined;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(reason: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    worker.terminate();
  };
  worker.addEventListener("error", (event) => fail(new Error(event.message)));
  worker.addEventListener("messageerror", () =>
    fail(new Error("sc-tools worker message could not be decoded")),
  );
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "load-error") return fail(new Error(data.error));
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.type === "error") request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  return {
    run(payload) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(
          () => fail(new Error("sc-tools worker timed out")),
          120_000,
        );
        pending.set(id, { resolve, reject, timer });
        try {
          worker.postMessage({ id, payload });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close: () => fail(new Error("sc-tools worker closed")),
  };
}

/** Load a Haskell reactor or command module. Reactor requests share one instance;
 * command requests have isolated WASI state. Use a worker for background evaluation.
 */
export async function createScToolsWasmRuntime(
  module: WebAssembly.Module,
): Promise<ScToolsRuntime> {
  if (
    WebAssembly.Module.exports(module).some(({ name }) => name === "lucid_run")
  ) {
    return createLedgerRuntime(module);
  }
  const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } =
    await import("@bjorn3/browser_wasi_shim");
  return {
    async run(payload) {
      const stdout: string[] = [],
        stderr: string[] = [];
      const wasi = new WASI(
        ["sc-tools-browser", "json"],
        [],
        [
          new OpenFile(
            new File(new TextEncoder().encode(JSON.stringify(payload))),
          ),
          ConsoleStdout.lineBuffered((line) => stdout.push(line)),
          ConsoleStdout.lineBuffered((line) => stderr.push(line)),
          new PreopenDirectory("/", new Map()),
        ],
        { debug: false },
      );
      let instance: WebAssembly.Instance;
      wasi.wasiImport.random_get = (pointer, length) => {
        fillSecureRandom(
          new Uint8Array(
            (instance.exports.memory as WebAssembly.Memory).buffer,
            pointer,
            length,
          ),
        );
        return 0;
      };
      instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi.wasiImport,
      });
      const code = wasi.start(instance as Parameters<typeof wasi.start>[0]);
      const output = stdout.filter((line) => line.startsWith("{")).pop();
      if (code !== 0 || !output)
        throw new Error(
          stderr.join("\n") || `sc-tools exited with code ${code}`,
        );
      return JSON.parse(output);
    },
  };
}
