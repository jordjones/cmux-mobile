import { test, expect } from "bun:test";
import { WorkspaceOps } from "../src/workspace-ops.ts";
import type { CmuxSocketClient } from "../src/socket-client.ts";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** A fake socket client that records calls and returns a fixed create result. */
function makeOps(reply: Record<string, unknown>): { ops: WorkspaceOps; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return method === "surface.focus" ? {} : reply;
    },
  } as unknown as CmuxSocketClient;
  return { ops: new WorkspaceOps(client), calls };
}

test("createWorkspace calls workspace.create then focuses the new surface", async () => {
  const { ops, calls } = makeOps({ surface_id: "S1", workspace_id: "W1" });
  const res = await ops.createWorkspace();
  expect(res).toEqual({ surfaceId: "S1", workspaceId: "W1" });
  expect(calls.map((c) => c.method)).toEqual(["workspace.create", "surface.focus"]);
  expect(calls[0]!.params).toEqual({});
  expect(calls[1]!.params).toEqual({ surface_id: "S1" });
});

test("createSurface adds a terminal to the given workspace then focuses it", async () => {
  const { ops, calls } = makeOps({ surface_id: "S2", workspace_id: "W9" });
  const res = await ops.createSurface("W9");
  expect(res).toEqual({ surfaceId: "S2", workspaceId: "W9" });
  expect(calls.map((c) => c.method)).toEqual(["surface.create", "surface.focus"]);
  expect(calls[0]!.params).toEqual({ workspace_id: "W9" });
  expect(calls[1]!.params).toEqual({ surface_id: "S2" });
});

test("a focus failure does not fail the create (lazy-render backoff handles it)", async () => {
  const calls: Call[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "surface.focus") throw new Error("Terminal surface not found");
      return { surface_id: "S3", workspace_id: "W3" };
    },
  } as unknown as CmuxSocketClient;
  const ops = new WorkspaceOps(client);
  const res = await ops.createWorkspace();
  expect(res).toEqual({ surfaceId: "S3", workspaceId: "W3" });
  expect(calls.map((c) => c.method)).toEqual(["workspace.create", "surface.focus"]);
});
