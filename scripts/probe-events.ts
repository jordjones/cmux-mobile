/**
 * G1 probe — does cmux's events.stream emit a per-surface OUTPUT/ACTIVITY event
 * (so the activity dot + notifications can hook events instead of polling)?
 * Opens the stream, generates output on a throwaway surface, and records every
 * distinct event name + whether it carries a surface id.
 *
 *   bun run scripts/probe-events.ts
 */
import { CmuxSocketClient, resolveSocketPath } from "../packages/bridge/src/socket-client.ts";

const seen = new Map<string, { count: number; sample: string }>();
let buf = "";

const evsock = await Bun.connect({
  unix: resolveSocketPath(),
  socket: {
    data: (_s, chunk) => {
      buf += Buffer.from(chunk).toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const f = JSON.parse(line) as { name?: string };
          if (f.name) {
            const cur = seen.get(f.name) ?? { count: 0, sample: JSON.stringify(f).slice(0, 200) };
            cur.count++;
            seen.set(f.name, cur);
          }
        } catch {
          /* ignore */
        }
      }
    },
    close: () => {},
    error: () => {},
  },
});
evsock.write(JSON.stringify({ id: "ev", method: "events.stream", params: { reconnect: true } }) + "\n");

// Generate output on a throwaway surface while we listen.
const ctl = new CmuxSocketClient();
await ctl.connect();
const c = await ctl.call<{ surface_id: string; workspace_id: string }>("workspace.create", {});
await ctl.call("surface.focus", { surface_id: c.surface_id });
await new Promise((r) => setTimeout(r, 600));
for (let i = 0; i < 6; i++) {
  await ctl.call("surface.send_text", { surface_id: c.surface_id, text: `echo activity-${i}\n` });
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 1200));

console.log(`scratch surface: ${c.surface_id}\n=== event names seen ===`);
for (const [name, info] of [...seen.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const carriesSurface = /surface|pane/i.test(info.sample);
  console.log(`  ${name}  ×${info.count}${carriesSurface ? "  [has surface/pane id]" : ""}`);
}
console.log("\n=== samples for output/activity-ish events ===");
for (const [name, info] of seen) {
  if (/output|activ|data|dirty|content|write|render/i.test(name)) console.log(`  ${name}: ${info.sample}`);
}

try {
  await ctl.call("workspace.close", { workspace_id: c.workspace_id });
  console.log("\nscratch closed ✓");
} catch (e) {
  console.warn("cleanup failed:", (e as Error).message);
}
try {
  evsock.end();
} catch {
  /* noop */
}
ctl.close();
process.exit(0);
