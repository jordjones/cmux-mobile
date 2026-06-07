/**
 * terminal-view — render the plain-text buffer as one persistent DOM node per
 * row, so a frame patches only the changed rows instead of rebuilding the whole
 * grid every tick. This removes flicker, preserves in-progress text selection,
 * keeps scroll position stable, and (with stick-to-bottom) follows the tail.
 *
 * cmux pre-wraps rows at the Mac surface width; we render them as-is (each row a
 * `width:max-content` line) and let the container scroll horizontally.
 */
export class TerminalView {
  private rowEls: HTMLElement[] = [];

  constructor(private readonly el: HTMLElement) {}

  /** Full repaint to exactly `rows`. */
  render(rows: string[]): void {
    const s = this.beforeMutate();
    this.syncCount(rows.length);
    for (let y = 0; y < rows.length; y++) this.rowEls[y]!.textContent = rows[y]!;
    this.afterMutate(s);
  }

  /** Patch only the dirty rows, growing/shrinking the node list to `rows.length`. */
  applyDirty(rows: string[], dirty: number[]): void {
    const s = this.beforeMutate();
    this.syncCount(rows.length);
    for (const y of dirty) if (y < rows.length) this.rowEls[y]!.textContent = rows[y]!;
    this.afterMutate(s);
  }

  clear(): void {
    this.render([]);
  }

  private syncCount(n: number): void {
    while (this.rowEls.length < n) {
      const d = document.createElement("div");
      d.className = "row";
      this.el.appendChild(d);
      this.rowEls.push(d);
    }
    while (this.rowEls.length > n) {
      this.rowEls.pop()!.remove();
    }
  }

  private beforeMutate(): { pinned: boolean; top: number; left: number } {
    const el = this.el;
    return {
      pinned: el.scrollTop + el.clientHeight >= el.scrollHeight - 10,
      top: el.scrollTop,
      left: el.scrollLeft,
    };
  }

  private afterMutate(s: { pinned: boolean; top: number; left: number }): void {
    const el = this.el;
    el.scrollLeft = s.left;
    el.scrollTop = s.pinned ? el.scrollHeight : s.top;
  }
}
