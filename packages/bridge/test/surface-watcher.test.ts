import { test, expect } from "bun:test";
import { SurfaceWatcher } from "../src/surface-watcher.ts";
import type { CmuxSocketClient } from "../src/socket-client.ts";
import type { Topology } from "../src/topology.ts";

interface Sink {
  notifies: Array<{ title: string; message: string }>;
  activity: string[];
}

function makeWatcher(textBySurface: Record<string, string>, sink: Sink): SurfaceWatcher {
  const client = {
    call: async (_m: string, p: { surface_id: string }) => ({ text: textBySurface[p.surface_id] ?? "" }),
  } as unknown as CmuxSocketClient;
  const topology = {
    list: async () =>
      Object.keys(textBySurface).map((id) => ({
        surfaceId: id,
        surfaceRef: id,
        workspaceId: "w",
        workspaceRef: "w",
        windowRef: "win",
      })),
  } as unknown as Topology;
  return new SurfaceWatcher({
    client,
    topology,
    pollMs: 10,
    onNotify: (title, message) => sink.notifies.push({ title, message }),
    onActivity: (a) => (sink.activity = a),
  });
}

test("notifies once on the rising edge and reports attention", async () => {
  const sink: Sink = { notifies: [], activity: [] };
  const w = makeWatcher({ s1: "Proceed with changes? [y/n]", s2: "all done" }, sink);
  w.start();
  await new Promise((r) => setTimeout(r, 70)); // several 10ms ticks
  w.stop();
  expect(sink.activity).toEqual(["s1"]);
  expect(sink.notifies.length).toBe(1); // rising edge only, not every tick
  expect(sink.notifies[0]!.title.toLowerCase()).toContain("input");
});

test("idle surfaces never notify", async () => {
  const sink: Sink = { notifies: [], activity: [] };
  const w = makeWatcher({ s1: "building...", s2: "done" }, sink);
  w.start();
  await new Promise((r) => setTimeout(r, 50));
  w.stop();
  expect(sink.notifies.length).toBe(0);
  expect(sink.activity).toEqual([]);
});
