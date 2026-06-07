import { test, expect } from "bun:test";
import { detectShortcuts } from "../src/shortcuts-detect.ts";

const keys = (rows: string[]) => detectShortcuts(rows).map((d) => d.key);

test("detects shift+tab in agent hint lines", () => {
  expect(keys(["press shift+tab to cycle modes"])).toContain("shift-tab");
  expect(keys(["shift-tab: previous"])).toContain("shift-tab");
  expect(keys(["⇧⇥ cycle"])).toContain("shift-tab");
});

test("detects ctrl combos in word and symbol form", () => {
  expect(keys(["ctrl+o to expand"])).toContain("ctrl-o");
  expect(keys(["control-r search"])).toContain("ctrl-r");
  expect(keys(["⌃C interrupt"])).toContain("ctrl-c");
});

test("detects 'esc to <verb>' hints", () => {
  expect(keys(["esc to interrupt"])).toContain("escape");
  expect(keys(["press escape to cancel"])).toContain("escape");
});

test("does NOT fire on bare caret notation or plain prose (false-positive guard)", () => {
  expect(keys(["the build printed ^C^C^C and exited"])).toEqual([]);
  expect(keys(["escape sequences were stripped"])).toEqual([]); // 'escape' without 'to <verb>'
  expect(keys(["nothing actionable here"])).toEqual([]);
});

test("dedupes repeats and caps the count", () => {
  const rows = ["ctrl+o ctrl+o ctrl+o", "ctrl-o again"];
  expect(keys(rows)).toEqual(["ctrl-o"]);
  const many = ["ctrl+a ctrl+b ctrl+c ctrl+d ctrl+e ctrl+f ctrl+g ctrl+h ctrl+i ctrl+j"];
  expect(detectShortcuts(many).length).toBeLessThanOrEqual(8);
});

test("produces a readable label", () => {
  const d = detectShortcuts(["ctrl+o to expand, shift+tab to cycle"]);
  expect(d).toContainEqual({ key: "ctrl-o", label: "^O" });
  expect(d).toContainEqual({ key: "shift-tab", label: "⇧⇥" });
});
