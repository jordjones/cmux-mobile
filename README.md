# cmux-mobile

Drive your **local [cmux](https://cmux.com) terminal/agent sessions from an iPhone/iPad** — full interactive control, over your own Tailscale tailnet, with no cmux cloud account and no app to install on the phone.

cmux exposes its panes only through a local Unix-domain socket. `cmux-mobile` is a small **bridge** that runs on your Mac, speaks that socket, and serves a **web app (PWA)** you open in mobile Safari and add to your Home Screen. Traffic stays inside your tailnet (WireGuard-encrypted); nothing goes to a third party.

## Prerequisites

- **macOS** with **cmux ≥ 0.64** running.
- **[Tailscale](https://tailscale.com)** installed and signed in on **both** the Mac **and** the phone, on the same tailnet.
- **[Bun](https://bun.sh)** on the Mac (`brew install oven-sh/bun/bun`). cmux-mobile is a Bun program, so run it with `bunx` (not `npx`).

## Install & run

**Option A — one command (npm):**

```bash
bunx cmux-mobile            # run the bridge in the foreground (Ctrl-C to stop)
# or keep it running across logins/reboots:
bunx cmux-mobile install    # installs a launchd login agent, then prints the URL + log path
```

**Option B — from source:**

```bash
git clone <repo-url> cmux-mobile && cd cmux-mobile
bun run setup               # installs deps, builds, and installs the launchd agent
```

Either way, the bridge prints a URL like `http://100.x.y.z:4380` (your Mac's tailnet IP).

## On the phone (same tailnet)

1. Open that URL in **Safari**.
2. In the default **`tailnet`** auth mode you're connected immediately (any device on your own tailnet, no code). In `token` mode, enter the 6-digit pairing code from the log — or mint one headlessly: `cmux-mobile pair add "iPhone"` (prints a one-tap URL).
3. **Share → Add to Home Screen** for a full-screen app.

Pick a terminal from the ☰ menu, tap the compose bar to type, Send to run, and use the bottom toolbar for `esc` / `^C` / arrows / a "more keys" sheet. Scroll to the top for history; tap the title to copy `workspace / tab`.

## Manage

```bash
cmux-mobile pair list
cmux-mobile pair revoke <id>
cmux-mobile uninstall        # remove the launchd agent
```

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `CMUX_BRIDGE_HOST` | auto (tailnet IP, else loopback) | bind address |
| `CMUX_BRIDGE_PORT` | `4380` | listen port |
| `CMUX_BRIDGE_AUTH` | `tailnet` | `tailnet` = any device on your own tailnet, no code; `token` = identity + per-device bearer token; `off` = no gating (local dev only) |
| `CMUX_BRIDGE_NOTIFY_URL` | — | optional [ntfy](https://ntfy.sh) topic / webhook POSTed when a surface needs input (e.g. an agent hits `[y/n]`) — works even with the PWA closed |
| `CMUX_BRIDGE_LABEL` | `dev.cmuxmobile.bridge` | launchd agent label |

> Note: the mirror is **monochrome** — cmux's socket returns plain UTF-8 (no ANSI colour). The Claude/Codex TUIs, vim, etc. are fully readable and drivable, just flat.

## Security

Typing into a live pane is remote code execution, so by default the bridge requires a **tailnet identity** (`tailscale whois`, fail-closed); in `token` mode it additionally requires a **per-device bearer token** (only its SHA-256 is stored; revocable). Loopback (the Mac itself) is trusted for local dev. Encryption is WireGuard (Tailscale); the bridge runs plain HTTP/WS *inside* the tailnet under a single-user/trusted-tailnet assumption. Typed input is never logged. The optional notify webhook sends only a workspace name (never terminal contents).

## Develop

```bash
bun install
CMUX_BRIDGE_AUTH=off bun run bridge     # local dev (loopback trusted, no token)
bun run typecheck
bun test
bun run build                           # produce a publishable dist/ (bundled CLI + prebuilt web)
```

```
packages/protocol/   shared WS message types + screen checksum
packages/bridge/      Bun service: cmux socket <-> WebSocket (+ auth, events, mirror, watcher, CLI)
packages/web/         PWA: terminal grid + input + surface picker + settings
scripts/              build, smoke/e2e, capability probes, pairing, launchd helpers
```
