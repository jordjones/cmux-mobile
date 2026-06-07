/**
 * main — dev / launchd entry point. Binds the Tailscale IP, auth on by default.
 *
 *   bun run packages/bridge/src/main.ts            # binds tailnet IP, auth on
 *   CMUX_BRIDGE_HOST=127.0.0.1 bun run …/main.ts   # local dev (loopback trusted)
 *   CMUX_BRIDGE_AUTH=off bun run …/main.ts         # disable auth entirely (dev)
 *
 * The packaged CLI (cli.ts) shares the same run() but resolves a prebuilt web dir.
 */
import { loadConfig } from "./config.ts";
import { run } from "./app-run.ts";

run(loadConfig()).catch((e) => {
  console.error("bridge failed to start:", e);
  process.exit(1);
});
