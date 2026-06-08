/**
 * Wire protocol shared between the bridge and the PWA.
 *
 * Transport: a single WebSocket per client. Messages are JSON objects with a
 * `t` discriminant. Screen content is delivered as plain text rows (cmux's
 * socket exposes no ANSI/colour), reconciled by a monotonically increasing
 * `rev` plus a periodic `screen.checksum`.
 */

/** A cmux surface ref ("surface:N") or its UUID — both are accepted by cmux. */
export type SurfaceId = string;

/** A terminal surface as advertised to the client for the picker. */
export interface SurfaceInfo {
  surfaceId: string;
  surfaceRef: string;
  workspaceId: string;
  workspaceRef: string;
  workspaceTitle?: string;
  windowRef: string;
  title?: string;
  cwd?: string;
}

/** Single-row replacement op in a screen.diff. */
export interface RowOp {
  /** zero-based row index within the viewport */
  y: number;
  text: string;
}

// ---------------------------------------------------------------------------
// client -> server
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { t: "hello"; token: string }
  | { t: "list" }
  | { t: "subscribe"; surfaceId: SurfaceId }
  | { t: "unsubscribe"; surfaceId: SurfaceId }
  | { t: "input.text"; surfaceId: SurfaceId; text: string }
  | { t: "input.key"; surfaceId: SurfaceId; key: string }
  | { t: "scrollback"; surfaceId: SurfaceId; lines: number }
  | { t: "resync"; surfaceId: SurfaceId }
  | { t: "pause"; surfaceId: SurfaceId }
  | { t: "resume"; surfaceId: SurfaceId }
  // Create a fresh workspace (cmux opens a new terminal on creation), or add a
  // terminal to an existing workspace. The bridge replies with a `created`
  // frame carrying the new surfaceId so the client can auto-open it.
  | { t: "workspace.create" }
  | { t: "surface.create"; workspaceId: string }
  // Liveness heartbeat: the client pings on a timer and force-reconnects if no
  // pong arrives, so half-open sockets (common on iOS network handoffs) are
  // detected instead of silently freezing the mirror.
  | { t: "ping" };

// ---------------------------------------------------------------------------
// server -> client
// ---------------------------------------------------------------------------
export interface ServerCaps {
  /** false in v1 (monochrome plain-text mirror) */
  color: boolean;
}

export type ServerMessage =
  | { t: "hello.ok"; device: string; caps: ServerCaps }
  | { t: "topology"; surfaces: SurfaceInfo[] }
  // Ack for workspace.create / surface.create: the freshly created terminal the
  // client should auto-open (it also lands in the topology sent just before this).
  | { t: "created"; surfaceId: SurfaceId; workspaceId: string }
  | { t: "screen.full"; surfaceId: SurfaceId; rev: number; cols: number; rows: string[] }
  | { t: "screen.diff"; surfaceId: SurfaceId; rev: number; ops: RowOp[] }
  | { t: "screen.checksum"; surfaceId: SurfaceId; rev: number; hash: string }
  // One-shot history snapshot (last N lines incl. scrollback) for the client's history view.
  | { t: "scrollback"; surfaceId: SurfaceId; rows: string[] }
  // Surfaces (other than the one you're viewing) that are blocked waiting for input → picker dot.
  | { t: "activity"; attention: SurfaceId[] }
  | { t: "pong" }
  | { t: "event"; kind: string; data?: unknown }
  | { t: "error"; code: string; message: string };

export type ClientMessageType = ClientMessage["t"];
export type ServerMessageType = ServerMessage["t"];

/**
 * Deterministic, dependency-free screen checksum (FNV-1a 32-bit) used by BOTH
 * the bridge and the PWA so drift reconciliation compares identical values
 * across runtimes. Not cryptographic — only needs to detect divergence.
 */
export function screenHash(rows: readonly string[]): string {
  const s = rows.join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
