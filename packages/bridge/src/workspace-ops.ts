/**
 * workspace-ops — the mutating "create" calls to cmux, kept in one place (the
 * sibling of input-router.ts for input). Both methods focus the new surface so
 * its terminal renders eagerly: cmux renders a fresh surface lazily and
 * `surface.read_text` returns `Terminal surface not found` until it is focused,
 * which would otherwise leave the mobile mirror stuck on "surface unavailable".
 *
 * RPCs verified against cmux 0.64.x via `scripts/probe-surface-create.ts`:
 *   - `workspace.create {}`              → new workspace + its first terminal
 *   - `surface.create {workspace_id}`    → an extra terminal in an existing
 *                                          workspace (new tab in its active pane;
 *                                          does NOT force a split layout)
 * Both return `{surface_id, workspace_id, …}`.
 */
import type { CmuxSocketClient } from "./socket-client.ts";

interface CreateResult {
  surface_id: string;
  workspace_id: string;
}

export interface CreatedSurface {
  surfaceId: string;
  workspaceId: string;
}

export class WorkspaceOps {
  constructor(private readonly client: CmuxSocketClient) {}

  /** Create a new workspace (cmux opens a fresh terminal) and focus it. */
  async createWorkspace(): Promise<CreatedSurface> {
    const r = await this.client.call<CreateResult>("workspace.create", {});
    return this.focused(r);
  }

  /** Add a terminal to an existing workspace and focus it. */
  async createSurface(workspaceId: string): Promise<CreatedSurface> {
    const r = await this.client.call<CreateResult>("surface.create", { workspace_id: workspaceId });
    return this.focused(r);
  }

  /** Focus the new surface so it renders, then normalize the result. */
  private async focused(r: CreateResult): Promise<CreatedSurface> {
    // Best-effort: a focus failure shouldn't fail the create — the surface still
    // exists and the mirror's lazy-render backoff will eventually pick it up.
    await this.client.call("surface.focus", { surface_id: r.surface_id }).catch(() => {});
    return { surfaceId: r.surface_id, workspaceId: r.workspace_id };
  }
}
