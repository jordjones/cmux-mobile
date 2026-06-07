import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { evaluateWhois, normalizeIp, PairingManager, TokenStore } from "../src/auth.ts";

const tmpFiles: string[] = [];
function tmpTokenPath(): string {
  const p = join(tmpdir(), `cmux-mobile-tokens-${randomBytes(6).toString("hex")}.json`);
  tmpFiles.push(p);
  return p;
}
afterEach(() => {
  for (const f of tmpFiles.splice(0)) if (existsSync(f)) rmSync(f);
});

describe("normalizeIp", () => {
  test("strips IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:100.64.0.1")).toBe("100.64.0.1");
    expect(normalizeIp("100.64.0.1")).toBe("100.64.0.1");
  });
});

describe("evaluateWhois", () => {
  const payload = { Node: { Name: "ipad.ts.net" }, UserProfile: { LoginName: "jord@github" } };

  test("ok when login present and no restriction", () => {
    expect(evaluateWhois(payload, null)).toMatchObject({ ok: true, login: "jord@github" });
  });
  test("ok when login matches required", () => {
    expect(evaluateWhois(payload, "jord@github").ok).toBe(true);
  });
  test("rejects mismatched login", () => {
    expect(evaluateWhois(payload, "someone@else").ok).toBe(false);
  });
  test("rejects missing identity (fail closed)", () => {
    expect(evaluateWhois({}, null).ok).toBe(false);
    expect(evaluateWhois(null, null).ok).toBe(false);
  });
});

describe("TokenStore", () => {
  test("mint then verify returns the device", () => {
    const store = new TokenStore(tmpTokenPath());
    const { id, token } = store.mint("ipad");
    const dev = store.verify(token);
    expect(dev?.id).toBe(id);
    expect(dev?.name).toBe("ipad");
  });

  test("rejects an unknown token", () => {
    const store = new TokenStore(tmpTokenPath());
    store.mint("ipad");
    expect(store.verify("not-a-real-token")).toBeNull();
    expect(store.verify("")).toBeNull();
  });

  test("revoked tokens stop verifying", () => {
    const store = new TokenStore(tmpTokenPath());
    const { id, token } = store.mint("ipad");
    expect(store.revoke(id)).toBe(true);
    expect(store.verify(token)).toBeNull();
  });

  test("list never exposes the hash", () => {
    const store = new TokenStore(tmpTokenPath());
    store.mint("ipad");
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!)).not.toContain("hash");
  });

  test("persists across instances", () => {
    const path = tmpTokenPath();
    const { token } = new TokenStore(path).mint("ipad");
    expect(new TokenStore(path).verify(token)).not.toBeNull();
  });
});

describe("PairingManager", () => {
  test("a code is single-use", () => {
    const pm = new PairingManager();
    const code = pm.issueCode();
    expect(pm.consume(code)).toBe(true);
    expect(pm.consume(code)).toBe(false);
  });

  test("rejects unknown codes", () => {
    const pm = new PairingManager();
    expect(pm.consume("000000")).toBe(false);
  });

  test("expired codes cannot be consumed", () => {
    let now = 1000;
    const pm = new PairingManager(5_000, () => now);
    const code = pm.issueCode();
    now += 6_000; // past TTL
    expect(pm.consume(code)).toBe(false);
  });

  test("only one code is live at a time", () => {
    const pm = new PairingManager();
    const first = pm.issueCode();
    const second = pm.issueCode();
    expect(pm.consume(first)).toBe(false);
    expect(pm.consume(second)).toBe(true);
  });

  test("burns the live code after repeated wrong guesses", () => {
    const pm = new PairingManager();
    const code = pm.issueCode();
    const wrong = code === "999999" ? "000000" : "999999";
    for (let i = 0; i < 5; i++) expect(pm.consume(wrong)).toBe(false);
    expect(pm.consume(code)).toBe(false); // burned despite being otherwise valid
  });
});
