/**
 * config — bridge runtime configuration.
 *
 * Auth modes (CMUX_BRIDGE_AUTH):
 *   - "token"   (default): Tailscale identity gate + a per-device bearer token.
 *   - "tailnet"          : Tailscale identity only — any device on the host's own
 *                          tailnet connects with no token/code. Needs no client
 *                          storage, so it survives iOS wiping PWA localStorage.
 *   - "off"              : no gating at all (local dev only).
 *
 * `host = null` means "auto": main binds the Tailscale IPv4 if available, else
 * loopback for local dev. Loopback peers are always trusted (same machine).
 */
import { resolve } from "node:path";

export type AuthMode = "token" | "tailnet" | "off";

export interface BridgeConfig {
  host: string | null;
  port: number;
  authMode: AuthMode;
  /** Static web assets dir (index.html, sw.js, icons; plus a prebuilt app.js in packaged mode). */
  webDir: string;
  /** Dev only: web entry built into app.js on the fly. null in packaged mode (serve prebuilt app.js from webDir). */
  webEntry: string | null;
  /** Optional webhook (e.g. an ntfy.sh topic URL) POSTed when a surface needs input. */
  notifyUrl: string | null;
}

export function loadConfig(): BridgeConfig {
  const here = import.meta.dir; // packages/bridge/src
  const raw = process.env.CMUX_BRIDGE_AUTH;
  const authMode: AuthMode = raw === "off" ? "off" : raw === "tailnet" ? "tailnet" : "token";
  return {
    host: process.env.CMUX_BRIDGE_HOST ?? null,
    port: Number(process.env.CMUX_BRIDGE_PORT ?? 4380),
    authMode,
    webDir: resolve(here, "../../web/public"),
    webEntry: resolve(here, "../../web/src/app.ts"),
    notifyUrl: process.env.CMUX_BRIDGE_NOTIFY_URL ?? null,
  };
}
