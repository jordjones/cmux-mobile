import { describe, expect, test } from "bun:test";
import { diffRows, maxCols, normalizeRows } from "../src/screen-diff.ts";
import { screenHash } from "@cmux-mobile/protocol";

describe("normalizeRows", () => {
  test("strips trailing whitespace per row", () => {
    expect(normalizeRows("a  \nb\t\nc")).toEqual(["a", "b", "c"]);
  });

  test("drops trailing blank rows but keeps interior blanks", () => {
    expect(normalizeRows("a\n\nb\n\n\n")).toEqual(["a", "", "b"]);
  });

  test("empty input yields no rows", () => {
    expect(normalizeRows("")).toEqual([]);
    expect(normalizeRows("\n\n")).toEqual([]);
  });

  test("preserves interior and leading spaces (TUI columns)", () => {
    expect(normalizeRows("  indented\n   tree├──")).toEqual(["  indented", "   tree├──"]);
  });
});

describe("maxCols", () => {
  test("returns widest row length", () => {
    expect(maxCols(["a", "abcd", "ab"])).toBe(4);
    expect(maxCols([])).toBe(0);
  });
});

describe("diffRows", () => {
  test("no changes -> no ops", () => {
    expect(diffRows(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("only changed rows are emitted", () => {
    expect(diffRows(["a", "b", "c"], ["a", "X", "c"])).toEqual([{ y: 1, text: "X" }]);
  });

  test("growth emits new rows", () => {
    expect(diffRows(["a"], ["a", "b"])).toEqual([{ y: 1, text: "b" }]);
  });

  test("shrink emits cleared rows for removed tail", () => {
    expect(diffRows(["a", "b"], ["a"])).toEqual([{ y: 1, text: "" }]);
  });
});

describe("screenHash", () => {
  test("is deterministic and order-sensitive", () => {
    expect(screenHash(["a", "b"])).toBe(screenHash(["a", "b"]));
    expect(screenHash(["a", "b"])).not.toBe(screenHash(["b", "a"]));
  });

  test("changes when content changes", () => {
    expect(screenHash(["hello"])).not.toBe(screenHash(["hellp"]));
  });

  test("handles unicode", () => {
    expect(screenHash(["✓ ⏺ ├──"])).toBe(screenHash(["✓ ⏺ ├──"]));
  });
});

// Mirror of the client's screen.diff apply: grow+set the ops, then tail-pop "".
function clientApply(prev: readonly string[], ops: { y: number; text: string }[]): string[] {
  const rows = prev.slice();
  for (const op of ops) {
    while (rows.length <= op.y) rows.push("");
    rows[op.y] = op.text;
  }
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

describe("keystone diff convergence (row-count changes via diffRows, not full frames)", () => {
  const cases: Array<[string[], string[]]> = [
    [["a", "b", "c"], ["a", "X", "c"]], // change middle
    [["a", "b"], ["a", "b", "c"]], // grow
    [["a", "b", "c"], ["a"]], // shrink
    [["a"], ["a", "", "b"]], // interior blank preserved
    [["one", "two", "three"], ["ONE", "two"]], // change + shrink
  ];
  for (const [prev, next] of cases) {
    test(`${JSON.stringify(prev)} -> ${JSON.stringify(next)}`, () => {
      const ops = diffRows(prev, next);
      const result = clientApply(prev, ops);
      expect(result).toEqual(next);
      expect(screenHash(result)).toBe(screenHash(next)); // checksum parity
    });
  }
});
