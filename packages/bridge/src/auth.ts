/**
 * auth — the security boundary for the bridge. Typing into a live pane is remote
 * code execution, so access requires BOTH:
 *
 *   1. the peer IP resolving (via `tailscale whois`) to the host's own tailnet
 *      identity  — fail CLOSED if whois fails, and
 *   2. a per-device bearer token (only its SHA-256 is stored; constant-time
 *      compare; individually revocable), obtained once via a one-time pairing
 *      code.
 *
 * Transport encryption is WireGuard (Tailscale); we run plain HTTP/WS inside it.
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const BRIDGE_DIR = join(homedir(), ".cmux-bridge");
export const TOKENS_PATH = join(BRIDGE_DIR, "tokens.json");

// ---------------------------------------------------------------------------
// Tailscale identity
// ---------------------------------------------------------------------------

/** Normalise an IPv4-mapped IPv6 address (::ffff:100.x) to plain IPv4. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

export interface WhoisVerdict {
  ok: boolean;
  login?: string;
  node?: string;
  reason?: string;
}

/**
 * Pure decision from a parsed `tailscale whois --json` payload. Separated from
 * spawning so it is unit-testable. When `requireLogin` is set, the peer's login
 * must match it (restrict to the host's own account).
 */
export function evaluateWhois(
  payload: unknown,
  requireLogin: string | null,
): WhoisVerdict {
  const p = payload as { Node?: { Name?: string }; UserProfile?: { LoginName?: string } } | null;
  const login = p?.UserProfile?.LoginName;
  const node = p?.Node?.Name;
  if (!login) return { ok: false, reason: "no tailnet identity" };
  if (requireLogin && login !== requireLogin) {
    return { ok: false, login, node, reason: `login ${login} != ${requireLogin}` };
  }
  return { ok: true, login, node };
}

type Runner = (args: string[]) => Promise<string>;

async function runTailscale(args: string[]): Promise<string> {
  const bin = Bun.which("tailscale") ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tailscale ${args[0]} exited ${code}`);
  return out;
}

export class TailscaleVerifier {
  private selfLogin: string | null = null;

  constructor(
    private readonly requireSameLogin: boolean = true,
    private readonly runner: Runner = runTailscale,
  ) {}

  /** Cache the host's own login so we can restrict peers to it. */
  async init(): Promise<void> {
    if (!this.requireSameLogin) return;
    try {
      const status = JSON.parse(await this.runner(["status", "--json"])) as {
        Self?: { UserID?: number };
        User?: Record<string, { LoginName?: string }>;
      };
      const uid = status.Self?.UserID;
      if (uid != null && status.User) this.selfLogin = status.User[String(uid)]?.LoginName ?? null;
    } catch {
      this.selfLogin = null; // can't determine — verifyPeer will fail closed
    }
  }

  get requiredLogin(): string | null {
    return this.requireSameLogin ? this.selfLogin : null;
  }

  async verifyPeer(ip: string): Promise<WhoisVerdict> {
    try {
      const json = JSON.parse(await this.runner(["whois", "--json", normalizeIp(ip)]));
      if (this.requireSameLogin && !this.selfLogin) {
        return { ok: false, reason: "host tailnet identity unknown" };
      }
      return evaluateWhois(json, this.requiredLogin);
    } catch (e) {
      return { ok: false, reason: "whois failed: " + (e as Error).message };
    }
  }

  /** Tailscale IPv4 of this host, for binding the listener. */
  static async selfIPv4(runner: Runner = runTailscale): Promise<string | null> {
    try {
      const out = await runner(["ip", "-4"]);
      const line = out.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
      return line ?? null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-device bearer tokens
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  hash: string; // sha256(token) hex
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
}

export interface PublicDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export class TokenStore {
  private devices: Device[] = [];

  constructor(private readonly path: string = TOKENS_PATH) {
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.path)) {
        this.devices = JSON.parse(readFileSync(this.path, "utf8")) as Device[];
      }
    } catch {
      this.devices = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
  }

  /** Create a device and return its one-time plaintext token (never stored). */
  mint(name: string): { id: string; token: string } {
    const id = randomBytes(6).toString("hex");
    const token = randomBytes(32).toString("base64url");
    this.devices.push({
      id,
      name: name || "device",
      hash: sha256Hex(token),
      createdAt: new Date().toISOString(),
    });
    this.save();
    return { id, token };
  }

  /** Return the matching active device for a token, or null. Constant-time. */
  verify(token: string): Device | null {
    if (!token) return null;
    const hash = sha256Hex(token);
    let match: Device | null = null;
    // Compare against every device (even after a hit) to avoid early-exit timing.
    for (const d of this.devices) {
      const eq = !d.revoked && constantTimeEqualHex(d.hash, hash);
      if (eq) match = d;
    }
    if (match) {
      // Throttle lastSeenAt persistence so a flapping client doesn't thrash the file.
      const now = Date.now();
      const last = match.lastSeenAt ? Date.parse(match.lastSeenAt) : 0;
      if (now - last > 60_000) {
        match.lastSeenAt = new Date(now).toISOString();
        this.save();
      }
    }
    return match;
  }

  revoke(id: string): boolean {
    const d = this.devices.find((x) => x.id === id);
    if (!d || d.revoked) return false;
    d.revoked = true;
    this.save();
    return true;
  }

  list(): PublicDevice[] {
    return this.devices.map(({ hash: _hash, ...rest }) => rest);
  }
}

// ---------------------------------------------------------------------------
// One-time pairing codes
// ---------------------------------------------------------------------------

interface Code {
  code: string;
  expiresAt: number;
}

export class PairingManager {
  private codes: Code[] = [];
  private failures = 0;
  /** Burn all live codes after this many wrong guesses (rate-limit brute force). */
  private static readonly MAX_FAILURES = 5;

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Issue a short numeric code that pairs exactly one device. Only ONE code is live at a time. */
  issueCode(): string {
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    this.codes = [{ code, expiresAt: this.now() + this.ttlMs }];
    this.failures = 0;
    return code;
  }

  /** Consume a code (single-use). Returns true if it was valid + unexpired. */
  consume(code: string): boolean {
    this.prune();
    const i = this.codes.findIndex((c) => c.code === code);
    if (i < 0) {
      // Brute-force guard: after too many misses, invalidate the live code so an
      // attacker must wait for a fresh one (re-issued on startup/SIGUSR1).
      if (++this.failures >= PairingManager.MAX_FAILURES) {
        this.codes = [];
        this.failures = 0;
      }
      return false;
    }
    this.codes.splice(i, 1);
    this.failures = 0;
    return true;
  }

  private prune(): void {
    const t = this.now();
    this.codes = this.codes.filter((c) => c.expiresAt > t);
  }
}
