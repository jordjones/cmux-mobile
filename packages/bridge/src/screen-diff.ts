/**
 * Pure screen-diff helpers (no I/O — unit tested in screen-diff.test.ts).
 *
 * cmux's `surface.read_text` returns the rendered screen as plain text. We
 * normalise it into rows, diff row-by-row, and checksum the whole screen for
 * drift reconciliation.
 */
import type { RowOp } from "@cmux-mobile/protocol";

/**
 * Split read_text output into rows, stripping trailing whitespace per row and
 * dropping trailing blank rows (which churn constantly as a TUI redraws).
 */
export function normalizeRows(text: string): string[] {
  const rows = text.split("\n").map((r) => r.replace(/[ \t]+$/g, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

/** Width of the widest row, for sizing the client grid. */
export function maxCols(rows: string[]): number {
  let m = 0;
  for (const r of rows) if (r.length > m) m = r.length;
  return m;
}

/**
 * Row-granular diff. Caller should prefer a full snapshot when the row COUNT
 * changes (the client can't infer truncation from row ops alone); this tolerates
 * unequal lengths defensively but is normally called on equal-length screens.
 */
export function diffRows(prev: readonly string[], next: readonly string[]): RowOp[] {
  const ops: RowOp[] = [];
  const n = Math.max(prev.length, next.length);
  for (let y = 0; y < n; y++) {
    const a = prev[y] ?? "";
    const b = next[y] ?? "";
    if (a !== b) ops.push({ y, text: b });
  }
  return ops;
}

// Screen checksum lives in @cmux-mobile/protocol (screenHash) so the bridge and
// PWA compute it identically.
