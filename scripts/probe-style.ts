/**
 * G2/G3 probe — can cmux return STYLED output (for color), and does it expose
 * ALT-SCREEN / TUI mode per surface (for smart wrap gating)? Read-only.
 *
 *   bun run scripts/probe-style.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";
import { Topology } from "../packages/bridge/src/topology.ts";

const client = new CmuxSocketClient();
await client.connect();
const surfaces = await new Topology(client).list();
const sid = surfaces[0]?.surfaceId;
if (!sid) {
  console.log("no surface to probe");
  client.close();
  process.exit(1);
}
console.log(`probing surface ${sid}\n`);

const hasEsc = (t: string | undefined): boolean => !!t && t.includes("");

// G2a — does read_text take a param that returns ANSI/escapes?
console.log("=== G2: read_text style params (look for ESC bytes) ===");
const variants: Array<Record<string, unknown>> = [
  { surface_id: sid },
  { surface_id: sid, ansi: true },
  { surface_id: sid, styled: true },
  { surface_id: sid, format: "ansi" },
  { surface_id: sid, raw: true },
  { surface_id: sid, color: true },
  { surface_id: sid, escapes: true },
  { surface_id: sid, include_styles: true },
];
for (const params of variants) {
  try {
    const r = await client.call<{ text?: string }>("surface.read_text", params, 5000);
    console.log(`  ${JSON.stringify(params)} -> esc=${hasEsc(r?.text)} len=${r?.text?.length ?? 0}`);
  } catch (e) {
    console.log(`  ${JSON.stringify(params)} -> ERROR: ${(e as Error).message}`);
  }
}

// G2b — alternative styled/cell read methods.
console.log("\n=== G2: alternative styled methods ===");
for (const m of [
  "surface.read_styled",
  "surface.read_ansi",
  "surface.read_cells",
  "surface.read_screen",
  "surface.cells",
  "surface.snapshot",
  "surface.read",
]) {
  try {
    const r = await client.call<unknown>(m, { surface_id: sid }, 5000);
    console.log(`  ${m} -> OK: ${JSON.stringify(r)?.slice(0, 160)}`);
  } catch (e) {
    console.log(`  ${m} -> ${(e as Error).message}`);
  }
}

// G3 — what per-surface metadata does system.tree expose (alt-screen / mode / app)?
console.log("\n=== G3: raw surface metadata keys from system.tree ===");
const tree = await client.call<any>("system.tree", {});
let firstSurface: any;
for (const w of tree.windows ?? [])
  for (const ws of w.workspaces ?? [])
    for (const p of ws.panes ?? [])
      for (const s of p.surfaces ?? []) {
        firstSurface ??= s;
      }
console.log("  surface keys:", firstSurface ? Object.keys(firstSurface).join(", ") : "(none)");
console.log("  surface sample:", JSON.stringify(firstSurface)?.slice(0, 400));

// surface.info / surface.get if they exist
for (const m of ["surface.info", "surface.get", "surface.status"]) {
  try {
    const r = await client.call<unknown>(m, { surface_id: sid }, 4000);
    console.log(`  ${m} -> OK: ${JSON.stringify(r)?.slice(0, 300)}`);
  } catch (e) {
    console.log(`  ${m} -> ${(e as Error).message}`);
  }
}

client.close();
