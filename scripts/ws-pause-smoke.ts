/**
 * Verify pause stops the Mac-side poll (no frames while paused) and resume
 * re-emits a screen.full. Subscribes to an existing surface (read-only).
 *
 *   bun run scripts/ws-pause-smoke.ts   (WS_URL overridable)
 */
export {}; // module scope (isolate top-level identifiers from other scripts)
const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
const ws = new WebSocket(WS_URL);

let surfaceId: string | undefined;
let phase: "warmup" | "paused" | "resumed" = "warmup";
let framesWhilePaused = 0;
let fullAfterResume = false;

const timeout = setTimeout(() => finish(false, "timeout"), 12000);
function finish(ok: boolean, note: string): void {
  clearTimeout(timeout);
  console.log(`${ok ? "PASS" : "FAIL"}: ${note} (framesWhilePaused=${framesWhilePaused}, fullAfterResume=${fullAfterResume})`);
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
  const isFrame = m.t === "screen.full" || m.t === "screen.diff" || m.t === "screen.checksum";
  if (phase === "warmup" && m.t === "screen.full") {
    // Got the initial frame; pause and watch for silence.
    phase = "paused";
    ws.send(JSON.stringify({ t: "pause", surfaceId }));
    setTimeout(() => {
      phase = "resumed";
      ws.send(JSON.stringify({ t: "resume", surfaceId }));
    }, 2000);
    return;
  }
  if (phase === "paused" && isFrame) framesWhilePaused++;
  if (phase === "resumed" && m.t === "screen.full") {
    fullAfterResume = true;
    finish(framesWhilePaused <= 1, framesWhilePaused <= 1 ? "pause silenced poll; resume re-emitted full" : "frames leaked during pause");
  }
};
ws.onerror = () => finish(false, "ws error");
