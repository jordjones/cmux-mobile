/**
 * C1 GATE probe — does cmux's socket expose terminal history (scrollback) beyond
 * the visible viewport? Read-only: picks an existing surface and tries
 * surface.read_text with several history-ish params, plus a few alternative
 * method names. Reports line counts so we can pick the scrollback strategy.
 *
 *   bun run scripts/probe-scrollback.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";
import { Topology } from "../packages/bridge/src/topology.ts";

const client = new CmuxSocketClient();
await client.connect();

function lineCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split("\n").length;
}

const surfaces = await new Topology(client).list();
const sid = surfaces[0]?.surfaceId;
if (!sid) {
  console.log("no surface to probe");
  client.close();
  process.exit(1);
}
console.log(`probing surface: ${sid} (${surfaces[0]?.title ?? ""})\n`);

const base = await client.call<{ text?: string }>("surface.read_text", { surface_id: sid }, 5000);
const baseLines = lineCount(base?.text);
console.log(`baseline read_text (viewport): ${baseLines} lines\n`);

// 1) Does read_text accept a history/lines param that returns MORE than the viewport?
const paramVariants: Array<Record<string, unknown>> = [
  { surface_id: sid, lines: 2000 },
  { surface_id: sid, scrollback: 2000 },
  { surface_id: sid, max_lines: 2000 },
  { surface_id: sid, history: 2000 },
  { surface_id: sid, history: true },
  { surface_id: sid, rows: 2000 },
  { surface_id: sid, include_scrollback: true },
];
console.log("=== read_text param variants ===");
for (const params of paramVariants) {
  try {
    const r = await client.call<{ text?: string }>("surface.read_text", params, 5000);
    const n = lineCount(r?.text);
    const verdict = n > baseLines ? `  <<< MORE than baseline (${n} > ${baseLines}) — HISTORY!` : "(same/less)";
    console.log(`  ${JSON.stringify(params)} -> ${n} lines ${verdict}`);
  } catch (e) {
    console.log(`  ${JSON.stringify(params)} -> ERROR: ${(e as Error).message}`);
  }
}

// 2) Alternative method names that might return scrollback.
console.log("\n=== alternative methods ===");
const methods = [
  "surface.read_scrollback",
  "surface.scrollback",
  "surface.read_history",
  "surface.history",
  "surface.dump",
  "surface.read_buffer",
  "surface.get_buffer",
];
for (const m of methods) {
  try {
    const r = await client.call<unknown>(m, { surface_id: sid, lines: 2000 }, 5000);
    const text = (r as { text?: string })?.text;
    console.log(`  ${m} -> OK ${text !== undefined ? `(${lineCount(text)} lines)` : JSON.stringify(r)?.slice(0, 120)}`);
  } catch (e) {
    console.log(`  ${m} -> ${(e as Error).message}`);
  }
}

client.close();
