/**
 * screen-model — client-side row buffer for the subscribed surface. Applies
 * screen.full / screen.diff frames per-row (so the view can patch only changed
 * rows) and reconciles against screen.checksum, asking the caller to resync on
 * divergence.
 *
 * An `awaitingFull` latch (armed on subscribe/resync/resume) makes diffs and
 * checksums no-op until the next screen.full lands, so an ordered WS stream
 * converges without a brittle client-side rev fence.
 */
import { screenHash, type ServerMessage } from "@cmux-mobile/protocol";

/** Payload handed to the view: a full repaint, or a set of dirty row indices. */
export interface ScreenUpdate {
  full: boolean;
  rows: string[];
  dirty?: number[];
}

export class ScreenModel {
  rows: string[] = [];
  rev = 0;
  surfaceId: string | null = null;
  private awaitingFull = true;
  /** When the awaitingFull latch was last armed (perf clock); 0 once a full lands. Drives the stale-recovery watchdog. */
  awaitingFullSince = 0;

  constructor(private readonly onUpdate: (u: ScreenUpdate) => void) {}

  /** True while we're waiting for an authoritative full frame (diffs/checksums are no-ops until it lands). */
  get isAwaitingFull(): boolean {
    return this.awaitingFull;
  }

  /** Switch the active surface; clears the buffer and waits for the next full frame. */
  setSurface(id: string): void {
    this.surfaceId = id;
    this.rows = [];
    this.rev = 0;
    this.awaitingFull = true;
    this.awaitingFullSince = performance.now();
    this.onUpdate({ full: true, rows: [] });
  }

  /** Expect a fresh full frame next (call when (re)subscribing or resyncing). */
  armFull(): void {
    this.awaitingFull = true;
    this.awaitingFullSince = performance.now();
  }

  /**
   * Apply a server frame. Returns true if the caller should request a resync
   * (checksum mismatch on a settled screen).
   */
  apply(msg: ServerMessage): boolean {
    switch (msg.t) {
      case "screen.full":
        if (msg.surfaceId !== this.surfaceId) return false;
        this.rows = msg.rows.slice();
        this.rev = msg.rev;
        this.awaitingFull = false;
        this.awaitingFullSince = 0;
        this.onUpdate({ full: true, rows: this.rows });
        return false;

      case "screen.diff": {
        if (msg.surfaceId !== this.surfaceId || this.awaitingFull) return false;
        for (const op of msg.ops) {
          while (this.rows.length <= op.y) this.rows.push("");
          this.rows[op.y] = op.text;
        }
        // Mirror the bridge's normalizeRows tail-trim so client rows == bridge
        // rows and screenHash matches (else checksum diverges forever).
        while (this.rows.length > 0 && this.rows[this.rows.length - 1] === "") this.rows.pop();
        this.rev = msg.rev;
        this.onUpdate({ full: false, rows: this.rows, dirty: msg.ops.map((o) => o.y) });
        return false;
      }

      case "screen.checksum":
        if (msg.surfaceId !== this.surfaceId || this.awaitingFull) return false;
        return screenHash(this.rows) !== msg.hash;

      default:
        return false;
    }
  }
}
