import { test, expect } from "bun:test";
import { ScreenModel } from "../src/screen-model.ts";
import { screenHash } from "@cmux-mobile/protocol";

const noop = (): void => {};

test("setSurface arms a full and stamps the clock", () => {
  const m = new ScreenModel(noop);
  m.setSurface("s1");
  expect(m.isAwaitingFull).toBe(true);
  expect(m.awaitingFullSince).toBeGreaterThan(0);
});

test("screen.full clears the awaiting latch and the clock", () => {
  const m = new ScreenModel(noop);
  m.setSurface("s1");
  m.apply({ t: "screen.full", surfaceId: "s1", rev: 1, cols: 3, rows: ["abc"] });
  expect(m.isAwaitingFull).toBe(false);
  expect(m.awaitingFullSince).toBe(0);
  expect(m.rows).toEqual(["abc"]);
});

test("armFull re-arms after a full (drives the watchdog)", () => {
  const m = new ScreenModel(noop);
  m.setSurface("s1");
  m.apply({ t: "screen.full", surfaceId: "s1", rev: 1, cols: 3, rows: ["abc"] });
  m.armFull();
  expect(m.isAwaitingFull).toBe(true);
  expect(m.awaitingFullSince).toBeGreaterThan(0);
});

test("diffs are ignored while awaiting a full", () => {
  const m = new ScreenModel(noop);
  m.setSurface("s1"); // awaitingFull = true
  const needResync = m.apply({ t: "screen.diff", surfaceId: "s1", rev: 1, ops: [{ y: 0, text: "x" }] });
  expect(needResync).toBe(false);
  expect(m.rows).toEqual([]); // diff dropped until the full lands
});

test("checksum mismatch requests resync only once settled", () => {
  const m = new ScreenModel(noop);
  m.setSurface("s1");
  // While awaiting the full, a checksum never triggers a resync.
  expect(m.apply({ t: "screen.checksum", surfaceId: "s1", rev: 1, hash: "deadbeef" })).toBe(false);
  // After a full, a divergent checksum does.
  m.apply({ t: "screen.full", surfaceId: "s1", rev: 1, cols: 3, rows: ["abc"] });
  expect(m.apply({ t: "screen.checksum", surfaceId: "s1", rev: 1, hash: "deadbeef" })).toBe(true);
  // A matching checksum does not.
  expect(m.apply({ t: "screen.checksum", surfaceId: "s1", rev: 1, hash: screenHash(["abc"]) })).toBe(false);
});
