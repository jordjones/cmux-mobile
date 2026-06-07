/**
 * transport — WebSocket client to the bridge. Auto-reconnects with backoff and
 * re-announces (hello) on every (re)open so the app can re-list and re-subscribe.
 */
import type { ClientMessage, ServerMessage } from "@cmux-mobile/protocol";

export type ServerHandler = (msg: ServerMessage) => void;
export type StatusHandler = (status: "connecting" | "open" | "closed") => void;

const MAX_PENDING = 50;
// Liveness heartbeat: ping on a timer; if no pong lands within the grace window,
// the socket is half-open (iOS Wi-Fi↔cellular handoff, sleep) — force a reconnect
// rather than let the mirror silently freeze.
const HEARTBEAT_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;

export class Transport {
  private ws: WebSocket | null = null;
  private readonly msgHandlers = new Set<ServerHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private authNeededHandler: (() => void) | null = null;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private readonly pending: ClientMessage[] = [];
  private closed = false;
  private everOpened = false;
  private failedOpens = 0;
  private authNeededFired = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string = "",
  ) {}

  onMessage(fn: ServerHandler): void {
    this.msgHandlers.add(fn);
  }

  onStatus(fn: StatusHandler): void {
    this.statusHandlers.add(fn);
  }

  /** Fired once when we have no token and the connection keeps being refused. */
  onAuthNeeded(fn: () => void): void {
    this.authNeededHandler = fn;
  }

  private setStatus(s: "connecting" | "open" | "closed"): void {
    for (const h of this.statusHandlers) h(s);
  }

  connect(): void {
    // Never open a second socket on top of a live/in-flight one.
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    this.closed = false;
    this.connecting = true;
    this.setStatus("connecting");
    // Carry the bearer token as a WebSocket subprotocol so it never lands in the
    // URL (history / Referer / logs). The bridge reads Sec-WebSocket-Protocol.
    const ws = this.token
      ? new WebSocket(this.url, [`bearer.${this.token}`])
      : new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.reconnectDelay = 500;
      this.everOpened = true;
      this.failedOpens = 0;
      this.setStatus("open");
      this.send({ t: "hello", token: this.token });
      this.startHeartbeat();
    };
    ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      // Any inbound frame proves the socket is live; clear the pending pong
      // deadline. `pong` itself is purely a heartbeat ack — never forwarded.
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      if (msg.t === "pong") return;
      for (const h of this.msgHandlers) h(msg);
    };
    ws.onclose = () => {
      this.connecting = false;
      this.stopHeartbeat();
      this.setStatus("closed");
      if (this.closed) return;
      // Closed before ever opening with no token usually means the bridge
      // refused the upgrade (needs pairing) — surface that after a couple tries.
      if (!this.everOpened && !this.token) {
        this.failedOpens++;
        if (this.failedOpens >= 2 && !this.authNeededFired) {
          this.authNeededFired = true;
          this.authNeededHandler?.();
        }
      }
      const base = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
      // Jitter the scheduled wait (not the stored backoff) to avoid sync storms.
      const delay = base * (0.8 + Math.random() * 0.4);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  /** Force an immediate reconnect (foreground/online/manual retry). No-op if up or in-flight. */
  reconnectNow(): void {
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDelay = 500;
    this.connect();
  }

  /** Ping on a timer; if the matching pong doesn't arrive in time, drop the socket so the reconnect path runs. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.pongTimer) return; // still waiting on the previous ping's pong
      try {
        this.ws.send(JSON.stringify({ t: "ping" }));
      } catch {
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // No pong → half-open socket. Closing triggers onclose → reconnect.
        try {
          this.ws?.close();
        } catch {
          /* noop */
        }
      }, PONG_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Send a message. Returns false only when an input keystroke had to be dropped
   * (queue over cap) so the caller can warn. While disconnected, input.* is
   * queued (to survive a reconnect) and control frames are dropped (the reconnect
   * path re-issues hello/subscribe/resync).
   */
  send(msg: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch {
        /* fall through to queue */
      }
    }
    if (msg.t === "input.text" || msg.t === "input.key") {
      const over = this.pending.length >= MAX_PENDING;
      if (over) this.pending.shift(); // drop oldest
      this.pending.push(msg);
      return !over;
    }
    return true; // control frame; reconnect re-issues it
  }

  /** Flush queued input — call AFTER resubscribe so keys land on a live mirror. */
  flushPending(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const queued = this.pending.splice(0, this.pending.length);
    for (const m of queued) {
      try {
        this.ws.send(JSON.stringify(m));
      } catch {
        /* drop */
      }
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connecting = false;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}
