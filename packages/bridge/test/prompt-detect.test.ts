import { test, expect } from "bun:test";
import { isWaitingForInput } from "../src/prompt-detect.ts";

test("detects common blocked-input prompts", () => {
  expect(isWaitingForInput(["Proceed with these changes? [y/n]"])).toBe(true);
  expect(isWaitingForInput(["Overwrite file? (y/N)"])).toBe(true);
  expect(isWaitingForInput(["Are you sure you want to continue?"])).toBe(true);
  expect(isWaitingForInput(["Press enter to continue"])).toBe(true);
});

test("ignores normal output and credential prompts (no spurious notifications)", () => {
  expect(isWaitingForInput(["building...", "done"])).toBe(false);
  expect(isWaitingForInput([""])).toBe(false);
  expect(isWaitingForInput(["we discussed the y/n flag earlier"])).toBe(false); // bare y/n, no bracket
  expect(isWaitingForInput(["Password:"])).toBe(false); // deliberately not matched
  expect(isWaitingForInput(["Enter passphrase for key:"])).toBe(false);
});

test("only considers the tail, so a resolved prompt no longer counts", () => {
  const rows = ["Proceed? [y/n]", "yes", "installed ok", "$"];
  expect(isWaitingForInput(rows)).toBe(false);
});
