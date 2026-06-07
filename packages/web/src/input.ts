/**
 * input — drive a surface from a VISIBLE compose bar (a real textarea the user
 * can see, edit, and dictate into) plus immediate one-off special keys.
 *
 * Two channels, deliberately independent:
 *  - Text: typed/pasted into the compose field, held locally so it's visible,
 *    then transmitted as `input.text` + `enter` on submit (the Send button).
 *  - Keys: footer / d-pad / "more keys" send a named `input.key` immediately,
 *    bypassing the compose buffer (esc, ^C, arrows, Shift+Tab, …).
 *
 * `mapKeydown` (kept for the key toolbar + tests) translates a KeyboardEvent to
 * cmux's key grammar. Autocorrect/capitalisation are disabled on the field so a
 * composed command is sent verbatim.
 */
import type { ClientMessage } from "@cmux-mobile/protocol";

// Enter and Backspace are handled via `beforeinput` (insertLineBreak /
// deleteContentBackward) so soft + hardware keyboards fire exactly one each.
const NAMED: Record<string, string> = {
  Tab: "tab",
  Escape: "escape",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/**
 * Map a keydown to a cmux key name, or null when the key should fall through to
 * the `input` event as typed text.
 */
export function mapKeydown(e: KeyboardEvent): string | null {
  // cmux's canonical modifier order is ctrl, alt, shift, cmd.
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("cmd");

  const base = NAMED[e.key];
  if (base) {
    if (base === "tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return "shift-tab";
    return mods.length ? `${mods.join("-")}-${base}` : base;
  }

  // Modified printable (Ctrl-C, Alt-f, Cmd-k, …). Plain shifted printables fall
  // through to the input event so capitals/symbols are typed normally; shift is
  // already encoded in the character, so drop it here.
  if ((e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1) {
    const m = mods.filter((x) => x !== "shift");
    return `${m.join("-")}-${e.key.toLowerCase()}`;
  }

  return null;
}

/** Session-local cap for compose-bar command recall. */
const HISTORY_CAP = 15;

export class InputController {
  private surfaceId: string | null = null;
  private composing = false;
  private returnSends = false;
  /** Recently sent strings, newest first (session-local). */
  private readonly hist: string[] = [];

  constructor(
    private readonly field: HTMLTextAreaElement,
    private readonly send: (msg: ClientMessage) => void,
    private readonly onAfterSubmit?: () => void,
  ) {
    // Track IME composition so a Send tap mid-composition doesn't truncate text.
    this.field.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.field.addEventListener("compositionend", () => {
      this.composing = false;
    });
    // Opt-in "Return = Send": a newline insertion submits instead. Default off,
    // so Return inserts a newline (multi-line compose) unless the user enables it.
    this.field.addEventListener("beforeinput", (e) => {
      if (this.returnSends && !this.composing && (e as InputEvent).inputType === "insertLineBreak") {
        e.preventDefault();
        this.submit();
      }
    });
  }

  /** Toggle whether the Return/Enter key submits (true) or inserts a newline (false). */
  setReturnSends(v: boolean): void {
    this.returnSends = v;
  }

  setSurface(id: string | null): void {
    // Don't carry an unsent draft across panes.
    if (id !== this.surfaceId) this.field.value = "";
    this.surfaceId = id;
  }

  /** Summon the on-screen keyboard / focus the compose field (must run inside a user gesture on iOS). */
  focus(): void {
    this.field.focus();
  }

  /** True if there's an unsent draft in the compose field. */
  hasDraft(): boolean {
    return this.field.value.length > 0;
  }

  /** Insert clipboard text into the compose field at the caret (visible, sent only on submit). */
  pasteText(text: string): void {
    if (!text) return;
    const el = this.field;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }

  /** Send a named key immediately (footer / d-pad / more-keys), independent of the compose buffer. */
  sendKey(key: string): void {
    if (this.surfaceId) this.send({ t: "input.key", surfaceId: this.surfaceId, key });
  }

  /** Transmit the composed text followed by Enter, then clear the field. */
  submit(): void {
    if (this.composing || !this.surfaceId) return;
    const text = this.field.value;
    this.field.value = "";
    if (text) {
      this.record(text);
      this.send({ t: "input.text", surfaceId: this.surfaceId, text });
    }
    this.send({ t: "input.key", surfaceId: this.surfaceId, key: "enter" });
    this.onAfterSubmit?.();
  }

  /** Recently sent strings, newest first (for compose-bar recall). */
  history(): readonly string[] {
    return this.hist;
  }

  /** Populate the compose field from a prior command — does NOT send (the two-stage commit guardrail). */
  recall(text: string): void {
    this.field.value = text;
    this.field.focus();
    const n = text.length;
    this.field.setSelectionRange(n, n);
  }

  private record(text: string): void {
    if (!text.trim()) return;
    const i = this.hist.indexOf(text);
    if (i >= 0) this.hist.splice(i, 1);
    this.hist.unshift(text);
    if (this.hist.length > HISTORY_CAP) this.hist.length = HISTORY_CAP;
  }
}
