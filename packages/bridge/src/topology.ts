/**
 * topology — enumerate terminal surfaces from cmux's `system.tree` and resolve
 * a handle (UUID or ref) to its SurfaceInfo. Browser surfaces are filtered out.
 */
import type { CmuxSocketClient } from "./socket-client.ts";
import type { SurfaceInfo } from "@cmux-mobile/protocol";

interface TreeSurface {
  type?: string;
  id: string;
  ref: string;
  title?: string;
  url?: string | null;
}
interface TreePane {
  surfaces?: TreeSurface[];
}
interface TreeWorkspace {
  id: string;
  ref: string;
  title?: string;
  panes?: TreePane[];
}
interface TreeWindow {
  id: string;
  ref: string;
  workspaces?: TreeWorkspace[];
}
interface Tree {
  windows?: TreeWindow[];
}

export class Topology {
  constructor(private readonly client: CmuxSocketClient) {}

  /** All terminal surfaces across every window/workspace, in tree order. */
  async list(): Promise<SurfaceInfo[]> {
    const tree = await this.client.call<Tree>("system.tree");
    const out: SurfaceInfo[] = [];
    for (const w of tree.windows ?? []) {
      for (const ws of w.workspaces ?? []) {
        for (const pane of ws.panes ?? []) {
          for (const s of pane.surfaces ?? []) {
            if (s.type && s.type !== "terminal") continue;
            out.push({
              surfaceId: s.id,
              surfaceRef: s.ref,
              workspaceId: ws.id,
              workspaceRef: ws.ref,
              workspaceTitle: ws.title,
              windowRef: w.ref,
              title: s.title,
            });
          }
        }
      }
    }
    return out;
  }

  /** Resolve a UUID or ref to its SurfaceInfo, or undefined if it no longer exists. */
  async resolve(handle: string): Promise<SurfaceInfo | undefined> {
    const all = await this.list();
    return all.find((s) => s.surfaceId === handle || s.surfaceRef === handle);
  }
}
