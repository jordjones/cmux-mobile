/**
 * M2 verification — drive a surface over the WebSocket protocol and confirm the
 * typed command's output appears in the mirrored frames. Uses a throwaway
 * workspace (created/closed via the socket directly) so no real pane is touched.
 *
 *   bun run packages/bridge/src/main.ts &   # bridge must be running
 *   bun run scripts/ws-input-smoke.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
const MARKER = "ws_input_ok_42";

const sock = new CmuxSocketClient();
await sock.connect();

const created = await sock.call<{ surface_id: string; workspace_id: string }>("workspace.create", {});
const surfaceId = created.surface_id;
const workspaceId = created.workspace_id;
console.log("scratch surface:", surfaceId);
// A freshly-created surface's terminal is lazily rendered — read_text reports
// "not found" until it is focused/rendered. Real usage mirrors already-rendered
// surfaces; the test must render its scratch surface explicitly.
await sock.call("surface.focus", { surface_id: surfaceId });

const rows: string[] = [];
let haveFull = false;

function applyFull(r: string[]): void {
  rows.length = 0;
  rows.push(...r);
  haveFull = true;
}
function applyDiff(ops: { y: number; text: string }[]): void {
  for (const op of ops) {
    while (rows.length <= op.y) rows.push("");
    rows[op.y] = op.text;
  }
}
function screenHas(marker: string): number {
  return rows.join("\n").split(marker).length - 1;
}

async function cleanup(code: number): Promise<void> {
  try {
    await sock.call("workspace.close", { workspace_id: workspaceId });
    console.log("scratch workspace closed ✓");
  } catch (e) {
    console.warn("cleanup failed:", (e as Error).message);
  }
  sock.close();
  process.exit(code);
}

const ws = new WebSocket(WS_URL);
const timeout = setTimeout(() => {
  console.error("FAIL: timeout; marker count =", screenHas(MARKER));
  void cleanup(1);
}, 12000);

let sentInput = false;

ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "" }));
ws.onmessage = async (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  if (m.t === "error") console.warn("  [error frame]", m.code, m.message);
  if (m.t === "hello.ok") {
    ws.send(JSON.stringify({ t: "subscribe", surfaceId }));
    return;
  }
  if (m.t === "screen.full" && m.surfaceId === surfaceId) {
    applyFull(m.rows);
    console.log(`  screen.full rev=${m.rev} rows=${m.rows.length}`);
    if (!sentInput) {
      sentInput = true;
      // Wait for the fresh shell PTY to be ready, then type + submit via a single
      // newline-terminated send_text (the path proven in M0), then a key Enter
      // as belt-and-suspenders.
      setTimeout(() => {
        console.log("  sending input...");
        ws.send(JSON.stringify({ t: "input.text", surfaceId, text: `echo ${MARKER}\n` }));
        setTimeout(() => ws.send(JSON.stringify({ t: "input.key", surfaceId, key: "enter" })), 300);
      }, 1000);
    }
    return;
  }
  if (m.t === "screen.diff" && m.surfaceId === surfaceId) {
    applyDiff(m.ops);
  }
  // After input, the marker should appear twice (command echo + output line).
  if (sentInput && screenHas(MARKER) >= 2) {
    clearTimeout(timeout);
    console.log("input round-trip over WS ✓ (marker observed in mirror)");
    ws.send(JSON.stringify({ t: "unsubscribe", surfaceId }));
    ws.close();
    await cleanup(0);
  }
};
ws.onerror = (e) => {
  clearTimeout(timeout);
  console.error("FAIL ws error:", String((e as ErrorEvent).message ?? e));
  void cleanup(1);
};
