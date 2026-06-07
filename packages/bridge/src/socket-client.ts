/**
 * socket-client — owns ONE connection to the cmux local Unix-domain socket and
 * speaks its newline-delimited JSON-RPC (v2) protocol:
 *
 *   write: {"id","method","params"}\n
 *   read : {"ok":true,"result":...}  | {"ok":false,"error":{code,message}}
 *
 * Resilience: re-resolves the (rotating) socket path on every connect,
 * auto-reconnects with backoff after an unexpected close, sends a periodic
 * `system.ping` heartbeat so cmux doesn't reap the idle control connection, and
 * gates `call()` on readiness so brief reconnects are transparent to callers.
 *
 * A SEPARATE connection is used for `events.stream` (see events-client.ts).
 */
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CmuxErrorShape {
  code: string;
  message: string;
  [k: string]: unknown;
}

export class CmuxError extends Error {
  code: string;
  detail: CmuxErrorShape;
  constructor(err: CmuxErrorShape) {
    super(`${err.code}: ${err.message}`);
    this.name = "CmuxError";
    this.code = err.code;
    this.detail = err;
  }
}

const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "cmux");
const HEARTBEAT_MS = 15_000;

/** Resolve the live socket path (env first, then marker files); re-run each connect. */
export function resolveSocketPath(): string {
  const env = process.env.CMUX_SOCKET_PATH;
  if (env && existsSync(env)) return env;
  const markers = ["/tmp/cmux-last-socket-path", join(SUPPORT_DIR, "last-socket-path")];
  for (const m of markers) {
    try {
      if (!existsSync(m)) continue;
      const p = readFileSync(m, "utf8").trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* ignore unreadable marker */
    }
  }
  if (env) return env;
  throw new Error("Could not resolve cmux socket path. Is cmux running? (set CMUX_SOCKET_PATH)");
}

function resolvePassword(): string | null {
  const env = process.env.CMUX_SOCKET_PASSWORD;
  if (env) return env;
  const f = join(SUPPORT_DIR, "socket-control-password");
  try {
    if (existsSync(f)) return readFileSync(f, "utf8").trim() || null;
  } catch {
    /* owner-only file */
  }
  return null;
}

type Pending = {
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Waiter = { resolve: () => void; reject: (e: unknown) => void };

export interface SocketClientOptions {
  /** Per-call timeout in ms, also the max time a call waits through a reconnect (default 15000). */
  callTimeoutMs?: number;
  /** Skip auth.login even if a password is found (default false). */
  skipAuth?: boolean;
}

export class CmuxSocketClient {
  private socket: import("bun").Socket | null = null;
  private buf = "";
  private pending = new Map<string, Pending>();
  private seq = 0;
  private connected = false;
  private closedByUser = false;
  private connecting: Promise<void> | null = null;
  private waiters: Waiter[] = [];
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly callTimeoutMs: number;
  private readonly skipAuth: boolean;

  constructor(opts: SocketClientOptions = {}) {
    this.callTimeoutMs = opts.callTimeoutMs ?? 15_000;
    this.skipAuth = opts.skipAuth ?? false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Initial connect. Throws if cmux is unreachable; later drops auto-reconnect. */
  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const path = resolveSocketPath();
        this.socket = await Bun.connect({
          unix: path,
          socket: {
            data: (_s, chunk) => this.onData(chunk),
            close: () => this.handleDisconnect(new Error("cmux socket closed")),
            error: (_s, err) => this.handleDisconnect(err),
          },
        });
        this.connected = true;
        this.reconnectDelay = 500;
        await this.maybeAuth();
        this.startHeartbeat();
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w.resolve();
      } catch (err) {
        // Fail fast: reject anyone awaiting readiness rather than letting them
        // hang to the per-call timeout. The reconnect loop keeps retrying.
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) w.reject(err);
        throw err;
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async maybeAuth(): Promise<void> {
    if (this.skipAuth) return;
    const pw = resolvePassword();
    if (!pw) return;
    try {
      await this.call("auth.login", { password: pw });
    } catch (e) {
      if (e instanceof CmuxError && e.code === "auth_required") throw e;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.connected) return; // never ping mid-reconnect
      this.call("system.ping", {}, 5_000).catch(() => {
        /* a failed ping surfaces via the close handler */
      });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private handleDisconnect(err: unknown): void {
    if (!this.socket && !this.connected) return; // already handled
    this.socket = null;
    this.connected = false;
    this.stopHeartbeat();
    this.failAll(err);
    if (!this.closedByUser) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser || this.connected) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser || this.connected) return;
      this.doConnect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  /** Resolve once connected, or reject on timeout / explicit close. */
  private whenReady(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.closedByUser) return Promise.reject(new Error("cmux client closed"));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("cmux socket not connected"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private onData(chunk: Uint8Array): void {
    this.buf += Buffer.from(chunk).toString("utf8");
    if (this.buf.length > 16_000_000) {
      // Pathological: a peer streaming without a newline. Drop to avoid OOM.
      this.buf = "";
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: CmuxErrorShape };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: {
    id?: string;
    ok?: boolean;
    result?: unknown;
    error?: CmuxErrorShape;
  }): void {
    const id = msg.id;
    if (!id || !this.pending.has(id)) return;
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok === false) {
      p.reject(new CmuxError(msg.error ?? { code: "unknown", message: "unknown error" }));
    } else {
      p.resolve(msg.result);
    }
  }

  /** Issue a JSON-RPC call, waiting through brief reconnects, and await the response. */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = this.callTimeoutMs,
  ): Promise<T> {
    await this.whenReady(timeoutMs);
    const socket = this.socket;
    if (!socket) throw new Error("cmux socket not connected");
    const id = `r${++this.seq}`;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cmux call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        socket.write(line);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.socket?.end();
    } catch {
      /* noop */
    }
    this.socket = null;
    this.connected = false;
    this.failAll(new Error("cmux client closed"));
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(new Error("cmux client closed"));
  }

  private failAll(err: unknown): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
