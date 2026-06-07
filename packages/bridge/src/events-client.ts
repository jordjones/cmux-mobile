/**
 * events-client — a SECOND cmux socket connection dedicated to `events.stream`
 * (which takes its connection into push-only mode). We use it only for
 * out-of-band signals, NOT screen content (events redact terminal text):
 *
 *   - structural topology changes (workspace/surface/pane created/closed/…) →
 *     `onTopologyChange` so the bridge can re-push the picker list;
 *   - a `boot_id` change (cmux restarted) → `onBootChange` so clients resync.
 *
 * Auto-reconnects with backoff; resumes from the last seq when possible.
 */
import { resolveSocketPath } from "./socket-client.ts";

/** Structural events worth refreshing topology for (focus/selection excluded — too chatty). */
const STRUCTURAL = /\.(created|closed|renamed|reordered|moved|split|grouped|ungrouped)$/;

export interface EventsClientHandlers {
  onTopologyChange: () => void;
  onBootChange: (bootId: string) => void;
}

export class EventsClient {
  private socket: import("bun").Socket | null = null;
  private buf = "";
  private bootId: string | null = null;
  private lastSeq: number | null = null;
  private closed = false;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly handlers: EventsClientHandlers) {}

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      this.buf = "";
      this.socket = await Bun.connect({
        unix: resolveSocketPath(),
        socket: {
          data: (_s, chunk) => this.onData(chunk),
          close: () => this.onDrop(),
          error: () => this.onDrop(),
        },
      });
      this.reconnectDelay = 500;
      const params: Record<string, unknown> = { reconnect: true };
      if (this.lastSeq != null) params.after_seq = this.lastSeq;
      this.socket.write(JSON.stringify({ id: "events", method: "events.stream", params }) + "\n");
    } catch {
      this.scheduleReconnect();
    }
  }

  private onDrop(): void {
    this.socket = null;
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private onData(chunk: Uint8Array): void {
    this.buf += Buffer.from(chunk).toString("utf8");
    if (this.buf.length > 16_000_000) {
      // Pathological line with no newline — drop the connection and resume
      // cleanly rather than truncating into a corrupt frame.
      this.buf = "";
      try {
        this.socket?.end();
      } catch {
        /* noop */
      }
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        this.handleFrame(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  }

  private handleFrame(obj: {
    boot_id?: string;
    protocol?: string;
    name?: string;
    resume?: { next_seq?: number };
    seq?: number;
  }): void {
    // Track seq for resume (header carries resume.next_seq; events carry their own id/seq).
    if (obj.resume?.next_seq != null) this.lastSeq = obj.resume.next_seq - 1;

    if (obj.boot_id) {
      if (this.bootId && obj.boot_id !== this.bootId) {
        this.bootId = obj.boot_id;
        this.lastSeq = null;
        this.handlers.onBootChange(obj.boot_id);
        return;
      }
      this.bootId = obj.boot_id;
    }

    // Header frame (no name) — nothing more to do.
    if (!obj.name) return;
    // Parse the trailing seq from the event id space if present.
    if (typeof obj.seq === "number") this.lastSeq = obj.seq;

    if (STRUCTURAL.test(obj.name)) this.handlers.onTopologyChange();
  }

  stop(): void {
    this.closed = true;
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
  }
}
