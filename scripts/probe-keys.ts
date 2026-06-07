/**
 * E1 GATE probe — which key names does cmux's surface.send_key grammar accept?
 * Drives a THROWAWAY workspace (created + closed via the socket), never a real
 * pane. Reports OK/FAIL per key so the d-pad / "more keys" UI only offers keys
 * that actually work.
 *
 *   bun run scripts/probe-keys.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

const sock = new CmuxSocketClient();
await sock.connect();

const created = await sock.call<{ surface_id: string; workspace_id: string }>("workspace.create", {});
const sid = created.surface_id;
const wid = created.workspace_id;
await sock.call("surface.focus", { surface_id: sid });
console.log(`scratch surface ${sid}\n`);

// Non-destructive names only (no ctrl-d / ctrl-c — a scratch shell, but be polite).
const keys = [
  "shift-tab",
  "ctrl-o",
  "ctrl-a",
  "ctrl-e",
  "ctrl-r",
  "ctrl-u",
  "ctrl-k",
  "ctrl-w",
  "ctrl-l",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "f1",
  "f2",
  "f5",
  "f10",
  "f12",
  "ctrl-left",
  "ctrl-right",
  "alt-b",
  "alt-f",
  "ctrl-shift-up",
];

const ok: string[] = [];
const bad: string[] = [];
try {
  for (const key of keys) {
    try {
      await sock.call("surface.send_key", { surface_id: sid, key }, 4000);
      ok.push(key);
      console.log(`  OK    ${key}`);
    } catch (e) {
      bad.push(key);
      console.log(`  FAIL  ${key}: ${(e as Error).message}`);
    }
  }
} finally {
  try {
    await sock.call("workspace.close", { workspace_id: wid });
    console.log("\nscratch workspace closed ✓");
  } catch (e) {
    console.warn("cleanup failed:", (e as Error).message);
  }
  sock.close();
}

console.log(`\nACCEPTED (${ok.length}): ${ok.join(", ")}`);
console.log(`REJECTED (${bad.length}): ${bad.join(", ") || "none"}`);
