/**
 * Verify dynamic shortcut detection end-to-end against real terminal output:
 * echo a hint line into a THROWAWAY surface, read it back through the same path
 * the mirror uses, and run the real detector. Creates + closes its own workspace.
 *
 *   bun run scripts/autokeys-smoke.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";
import { detectShortcuts } from "../packages/web/src/shortcuts-detect.ts";
import { normalizeRows } from "../packages/bridge/src/screen-diff.ts";

const sock = new CmuxSocketClient();
await sock.connect();
const created = await sock.call<{ surface_id: string; workspace_id: string }>("workspace.create", {});
const sid = created.surface_id;
const wid = created.workspace_id;
await sock.call("surface.focus", { surface_id: sid });

let ok = false;
try {
  await new Promise((r) => setTimeout(r, 1000)); // let the shell come up
  await sock.call("surface.send_text", {
    surface_id: sid,
    text: "echo 'shift+tab to cycle | ctrl+o to expand | esc to interrupt'\n",
  });
  await new Promise((r) => setTimeout(r, 1200)); // let it echo + render
  const res = await sock.call<{ text?: string }>("surface.read_text", { surface_id: sid });
  const keys = detectShortcuts(normalizeRows(res?.text ?? "")).map((d) => d.key);
  ok = keys.includes("shift-tab") && keys.includes("ctrl-o") && keys.includes("escape");
  console.log(`${ok ? "PASS" : "FAIL"}: detected [${keys.join(", ")}]`);
} finally {
  try {
    await sock.call("workspace.close", { workspace_id: wid });
    console.log("scratch workspace closed ✓");
  } catch (e) {
    console.warn("cleanup failed:", (e as Error).message);
  }
  sock.close();
}
process.exit(ok ? 0 : 1);
