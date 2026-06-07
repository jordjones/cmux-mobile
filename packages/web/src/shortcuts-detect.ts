/**
 * shortcuts-detect — scan the visible terminal text for the key hints agents
 * print ("shift+tab to cycle", "ctrl+o", "esc to interrupt", …) and surface them
 * as tappable keys. Conservative on purpose: only word-form / symbol-form combos
 * (not bare caret notation like "^C", which shows up too often in plain output),
 * so a detected button almost always corresponds to a real, sendable shortcut.
 */
export interface DetectedKey {
  /** cmux key-grammar name to send (e.g. "shift-tab", "ctrl-o", "escape"). */
  key: string;
  /** short glyph label for the button. */
  label: string;
}

const MAX_KEYS = 8;

export function detectShortcuts(rows: readonly string[]): DetectedKey[] {
  const text = rows.join("\n");
  const found = new Map<string, string>(); // key -> label, insertion-ordered

  // shift+tab / shift-tab / ⇧⇥
  if (/\bshift\s*[+\-]\s*tab\b/i.test(text) || /⇧\s*(?:⇥|tab)/i.test(text)) {
    found.set("shift-tab", "⇧⇥");
  }

  // ctrl+<letter> / control-<letter> / ⌃<letter>  (word or symbol form only)
  const addCtrl = (letter: string): void => {
    const l = letter.toLowerCase();
    found.set(`ctrl-${l}`, `^${l.toUpperCase()}`);
  };
  for (const m of text.matchAll(/\b(?:ctrl|control)\s*[+\-]\s*([a-zA-Z])\b/g)) addCtrl(m[1]!);
  for (const m of text.matchAll(/⌃\s*([a-zA-Z])\b/g)) addCtrl(m[1]!);

  // esc/escape to <verb>  ("esc to interrupt", "escape to cancel")
  if (/\besc(?:ape)?\s+to\s+[a-z]/i.test(text)) found.set("escape", "esc");

  return [...found].slice(0, MAX_KEYS).map(([key, label]) => ({ key, label }));
}
