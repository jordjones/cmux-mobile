/**
 * GATE probe — which cmux RPC adds a terminal SURFACE to an EXISTING workspace?
 *
 * `workspace.create {}` makes a whole new workspace; this probe discovers the
 * separate call that adds another terminal to a workspace you already have
 * (the "+ terminal" feature). Strategy:
 *   1. Dump system.capabilities.methods filtered to surface/pane/workspace —
 *      the authoritative list of what cmux actually exposes.
 *   2. Empirically try candidate methods against a THROWAWAY workspace, report
 *      which succeeds + its return shape (so we learn the new surface_id field).
 * Never touches a real pane; the scratch workspace is closed in a finally.
 *
 *   bun run scripts/probe-surface-create.ts
 */
import { CmuxSocketClient } from "../packages/bridge/src/socket-client.ts";

function show(label: string, value: unknown): void {
  let s: string;
  if (value === undefined) s = "(undefined)";
  else if (value === null) s = "(null)";
  else if (typeof value === "string") s = value;
  else s = JSON.stringify(value) ?? String(value);
  console.log(`${label}: ${s.length > 800 ? s.slice(0, 800) + " …(truncated)" : s}`);
}

const sock = new CmuxSocketClient();
await sock.connect();
console.log("connected ✓\n");

// --- 1. Authoritative method catalog --------------------------------------
const caps = await sock.call<any>("system.capabilities");
const methods: string[] = Array.isArray(caps?.methods) ? caps.methods : [];
console.log("access_mode:", caps?.access_mode, "· total methods:", methods.length);
const relevant = methods.filter((m) => /surface|pane|workspace|window|tab|split/i.test(m)).sort();
console.log("\n=== surface/pane/workspace/window/tab/split methods ===");
for (const m of relevant) console.log("  " + m);
console.log("");

// --- 2. Throwaway workspace to add a second surface into -------------------
const created = await sock.call<{ surface_id: string; workspace_id: string }>("workspace.create", {});
const wid = created.workspace_id;
const seedSid = created.surface_id;
await sock.call("surface.focus", { surface_id: seedSid }).catch(() => {});
console.log(`scratch workspace ${wid} (seed surface ${seedSid})\n`);

// How many surfaces does this workspace report right now? (baseline for "did it add one?")
async function surfaceCount(): Promise<number> {
  for (const key of ["workspace_id", "workspace", "workspace_ref"]) {
    try {
      const list = await sock.call<any>("surface.list", { [key]: wid });
      const arr = Array.isArray(list) ? list : list?.surfaces ?? list?.items;
      if (Array.isArray(arr)) return arr.length;
    } catch {
      /* try next param */
    }
  }
  return -1;
}
const baseline = await surfaceCount();
console.log("baseline surface count in scratch workspace:", baseline, "\n");

type Candidate = { method: string; params: Record<string, unknown> };
const candidates: Candidate[] = [
  { method: "surface.create", params: { workspace_id: wid } },
  { method: "surface.create", params: { workspace: wid } },
  { method: "surface.new", params: { workspace_id: wid } },
  { method: "surface.open", params: { workspace_id: wid } },
  { method: "surface.add", params: { workspace_id: wid } },
  { method: "surface.split", params: { surface_id: seedSid } },
  { method: "surface.split", params: { surface_id: seedSid, direction: "right" } },
  { method: "pane.create", params: { workspace_id: wid } },
  { method: "pane.split", params: { surface_id: seedSid } },
  { method: "pane.split", params: { pane_id: seedSid } },
  { method: "workspace.add_surface", params: { workspace_id: wid } },
  { method: "workspace.new_surface", params: { workspace_id: wid } },
  { method: "workspace.split", params: { workspace_id: wid } },
  { method: "tab.create", params: { workspace_id: wid } },
];

const winners: { candidate: Candidate; result: unknown }[] = [];
try {
  console.log("=== trying candidates ===");
  for (const c of candidates) {
    // Skip methods the catalog says don't exist (saves noise) — but still try if
    // the catalog was empty/unavailable.
    if (methods.length > 0 && !methods.includes(c.method)) {
      console.log(`  SKIP  ${c.method} ${JSON.stringify(c.params)} (not in catalog)`);
      continue;
    }
    try {
      const result = await sock.call<any>(c.method, c.params, 6000);
      console.log(`  ✅ OK  ${c.method} ${JSON.stringify(c.params)}`);
      show("        →", result);
      winners.push({ candidate: c, result });
    } catch (e) {
      console.log(`  ✗ FAIL ${c.method} ${JSON.stringify(c.params)} → ${(e as Error).message}`);
    }
  }
  const after = await surfaceCount();
  console.log("\nsurface count after probing:", after, `(baseline ${baseline})`);
} finally {
  for (const key of ["workspace_id", "workspace", "workspace_ref"]) {
    try {
      await sock.call("workspace.close", { [key]: wid });
      console.log(`scratch workspace closed (param "${key}") ✓`);
      break;
    } catch {
      /* try next */
    }
  }
  sock.close();
}

console.log("\n=== SUMMARY ===");
if (winners.length === 0) {
  console.log("No candidate method added a surface. Inspect the method catalog above for the right name/params.");
  process.exitCode = 1;
} else {
  for (const w of winners) {
    console.log(`WINNER: ${w.candidate.method} ${JSON.stringify(w.candidate.params)}`);
    const r = w.result as any;
    const newSid = r?.surface_id ?? r?.surface?.id ?? r?.surface_ref ?? r?.id;
    console.log("   new surface id field →", newSid ?? "(could not locate surface_id in result)");
  }
}
