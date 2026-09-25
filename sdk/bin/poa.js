#!/usr/bin/env node
// Runs the TypeScript sources directly; build step comes later.
// A bare import resolves from this file (import.meta.url), not the working directory,
// so tsx is found in this package's dependencies wherever `poa` is run from.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
