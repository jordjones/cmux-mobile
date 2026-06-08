/**
 * server — HTTP + WebSocket endpoint. Serves the PWA (static assets + an
 * on-the-fly browser bundle) and bridges each WebSocket client to cmux:
 * topology listing, per-surface mirrors, and input.
 *
 * Security (M3): every request is gated by peer identity —
 *   - loopback peers (the Mac itself) are always trusted;
 *   - otherwise the peer IP must resolve via `tailscale whois` to the host's own
 *     tailnet identity (fail closed), AND the WebSocket additionally requires a
 *     valid per-device bearer token.
 * The PWA shell + /pair are reachable with identity-only (no token) so a new
 * device can pair; the WebSocket (which can drive panes) requires the token.
 */
import { join, normalize, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "@cmux-mobile/protocol";
import type { CmuxSocketClient } from "./socket-client.ts";
import type { Topology } from "./topology.ts";
import { SurfaceMirror } from "./surface-mirror.ts";
import { normalizeRows } from "./screen-diff.ts";
import type { InputRouter } from "./input-router.ts";
import type { WorkspaceOps } from "./workspace-ops.ts";
import type { PairingManager, TailscaleVerifier, TokenStore } from "./auth.ts";
import { normalizeIp } from "./auth.ts";
import type { AuthMode } from "./config.ts";

export interface BridgeServerOptions {
  host: string;
  port: number;
  authMode: AuthMode;
  webDir: string;
  webEntry: string | null;
}

export interface AuthBundle {
  verifier: TailscaleVerifier;
  tokens: TokenStore;
  pairing: PairingManager;
}

export interface BridgeServerDeps {
  client: CmuxSocketClient;
  topology: Topology;
  input?: InputRouter;
  ops?: WorkspaceOps;
  auth: AuthBundle;
}

interface ClientState {
  mirrors: Map<string, SurfaceMirror>;
  device: string;
}

/** Extract a bearer token from a (possibly comma-listed) Sec-WebSocket-Protocol header. */
function parseBearer(proto: string | null): string | null {
  if (!proto) return null;
  for (const p of proto.split(",")) {
    const t = p.trim();
    if (t.startsWith("bearer.")) return t.slice("bearer.".length);
  }
  return null;
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const n = normalizeIp(ip);
  return n === "::1" || n === "127.0.0.1" || n.startsWith("127.");
}

function safeSend(ws: ServerWebSocket<ClientState>, msg: ServerMessage): void {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  } catch {
    /* socket closing */
  }
}

async function buildWebBundle(entry: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
  if (!result.success) {
    throw new Error("web bundle build failed: " + result.logs.map(String).join("; "));
  }
  const out = result.outputs[0];
  if (!out) throw new Error("web bundle produced no output");
  return out.text();
}

function staticContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".webmanifest")) return "application/manifest+json";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

export async function startBridgeServer(opts: BridgeServerOptions, deps: BridgeServerDeps) {
  // Dev: build app.js from source on the fly. Packaged: webEntry is null and a
  // prebuilt app.js is served statically from webDir.
  const appJs = opts.webEntry ? await buildWebBundle(opts.webEntry) : null;
  const { verifier, tokens, pairing } = deps.auth;

  /** Identity gate (every route): off → open; loopback → trusted; else own-tailnet peer (fail closed). */
  async function identityOk(ip: string | undefined): Promise<boolean> {
    if (opts.authMode === "off") return true;
    if (isLoopback(ip)) return true;
    if (!ip) return false;
    return (await verifier.verifyPeer(ip)).ok;
  }

  /** WebSocket authorization (identity already verified by identityOk). Returns a device label or null. */
  function authorizeWs(ip: string | undefined, token: string | null): string | null {
    if (opts.authMode === "off") return "local";
    if (isLoopback(ip)) return "local";
    if (opts.authMode === "tailnet") return "tailnet"; // identity is sufficient — no token needed
    if (!token) return null; // token mode requires a valid device token
    return tokens.verify(token)?.name ?? null;
  }

  async function serveStatic(pathname: string): Promise<Response> {
    const rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(join(opts.webDir, rel));
    const root = opts.webDir.endsWith(sep) ? opts.webDir : opts.webDir + sep;
    if (filePath !== opts.webDir && !filePath.startsWith(root)) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": staticContentType(filePath) } });
    }
    return new Response("not found", { status: 404 });
  }

  const server = Bun.serve<ClientState>({
    hostname: opts.host,
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ip = srv.requestIP(req)?.address;

      // /healthz stays open for local readiness probes.
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, cmux: deps.client.isConnected });
      }

      if (!(await identityOk(ip))) return new Response("forbidden (not on tailnet)", { status: 403 });

      if (url.pathname === "/pair" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { code?: string; name?: string } | null;
        if (!body?.code || !pairing.consume(body.code)) {
          return Response.json({ error: "invalid or expired code" }, { status: 401 });
        }
        const { id, token } = tokens.mint(body.name?.slice(0, 64) || "device");
        return Response.json({ id, token });
      }

      if (url.pathname === "/ws") {
        const proto = req.headers.get("sec-websocket-protocol");
        const device = authorizeWs(ip, parseBearer(proto));
        if (!device) return new Response("unauthorized", { status: 401 });
        const ok = srv.upgrade(req, {
          data: { mirrors: new Map(), device },
          // Echo the selected subprotocol so the browser completes the handshake.
          headers: proto ? { "Sec-WebSocket-Protocol": proto.split(",")[0]!.trim() } : undefined,
        });
        return ok ? undefined : new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/app.js" && appJs) {
        return new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }

      return serveStatic(url.pathname);
    },
    websocket: {
      open(ws) {
        ws.subscribe("all"); // receive bridge-wide broadcasts (topology refreshes)
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        } catch {
          safeSend(ws, { t: "error", code: "bad_json", message: "invalid message" });
          return;
        }
        void handleClientMessage(ws, msg, deps);
      },
      close(ws) {
        for (const m of ws.data.mirrors.values()) m.stop();
        ws.data.mirrors.clear();
      },
    },
  });

  return server;
}

async function sendTopology(ws: ServerWebSocket<ClientState>, deps: BridgeServerDeps): Promise<void> {
  try {
    const surfaces = await deps.topology.list();
    safeSend(ws, { t: "topology", surfaces });
  } catch (e) {
    safeSend(ws, { t: "error", code: "topology_failed", message: (e as Error).message });
  }
}

async function handleClientMessage(
  ws: ServerWebSocket<ClientState>,
  msg: ClientMessage,
  deps: BridgeServerDeps,
): Promise<void> {
  switch (msg.t) {
    case "ping":
      // Liveness heartbeat — answer immediately so the client can tell a live
      // socket from a half-open one.
      safeSend(ws, { t: "pong" });
      return;

    case "hello":
      // The WS upgrade already authenticated this connection.
      safeSend(ws, { t: "hello.ok", device: ws.data.device, caps: { color: false } });
      await sendTopology(ws, deps);
      return;

    case "list":
      await sendTopology(ws, deps);
      return;

    case "subscribe": {
      // Idempotent: a re-subscribe to a live mirror forces a fresh full frame
      // (the client's recovery path relies on this), instead of silently no-op'ing.
      const existing = ws.data.mirrors.get(msg.surfaceId);
      if (existing) {
        existing.reset();
        return;
      }
      const mirror = new SurfaceMirror(deps.client, msg.surfaceId, (frame) => safeSend(ws, frame));
      ws.data.mirrors.set(msg.surfaceId, mirror);
      mirror.start();
      return;
    }

    case "unsubscribe": {
      const mirror = ws.data.mirrors.get(msg.surfaceId);
      if (mirror) {
        mirror.stop();
        ws.data.mirrors.delete(msg.surfaceId);
      }
      return;
    }

    case "resync":
      ws.data.mirrors.get(msg.surfaceId)?.reset();
      return;

    case "pause":
      // Client backgrounded — stop polling the Mac surface to save battery/CPU/radio.
      ws.data.mirrors.get(msg.surfaceId)?.stop();
      return;

    case "resume": {
      // Foregrounded — resume polling; reset() re-arms a fresh full frame.
      const m = ws.data.mirrors.get(msg.surfaceId);
      if (m) {
        m.reset();
        m.start();
      }
      return;
    }

    case "workspace.create":
    case "surface.create": {
      if (!deps.ops) {
        safeSend(ws, { t: "error", code: "create_disabled", message: "create not enabled" });
        return;
      }
      try {
        const created =
          msg.t === "workspace.create"
            ? await deps.ops.createWorkspace()
            : await deps.ops.createSurface(msg.workspaceId);
        // Topology first so the client's surface list already includes the new
        // surface when it handles `created` (a WebSocket preserves message order).
        await sendTopology(ws, deps);
        safeSend(ws, { t: "created", surfaceId: created.surfaceId, workspaceId: created.workspaceId });
      } catch (e) {
        safeSend(ws, { t: "error", code: "create_failed", message: (e as Error).message });
      }
      return;
    }

    case "input.text":
    case "input.key": {
      if (!deps.input) {
        safeSend(ws, { t: "error", code: "input_disabled", message: "input not enabled" });
        return;
      }
      try {
        if (msg.t === "input.text") await deps.input.sendText(msg.surfaceId, msg.text);
        else await deps.input.sendKey(msg.surfaceId, msg.key);
        ws.data.mirrors.get(msg.surfaceId)?.notifyInput();
      } catch (e) {
        safeSend(ws, { t: "error", code: "input_failed", message: (e as Error).message });
      }
      return;
    }

    case "scrollback": {
      // On-demand history: cmux's read_text returns the last N lines (incl.
      // scrollback) when given `lines`. Clamp N so a client can't ask for the
      // whole unbounded buffer.
      const lines = Math.max(1, Math.min(msg.lines || 1000, 5000));
      try {
        const res = await deps.client.call<{ text?: string }>(
          "surface.read_text",
          { surface_id: msg.surfaceId, lines },
          8000,
        );
        safeSend(ws, { t: "scrollback", surfaceId: msg.surfaceId, rows: normalizeRows(res?.text ?? "") });
      } catch (e) {
        safeSend(ws, { t: "error", code: "scrollback_failed", message: (e as Error).message });
      }
      return;
    }
  }
}
