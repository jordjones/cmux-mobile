/**
 * Verify the bridge serves on-demand scrollback: subscribe to an existing
 * surface (read-only), request history, and confirm it returns more rows than
 * the live viewport.
 *
 *   bun run scripts/ws-scrollback-smoke.ts   (WS_URL overridable)
 */
export {}; // module scope (isolate top-level identifiers from other scripts)
const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
const ws = new WebSocket(WS_URL);

let surfaceId: string | undefined;
let viewportRows = 0;
let historyRows = 0;

const timeout = setTimeout(() => finish(false, "timeout"), 12000);
function finish(ok: boolean, note: string): void {
  clearTimeout(timeout);
  console.log(`${ok ? "PASS" : "FAIL"}: ${note} (viewport=${viewportRows}, history=${historyRows})`);
  try {
    if (surfaceId) ws.send(JSON.stringify({ t: "unsubscribe", surfaceId }));
    ws.close();
  } catch {
    /* noop */
  }
  process.exit(ok ? 0 : 1);
}

ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "" }));
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  if (m.t === "topology" && !surfaceId && m.surfaces.length) {
    surfaceId = m.surfaces[0].surfaceId;
    ws.send(JSON.stringify({ t: "subscribe", surfaceId }));
    return;
  }
  if (m.surfaceId !== surfaceId) return;
  if (m.t === "screen.full" && !viewportRows) {
    viewportRows = m.rows.length;
    ws.send(JSON.stringify({ t: "scrollback", surfaceId, lines: 500 }));
    return;
  }
  if (m.t === "scrollback") {
    historyRows = m.rows.length;
    finish(historyRows > viewportRows, historyRows > viewportRows ? "history returned more rows than viewport" : "history not larger than viewport");
  }
};
ws.onerror = () => finish(false, "ws error");
