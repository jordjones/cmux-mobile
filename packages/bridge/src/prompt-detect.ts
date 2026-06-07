/**
 * prompt-detect — does a surface's tail look like it's blocked waiting for the
 * user (a [y/n] / password / "Proceed?" prompt)? Conservative on purpose: a
 * false positive means a spurious notification. Runs on the plain-text mirror.
 */
const PATTERNS: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[yes\/no\]/i,
  /\bproceed\b[^?\n]*\?/i,
  /\bcontinue\?/i,
  /\boverwrite\b[^?\n]*\?/i,
  /\bare you sure\b/i,
  /press\s+enter\s+to\s+continue/i,
];
// Note: password/passphrase prompts are deliberately NOT matched — they're
// in-the-moment (you just ran sudo/ssh), extremely common, and the use case here
// is backgrounded "come back to me" agent prompts, not credential entry.

/** True if the last few non-empty rows look like a blocked input prompt. */
export function isWaitingForInput(rows: readonly string[]): boolean {
  const tail = rows.filter((r) => r.trim()).slice(-3).join("\n");
  if (!tail) return false;
  return PATTERNS.some((re) => re.test(tail));
}
