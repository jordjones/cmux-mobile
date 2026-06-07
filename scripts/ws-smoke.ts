/**
 * M1 verification — headless WebSocket client against a running bridge. Proves
 * the end-to-end mirror path: hello → topology → subscribe → screen.full.
 *
 *   bun run packages/bridge/src/main.ts &   # start the bridge first
 *   bun run scripts/ws-smoke.ts
 */
export {}; // module scope (isolate top-level identifiers from other scripts)
const url = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";
const ws = new WebSocket(url);

const got = { hello: false, topology: false, full: false, diff: false };
let surfaceId: string | undefined;

const timeout = setTimeout(() => fail("timeout waiting for frames"), 8000);

function finish(): void {
  clearTimeout(timeout);
  if (surfaceId) ws.send(JSON.stringify({ t: "unsubscribe", surfaceId }));
  ws.close();
  console.log("RESULT", got);
  process.exit(got.full ? 0 : 1);
}

function fail(msg: string): void {
  clearTimeout(timeout);
  console.error("FAIL:", msg, got);
  try {
    ws.close();
  } catch {
    /* noop */
  }
  process.exit(1);
}

ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "" }));

ws.onerror = (e) => fail("ws error: " + String((e as ErrorEvent).message ?? e));

ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  switch (m.t) {
    case "hello.ok":
      got.hello = true;
      return;
    case "topology": {
      got.topology = true;
      console.log(`topology: ${m.surfaces.length} terminal surfaces`);
      for (const s of m.surfaces.slice(0, 6)) console.log(`  ${s.surfaceRef}  ${s.title ?? ""}`);
      if (m.surfaces.length === 0) return fail("no surfaces to subscribe");
      surfaceId = m.surfaces[0].surfaceId;
      ws.send(JSON.stringify({ t: "subscribe", surfaceId }));
      return;
    }
    case "screen.full":
      if (m.surfaceId !== surfaceId) return;
      got.full = true;
      console.log(`screen.full rev=${m.rev} rows=${m.rows.length} cols=${m.cols}`);
      console.log("  last lines:", JSON.stringify(m.rows.slice(-3)));
      // Give it a moment to (maybe) emit a diff/checksum, then finish.
      setTimeout(finish, 1200);
      return;
    case "screen.diff":
      if (m.surfaceId === surfaceId) got.diff = true;
      return;
    case "error":
      console.warn("bridge error:", m.code, m.message);
      return;
  }
};
