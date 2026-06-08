/**
 * Verification — drive workspace.create / surface.create over the bridge
 * WebSocket end-to-end. Confirms each create yields a `created` frame AND a
 * `topology` containing the new surface. The throwaway workspace is closed via
 * the cmux socket in cleanup, so no real pane is touched.
 *
 *   bun run packages/bridge/src/main.ts &   # bridge must be running
 *   bun run scripts/ws-create-smoke.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:4380/ws";

const sock = new CmuxSocketClient();
await sock.connect();

const createdWorkspaces = new Set<string>();
let lastTopology: Array<{ surfaceId: string; workspaceId: string }> = [];
let firstSurfaceId: string | undefined;
let firstWorkspaceId: string | undefined;
let phase: "ws" | "surface" | "done" = "ws";

async function cleanup(code: number): Promise<void> {
  for (const wid of createdWorkspaces) {
    try {
      await sock.call("workspace.close", { workspace_id: wid });
      console.log(`scratch workspace ${wid} closed ✓`);
    } catch (e) {
      console.warn("cleanup failed for", wid, ":", (e as Error).message);
    }
  }
  sock.close();
  process.exit(code);
}

const topologyHas = (id: string): boolean => lastTopology.some((s) => s.surfaceId === id);

const ws = new WebSocket(WS_URL);
const timeout = setTimeout(() => {
  console.error("FAIL: timeout in phase", phase);
  void cleanup(1);
}, 15000);

ws.onopen = () => ws.send(JSON.stringify({ t: "hello", token: "" }));
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
  if (m.t === "error") {
    console.warn("  [error frame]", m.code, m.message);
    return;
  }
  if (m.t === "topology") {
    lastTopology = m.surfaces.map((s: { surfaceId: string; workspaceId: string }) => ({
      surfaceId: s.surfaceId,
      workspaceId: s.workspaceId,
    }));
    return;
  }
  if (m.t === "hello.ok") {
    console.log("→ creating a new workspace…");
    ws.send(JSON.stringify({ t: "workspace.create" }));
    return;
  }
  if (m.t === "created" && phase === "ws") {
    firstSurfaceId = m.surfaceId;
    firstWorkspaceId = m.workspaceId;
    createdWorkspaces.add(m.workspaceId);
    if (!topologyHas(m.surfaceId)) {
      console.error("FAIL: new workspace surface not in topology:", m.surfaceId);
      return void cleanup(1);
    }
    console.log(`workspace.create ✓ surface=${m.surfaceId} workspace=${m.workspaceId} (in topology)`);
    phase = "surface";
    console.log("→ adding a terminal to that workspace…");
    ws.send(JSON.stringify({ t: "surface.create", workspaceId: m.workspaceId }));
    return;
  }
  if (m.t === "created" && phase === "surface") {
    createdWorkspaces.add(m.workspaceId);
    if (m.surfaceId === firstSurfaceId) {
      console.error("FAIL: surface.create returned the same surface as workspace.create");
      return void cleanup(1);
    }
    if (m.workspaceId !== firstWorkspaceId) {
      console.warn("note: surface.create landed in a different workspace:", m.workspaceId);
    }
    if (!topologyHas(m.surfaceId)) {
      console.error("FAIL: new terminal surface not in topology:", m.surfaceId);
      return void cleanup(1);
    }
    console.log(`surface.create ✓ surface=${m.surfaceId} workspace=${m.workspaceId} (in topology)`);
    phase = "done";
    clearTimeout(timeout);
    console.log("\nboth creates round-tripped over WS ✓");
    ws.close();
    void cleanup(0);
    return;
  }
};
ws.onerror = (e) => {
  clearTimeout(timeout);
  console.error("FAIL ws error:", String((e as ErrorEvent).message ?? e));
  void cleanup(1);
};
