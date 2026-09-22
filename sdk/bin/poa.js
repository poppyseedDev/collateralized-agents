#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";
// Runs the TypeScript sources directly; build step comes later.
register("tsx/esm", pathToFileURL("./"));
await import("../src/cli.ts");
