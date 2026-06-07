/**
 * surface-watcher — a low-rate poll across ALL surfaces (not just the active
 * mirror) that detects when a surface becomes blocked waiting for input. On the
 * rising edge it fires a webhook (so you're alerted even with the PWA closed),
 * and every tick it broadcasts the set of attention-needing surfaces so the
 * picker can show a dot. Runs continuously in the bridge process.
 */
import type { CmuxSocketClient } from "./socket-client.ts";
import type { Topology } from "./topology.ts";
import { normalizeRows } from "./screen-diff.ts";
import { isWaitingForInput } from "./prompt-detect.ts";

const DEFAULT_POLL_MS = 2500;

export interface SurfaceWatcherDeps {
  client: CmuxSocketClient;
  topology: Topology;
  onNotify: (title: string, message: string) => void;
  onActivity: (attention: string[]) => void;
  /** Poll interval in ms (default 2500). Lowered in tests. */
  pollMs?: number;
}

export class SurfaceWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly pollMs: number;
  /** surfaceId → was-waiting last tick (for rising-edge notification). */
  private readonly waiting = new Map<string, boolean>();

  constructor(private readonly deps: SurfaceWatcherDeps) {
    this.pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const surfaces = await this.deps.topology.list();
      // Read every surface concurrently so one slow/hung surface can't stall the
      // tick (worst case was N×timeout serially); keep last state on a read error.
      const reads = await Promise.allSettled(
        surfaces.map((s) =>
          this.deps.client.call<{ text?: string }>("surface.read_text", { surface_id: s.surfaceId }, 2500),
        ),
      );
      const present = new Set<string>();
      const attention: string[] = [];
      surfaces.forEach((s, i) => {
        present.add(s.surfaceId);
        const r = reads[i];
        const waiting =
          r && r.status === "fulfilled"
            ? isWaitingForInput(normalizeRows(r.value?.text ?? ""))
            : (this.waiting.get(s.surfaceId) ?? false);
        const prev = this.waiting.get(s.surfaceId) ?? false;
        this.waiting.set(s.surfaceId, waiting);
        if (waiting) attention.push(s.surfaceId);
        if (waiting && !prev) {
          // Use the workspace title (or ref) — NOT the surface title, which often
          // carries the running command/cwd — so the off-machine webhook stays generic.
          const name = (s.workspaceTitle?.trim() || s.surfaceRef).slice(0, 60);
          this.deps.onNotify("cmux — input needed", `${name} is waiting for input`);
        }
      });
      // forget surfaces that no longer exist
      for (const id of [...this.waiting.keys()]) if (!present.has(id)) this.waiting.delete(id);
      this.deps.onActivity(attention);
    } catch {
      /* topology failed this tick — try again next time */
    }
    this.schedule(this.pollMs);
  }
}
