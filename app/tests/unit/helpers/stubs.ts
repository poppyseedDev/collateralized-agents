/**
 * Test-only module stubbing. Import this first in a test file: tsx runs the tests as CommonJS,
 * so later imports go through the patched `Module._load` and see the stubs.
 *
 * - `server-only` becomes an empty module (outside Next it throws on import).
 * - `@vercel/blob` becomes the in-memory fake in ./fakeBlob.
 * - `fetch` throws, so no test can reach the network by accident.
 */
import Module from "node:module";
import { blob } from "./fakeBlob";

type Load = (request: string, parent: unknown, isMain: boolean) => unknown;
const M = Module as unknown as { _load: Load };
const packages = new Map<string, unknown>();
const originalLoad = M._load;
M._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (packages.has(request)) return packages.get(request);
  return originalLoad.call(this, request, parent, isMain);
};

/** Replaces a package (by its bare import name) for every later require. */
export function stubPackage(name: string, exports: unknown) {
  packages.set(name, exports);
}

/** Replaces a local module (e.g. "@/lib/waitlistStore") for every later require. */
export function stubFile(path: string, exports: unknown) {
  const filename = require.resolve(path);
  const m = new Module(filename);
  m.filename = filename;
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
}

/** Requires a module afresh, re-running its top level (for modules that read env at load time). */
export function freshRequire<T>(path: string): T {
  delete require.cache[require.resolve(path)];
  return require(path) as T;
}

/** Sets or clears environment variables. */
export function setEnv(vars: Record<string, string | undefined>) {
  const env = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

export const offline: typeof fetch = async (input) => {
  throw new Error(`network access in a unit test: ${String(input)}`);
};

stubPackage("server-only", {});
stubPackage("@vercel/blob", blob.api);
globalThis.fetch = offline;
