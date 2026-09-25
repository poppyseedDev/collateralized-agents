import { setupEnv } from "./setup-env.js";

/** Like env.ts, with RPC_URL_FALLBACK configured. */
export const STATE_DIR = setupEnv(true);
