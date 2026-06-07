/**
 * surface-mirror — one per subscribed surface. Polls `surface.read_text` at an
 * adaptive cadence (15 Hz shortly after input, 5 Hz idle), diffs row-by-row, and
 * emits screen.full / screen.diff / screen.checksum frames with a monotonic rev.
 *
 * Output is the ONLY screen path (cmux events don't carry screen text), so this
 * polling loop is mandatory.
 */
import type { CmuxSocketClient } from "./socket-client.ts";
import { screenHash, type ServerMessage } from "@cmux-mobile/protocol";
import { diffRows, maxCols, normalizeRows } from "./screen-diff.ts";

const ACTIVE_FPS = 15;
const IDLE_FPS = 5;
const IDLE_AFTER_MS = 1500;
const CHECKSUM_EVERY_MS = 5000;

/** Frames a mirror can emit (a subset of ServerMessage). */
export type MirrorFrame = Extract<
  ServerMessage,
  { t: "screen.full" } | { t: "screen.diff" } | { t: "screen.checksum" } | { t: "error" }
>;

export class SurfaceMirror {
  private rows: string[] = [];
  private rev = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastInputAt = 0;
  private lastChecksumAt = 0;
  private running = false;
  private haveSnapshot = false;
  private lastErrorMsg: string | null = null;

  constructor(
    private readonly client: CmuxSocketClient,
    private readonly surfaceId: string,
    private readonly emit: (frame: MirrorFrame) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.haveSnapshot = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Record input so the poll loop runs at the active cadence. */
  notifyInput(): void {
    this.lastInputAt = Date.now();
  }

  /** Force a fresh full snapshot on the next tick (used for client resync). */
  reset(): void {
    this.haveSnapshot = false;
    this.rows = [];
  }

  private intervalMs(): number {
    const active = Date.now() - this.lastInputAt < IDLE_AFTER_MS;
    return Math.round(1000 / (active ? ACTIVE_FPS : IDLE_FPS));
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let errored = false;
    try {
      const res = await this.client.call<{ text?: string }>(
        "surface.read_text",
        { surface_id: this.surfaceId },
        5_000,
      );
      this.applyScreen(res?.text ?? "");
      this.lastErrorMsg = null;
    } catch (e) {
      errored = true;
      const msg = (e as Error).message;
      // Emit an error frame only on transition/change — a not-yet-ready surface
      // otherwise floods the client at full cadence.
      if (msg !== this.lastErrorMsg) {
        this.lastErrorMsg = msg;
        this.emit({ t: "error", code: "read_failed", message: msg });
      }
    }
    // Back off to a slow poll while a surface is unavailable; full cadence once healthy.
    this.scheduleNext(errored ? 1000 : this.intervalMs());
  }

  private applyScreen(text: string): void {
    const next = normalizeRows(text);
    const cols = maxCols(next);

    if (!this.haveSnapshot) {
      this.rev++;
      this.rows = next;
      this.haveSnapshot = true;
      this.lastChecksumAt = Date.now();
      this.emit({ t: "screen.full", surfaceId: this.surfaceId, rev: this.rev, cols, rows: next });
      return;
    }

    // Row-count changes also go through diffRows (unequal-length-correct: it pads
    // both sides and emits {y,text:""} shrink ops), so a prompt/status line
    // appearing or vanishing is a cheap diff, not a wholesale full frame.
    const ops = diffRows(this.rows, next);
    if (ops.length > 0) {
      this.rev++;
      this.rows = next;
      this.emit({ t: "screen.diff", surfaceId: this.surfaceId, rev: this.rev, ops });
    }

    const now = Date.now();
    if (now - this.lastChecksumAt >= CHECKSUM_EVERY_MS) {
      this.lastChecksumAt = now;
      this.emit({
        t: "screen.checksum",
        surfaceId: this.surfaceId,
        rev: this.rev,
        hash: screenHash(this.rows),
      });
    }
  }
}
