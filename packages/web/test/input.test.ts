import { describe, expect, test } from "bun:test";
import { mapKeydown } from "../src/input.ts";

function k(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent;
}

describe("mapKeydown", () => {
  test("printable chars fall through to the input event", () => {
    expect(mapKeydown(k("a"))).toBeNull();
    expect(mapKeydown(k("A", { shiftKey: true }))).toBeNull();
  });

  test("Enter and Backspace fall through (handled by beforeinput, not keydown)", () => {
    expect(mapKeydown(k("Enter"))).toBeNull();
    expect(mapKeydown(k("Backspace"))).toBeNull();
  });

  test("named navigation keys map", () => {
    expect(mapKeydown(k("Tab"))).toBe("tab");
    expect(mapKeydown(k("Tab", { shiftKey: true }))).toBe("shift-tab");
    expect(mapKeydown(k("Escape"))).toBe("escape");
    expect(mapKeydown(k("ArrowUp"))).toBe("up");
    expect(mapKeydown(k("ArrowLeft"))).toBe("left");
    expect(mapKeydown(k("Delete"))).toBe("delete");
  });

  test("ctrl/alt/cmd + printable, shift dropped and lowercased", () => {
    expect(mapKeydown(k("c", { ctrlKey: true }))).toBe("ctrl-c");
    expect(mapKeydown(k("C", { ctrlKey: true, shiftKey: true }))).toBe("ctrl-c");
    expect(mapKeydown(k("k", { metaKey: true }))).toBe("cmd-k");
    expect(mapKeydown(k("f", { altKey: true }))).toBe("alt-f");
  });

  test("modifier order ctrl-alt-shift-cmd on named keys", () => {
    expect(mapKeydown(k("ArrowLeft", { altKey: true }))).toBe("alt-left");
    expect(mapKeydown(k("ArrowUp", { ctrlKey: true, shiftKey: true }))).toBe("ctrl-shift-up");
  });
});
