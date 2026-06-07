import { test, expect } from "bun:test";
import { InputController } from "../src/input.ts";
import type { ClientMessage } from "@cmux-mobile/protocol";

/** Minimal stand-in for the compose <textarea> (bun test has no DOM). */
function makeField(): HTMLTextAreaElement {
  const f: Record<string, unknown> = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener() {},
    focus() {},
    setSelectionRange(s: number, e: number) {
      f.selectionStart = s;
      f.selectionEnd = e;
    },
  };
  return f as unknown as HTMLTextAreaElement;
}

function setup() {
  const sent: ClientMessage[] = [];
  const field = makeField();
  const ctrl = new InputController(field, (m) => sent.push(m));
  return { sent, field, ctrl };
}

test("submit sends composed text then Enter, and clears the field", () => {
  const { sent, field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "deploy now";
  ctrl.submit();
  expect(sent).toEqual([
    { t: "input.text", surfaceId: "s1", text: "deploy now" },
    { t: "input.key", surfaceId: "s1", key: "enter" },
  ]);
  expect(field.value).toBe("");
});

test("submit on an empty field sends a bare Enter", () => {
  const { sent, ctrl } = setup();
  ctrl.setSurface("s1");
  ctrl.submit();
  expect(sent).toEqual([{ t: "input.key", surfaceId: "s1", key: "enter" }]);
});

test("sendKey transmits immediately and never touches the compose buffer", () => {
  const { sent, field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "half-typed";
  ctrl.sendKey("ctrl-c");
  expect(sent).toEqual([{ t: "input.key", surfaceId: "s1", key: "ctrl-c" }]);
  expect(field.value).toBe("half-typed"); // draft preserved
});

test("pasteText inserts at the caret (visible, not sent)", () => {
  const { sent, field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "ab";
  field.selectionStart = 1;
  field.selectionEnd = 1;
  ctrl.pasteText("X");
  expect(field.value).toBe("aXb");
  expect(sent).toEqual([]); // nothing sent until submit
});

test("switching surfaces drops an unsent draft", () => {
  const { field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "draft for s1";
  ctrl.setSurface("s2");
  expect(field.value).toBe("");
});

test("no active surface → submit and sendKey are no-ops", () => {
  const { sent, field, ctrl } = setup();
  field.value = "orphan";
  ctrl.submit();
  ctrl.sendKey("escape");
  expect(sent).toEqual([]);
});

test("submit records history newest-first and dedupes", () => {
  const { field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "git status";
  ctrl.submit();
  field.value = "ls";
  ctrl.submit();
  field.value = "git status"; // dup → moves to front
  ctrl.submit();
  expect(ctrl.history()).toEqual(["git status", "ls"]);
});

test("history caps at 15 entries", () => {
  const { field, ctrl } = setup();
  ctrl.setSurface("s1");
  for (let i = 0; i < 20; i++) {
    field.value = `cmd${i}`;
    ctrl.submit();
  }
  expect(ctrl.history().length).toBe(15);
  expect(ctrl.history()[0]).toBe("cmd19");
});

test("blank submits are not recorded", () => {
  const { field, ctrl } = setup();
  ctrl.setSurface("s1");
  field.value = "   ";
  ctrl.submit();
  expect(ctrl.history().length).toBe(0);
});

test("recall populates the field and never sends", () => {
  const { sent, field, ctrl } = setup();
  ctrl.setSurface("s1");
  ctrl.recall("npm test");
  expect(field.value).toBe("npm test");
  expect(sent).toEqual([]);
});

test("onAfterSubmit fires once per submit", () => {
  let calls = 0;
  const field = makeField();
  const ctrl = new InputController(field, () => {}, () => calls++);
  ctrl.setSurface("s1");
  field.value = "x";
  ctrl.submit();
  expect(calls).toBe(1);
});
