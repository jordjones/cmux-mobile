/**
 * M0 smoke — de-risk the cmux socket protocol from a plain Bun client (not the
 * `cmux` CLI). Proves the OUTPUT path (read_text) and, on an isolated scratch
 * surface, the INPUT path (send_text) end-to-end. Discovers the exact param
 * names/return shapes so the rest of the bridge is built on facts.
 *
 * SAFETY: never injects into the caller or focused surfaces (the user's real
 * panes). The input round-trip runs in a throwaway workspace that is closed in a
 * finally block.
 *
 *   bun run scripts/smoke.ts
 */
import { CmuxSocketClient, resolveSocketPath } from "../packages/bridge/src/socket-client.ts";

function show(label: string, value: unknown): void {
  let s: string;
  if (value === undefined) s = "(undefined)";
  else if (value === null) s = "(null)";
  else if (typeof value === "string") s = value;
  else s = JSON.stringify(value) ?? String(value);
  console.log(`${label}: ${s.length > 600 ? s.slice(0, 600) + " …(truncated)" : s}`);
}

/** Pick the first non-browser terminal surface ref from a surface.list result. */
function pickTerminalSurface(list: any): string | undefined {
  const arr = Array.isArray(list) ? list : list?.surfaces ?? list?.items;
  if (!Array.isArray(arr)) return undefined;
  for (const it of arr) {
    if (it?.is_browser_surface) continue;
    if (it?.surface_type && it.surface_type !== "terminal") continue;
    const ref = it?.surface_ref ?? it?.ref ?? it?.id;
    if (ref) return ref;
  }
  return undefined;
}

/** Try the common surface-addressing param names until one is accepted. */
async function readSurfaceText(
  client: CmuxSocketClient,
  ref: string,
): Promise<{ param: string; result: any }> {
  const variants = ["surface_id", "surface", "surface_ref"];
  let lastErr: unknown;
  for (const param of variants) {
    try {
      const result = await client.call("surface.read_text", { [param]: ref });
      return { param, result };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  console.log("=== cmux-mobile M0 smoke ===");
  console.log("socket path:", resolveSocketPath());

  const client = new CmuxSocketClient();
  await client.connect();
  console.log("connected ✓\n");

  // --- Phase A: read-only protocol proof -----------------------------------
  const caps = await client.call<any>("system.capabilities");
  show("access_mode", caps.access_mode);
  console.log("methods count:", Array.isArray(caps.methods) ? caps.methods.length : "?");

  const ident = await client.call<any>("system.identify");
  show("system.identify", ident);
  const callerRef: string | undefined = ident?.caller?.surface_ref;
  const focusedRef: string | undefined = ident?.focused?.surface_ref;

  const surfaces = await client.call<any>("surface.list");
  show("surface.list", surfaces);

  // Read-only target: prefer focused, then caller, then first terminal surface.
  const readTarget = focusedRef ?? callerRef ?? pickTerminalSurface(surfaces);
  if (!readTarget) throw new Error("no terminal surface available to read");
  console.log("read target:", readTarget);
  const { param, result: screen } = await readSurfaceText(client, readTarget);
  console.log(`\nread_text accepted param: "${param}"`);
  show("read_text result keys", Object.keys(screen ?? {}));
  const text: string | undefined = screen?.text ?? (typeof screen === "string" ? screen : undefined);
  console.log("read_text text length:", text?.length ?? "(no .text field)");
  // Reveal whether any ANSI escape bytes are present (expect none — plain text).
  const hasEsc = typeof text === "string" && text.includes("\u001b");
  console.log("contains ANSI ESC (0x1b):", hasEsc);
  if (typeof text === "string") {
    console.log("--- read_text preview (last 5 lines) ---");
    console.log(text.split("\n").slice(-5).join("\n"));
    console.log("--- end preview ---");
  }
  console.log("\nPhase A (output path) ✓");

  // --- Phase B: input round-trip on a throwaway surface --------------------
  console.log("\n=== Phase B: input round-trip on a scratch workspace ===");
  let workspaceRef: string | undefined;
  try {
    const created = await client.call<any>("workspace.create", {});
    show("workspace.create result", created);
    // Discover the new workspace + surface refs from whatever shape comes back.
    workspaceRef =
      created?.workspace_ref ?? created?.workspace?.ref ?? created?.ref ?? created?.workspace_id;
    let surfaceRef: string | undefined =
      created?.surface_ref ?? created?.surface?.ref ?? created?.focused?.surface_ref;

    // Fallback: ask the new workspace for its surfaces.
    if (!surfaceRef && workspaceRef) {
      const list = await client
        .call<any>("surface.list", { workspace_id: workspaceRef })
        .catch(() => client.call<any>("surface.list", { workspace: workspaceRef }));
      show("scratch surface.list", list);
      const arr = Array.isArray(list) ? list : list?.surfaces;
      surfaceRef = arr?.[0]?.surface_ref ?? arr?.[0]?.ref ?? arr?.[0]?.id;
    }
    console.log("scratch workspaceRef:", workspaceRef, "surfaceRef:", surfaceRef);

    if (surfaceRef) {
      const marker = "cmux_mobile_smoke_ok";
      // Send the echo. Discover send_text param name the same way.
      const sendVariants = ["surface_id", "surface", "surface_ref"];
      let sent = false;
      for (const p of sendVariants) {
        try {
          await client.call("surface.send_text", { [p]: surfaceRef, text: `echo ${marker}\n` });
          console.log(`send_text accepted param: "${p}"`);
          sent = true;
          break;
        } catch (e) {
          /* try next */
        }
      }
      if (!sent) throw new Error("send_text rejected for all param variants");

      // Poll read_text until the echo output appears (the shell prints the marker
      // on its own line, distinct from the typed command).
      let seen = false;
      for (let i = 0; i < 30 && !seen; i++) {
        await Bun.sleep(100);
        const { result } = await readSurfaceText(client, surfaceRef);
        const t: string = result?.text ?? "";
        // Count occurrences: command line + output line => >=2 means it ran.
        const count = t.split(marker).length - 1;
        if (count >= 2) seen = true;
      }
      console.log(seen ? "input→output round-trip ✓ (echo output observed)" : "echo output NOT observed ✗");
      if (!seen) process.exitCode = 1;
    } else {
      console.log("could not resolve a scratch surface ref — input round-trip skipped ✗");
      process.exitCode = 1;
    }
  } finally {
    if (workspaceRef) {
      for (const p of ["workspace_id", "workspace", "workspace_ref"]) {
        try {
          await client.call("workspace.close", { [p]: workspaceRef });
          console.log(`scratch workspace closed (param "${p}") ✓`);
          break;
        } catch {
          /* try next */
        }
      }
    }
  }

  client.close();
  console.log("\n=== smoke complete ===");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
