/**
 * Verify the bridge answers a client `ping` with a `pong` (liveness heartbeat).
 *
 *   bun run scripts/ws-heartbeat-smoke.ts   (WS_URL overridable)
 */
export {}; // module scope (isolate top-level identifiers from other scripts)
const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
const ws = new WebSocket(WS_URL);

let gotPong = false;

const timeout = setTimeout(() => finish(false, "timeout waiting for pong"), 8000);
function finish(ok: boolean, note: string): void {
  clearTimeout(timeout);
  console.log(`${ok ? "PASS" : "FAIL"}: ${note} (gotPong=${gotPong})`);
  try {
    ws.close();
  } catch {
    /* noop */
  }
  process.exit(ok ? 0 : 1);
}

ws.onopen = () => {
  ws.send(JSON.stringify({ t: "hello", token: "" }));
  ws.send(JSON.stringify({ t: "ping" }));
};
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  if (m.t === "pong") {
    gotPong = true;
    finish(true, "bridge answered ping with pong");
  }
};
ws.onerror = () => finish(false, "ws error");
