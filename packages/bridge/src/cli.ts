#!/usr/bin/env bun
/**
 * cmux-mobile — one binary to run and manage the bridge.
 *
 *   cmux-mobile [run]            start the bridge (default)
 *   cmux-mobile install          install as a launchd login agent (stays up, runs at login)
 *   cmux-mobile uninstall        remove the launchd agent
 *   cmux-mobile pair add <name>  mint a device token (token mode) + print a one-tap URL
 *   cmux-mobile pair list
 *   cmux-mobile pair revoke <id>
 *
 * Env: CMUX_BRIDGE_HOST/PORT/AUTH/NOTIFY_URL (see README) and CMUX_BRIDGE_LABEL (agent label).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadConfig } from "./config.ts";
import { run } from "./app-run.ts";
import { TailscaleVerifier, TokenStore } from "./auth.ts";

const SELF = fileURLToPath(import.meta.url); // dist/cli.js when packaged, src/cli.ts in dev
const SELF_DIR = dirname(SELF);
const LABEL = process.env.CMUX_BRIDGE_LABEL || "dev.cmuxmobile.bridge";
const BRIDGE_HOME = join(homedir(), ".cmux-bridge");
const LOG = join(BRIDGE_HOME, "bridge.log");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;

function cfgForRun(): ReturnType<typeof loadConfig> {
  const cfg = loadConfig();
  // Packaged: a prebuilt web bundle sits next to this binary → serve it directly.
  const packagedWeb = join(SELF_DIR, "web");
  if (existsSync(join(packagedWeb, "app.js"))) {
    cfg.webDir = packagedWeb;
    cfg.webEntry = null;
  }
  return cfg;
}

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function envVarsXml(): string {
  const vars: Record<string, string> = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    CMUX_BRIDGE_AUTH: process.env.CMUX_BRIDGE_AUTH || "tailnet",
  };
  for (const k of ["CMUX_BRIDGE_HOST", "CMUX_BRIDGE_PORT", "CMUX_BRIDGE_NOTIFY_URL"]) {
    if (process.env[k]) vars[k] = process.env[k]!;
  }
  return Object.entries(vars)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
}

function install(): void {
  mkdirSync(BRIDGE_HOME, { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(SELF)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envVarsXml()}
  </dict>
</dict>
</plist>
`;
  writeFileSync(PLIST, plist);
  Bun.spawnSync(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]); // ignore if not loaded
  Bun.spawnSync(["launchctl", "bootstrap", DOMAIN, PLIST]);
  Bun.spawnSync(["launchctl", "kickstart", "-k", `${DOMAIN}/${LABEL}`]);
  console.log(`Installed ${LABEL}.`);
  console.log(`Logs: ${LOG}  (open the printed URL on your phone, same tailnet)`);
}

function uninstall(): void {
  Bun.spawnSync(["launchctl", "bootout", `${DOMAIN}/${LABEL}`]);
  try {
    rmSync(PLIST);
  } catch {
    /* already gone */
  }
  console.log(`Uninstalled ${LABEL}.`);
}

async function pair(sub: string | undefined, arg: string | undefined): Promise<void> {
  const store = new TokenStore();
  if (sub === "list") {
    const devices = store.list();
    if (!devices.length) return void console.log("No paired devices.");
    for (const d of devices) {
      console.log(`${d.id}  ${d.name}${d.revoked ? " [REVOKED]" : ""}  created ${d.createdAt}  last ${d.lastSeenAt ?? "—"}`);
    }
    return;
  }
  if (sub === "revoke") {
    if (!arg) return void console.error("usage: cmux-mobile pair revoke <id>");
    console.log(store.revoke(arg) ? `Revoked ${arg}.` : `No active device ${arg}.`);
    return;
  }
  if (sub === "add") {
    const name = arg ?? "device";
    const { id, token } = store.mint(name);
    const ip = (await TailscaleVerifier.selfIPv4()) ?? "<mac-tailnet-ip>";
    const port = process.env.CMUX_BRIDGE_PORT ?? "4380";
    console.log(`Paired "${name}" (id ${id}). Token (shown once):\n  ${token}`);
    console.log(`\nOpen on the device (token rides in the URL fragment):\n  http://${ip}:${port}/#token=${token}`);
    return;
  }
  console.error("usage: cmux-mobile pair <add <name> | list | revoke <id>>");
}

function help(): void {
  console.log(`cmux-mobile — drive local cmux sessions from your phone over Tailscale.

  cmux-mobile [run]            start the bridge (default)
  cmux-mobile install          install as a launchd login agent
  cmux-mobile uninstall        remove the launchd agent
  cmux-mobile pair add <name>  mint a device token + print a one-tap URL
  cmux-mobile pair list
  cmux-mobile pair revoke <id>

Env: CMUX_BRIDGE_HOST, CMUX_BRIDGE_PORT (4380), CMUX_BRIDGE_AUTH (token|tailnet|off),
     CMUX_BRIDGE_NOTIFY_URL (ntfy/webhook), CMUX_BRIDGE_LABEL (launchd label).`);
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case undefined:
  case "run":
    await run(cfgForRun());
    break;
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "pair":
    await pair(a, b);
    break;
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}
