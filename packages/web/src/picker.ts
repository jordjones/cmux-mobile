/**
 * picker — render the surface list (grouped by workspace) with a type-to-filter
 * search and a strong active-row marker. Long titles are ellipsized (CSS).
 */
import type { SurfaceInfo } from "@cmux-mobile/protocol";

export class Picker {
  private surfaces: SurfaceInfo[] = [];
  private activeId: string | null = null;
  private filter = "";
  private attention = new Set<string>();

  constructor(
    private readonly el: HTMLElement,
    private readonly onSelect: (surfaceId: string) => void,
  ) {}

  render(surfaces: SurfaceInfo[], activeId: string | null, attention?: ReadonlySet<string>): void {
    this.surfaces = surfaces;
    this.activeId = activeId;
    this.attention = new Set(attention ?? []);
    this.draw();
  }

  /** Case-insensitive substring filter over surface + workspace titles. */
  setFilter(text: string): void {
    this.filter = text.toLowerCase().trim();
    this.draw();
  }

  private draw(): void {
    this.el.replaceChildren();
    const f = this.filter;
    const matches = f
      ? this.surfaces.filter((s) =>
          `${s.title ?? ""} ${s.workspaceTitle ?? ""}`.toLowerCase().includes(f),
        )
      : this.surfaces;

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "picker-empty";
      empty.textContent = f ? "No matching terminals." : "No terminals.";
      this.el.append(empty);
      return;
    }

    let lastWorkspace = "";
    for (const s of matches) {
      if (s.workspaceRef !== lastWorkspace) {
        lastWorkspace = s.workspaceRef;
        const hdr = document.createElement("div");
        hdr.className = "picker-group";
        hdr.textContent = s.workspaceTitle?.trim() || s.workspaceRef;
        this.el.append(hdr);
      }
      const btn = document.createElement("button");
      const active = s.surfaceId === this.activeId;
      // "needs input" dot — but never on the surface you're already viewing.
      const attn = this.attention.has(s.surfaceId) && !active;
      btn.className = "picker-item" + (active ? " active" : "") + (attn ? " attn" : "");
      if (active) btn.setAttribute("aria-selected", "true");
      if (attn) btn.setAttribute("aria-label", `${s.title?.trim() || s.surfaceRef} — needs input`);
      const label = s.title?.trim() || s.surfaceRef;
      btn.textContent = label;
      // Full name on the ellipsized row (hover / accessibility) since titles are clipped.
      btn.title = s.workspaceTitle?.trim() ? `${s.workspaceTitle.trim()} — ${label}` : label;
      btn.addEventListener("click", () => this.onSelect(s.surfaceId));
      this.el.append(btn);
    }
  }
}
