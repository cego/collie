// Going to a pane: the herdr client Desktop attaches, and the terminal on this computer it opens in.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { attachCommand, inTerminal, launched, shellLine } from "../desktop/src/bun/terminal";
import { runEffect } from "./support/effect";

const onPath =
  (...found: ReadonlyArray<string>) =>
  (name: string) =>
    found.includes(name) ? `/usr/bin/${name}` : null;

test("a Machine's session is attached over SSH, and Local's directly", () => {
  expect(attachCommand("mk@vm-mk", "work")).toEqual([
    "herdr",
    "--remote",
    "mk@vm-mk",
    "--session",
    "work",
  ]);
  expect(attachCommand("mk@vm-mk", null)).toEqual(["herdr", "--remote", "mk@vm-mk"]);
  expect(attachCommand(undefined, "work")).toEqual(["herdr", "--session", "work"]);
  expect(attachCommand(undefined, null)).toEqual(["herdr"]);
});

test("the command to copy reads as typed, quoting only what a shell would split", () => {
  expect(shellLine(["herdr", "--remote", "mk@vm-mk", "--session", "my work"])).toBe(
    "herdr --remote mk@vm-mk --session 'my work'",
  );
});

test("this computer's default terminal is x-terminal-emulator, else the first one found", () => {
  const herdr = ["herdr", "--remote", "mk@vm-mk"];
  expect(inTerminal(herdr, "linux", onPath("x-terminal-emulator", "kitty"))).toEqual([
    "/usr/bin/x-terminal-emulator",
    "-e",
    ...herdr,
  ]);
  expect(inTerminal(herdr, "linux", onPath("xterm", "gnome-terminal"))).toEqual([
    "/usr/bin/gnome-terminal",
    "--",
    ...herdr,
  ]);
  expect(inTerminal(herdr, "linux", onPath("kitty"))).toEqual(["/usr/bin/kitty", ...herdr]);
  expect(inTerminal(herdr, "linux", onPath())).toBeNull();
});

test("on macOS it is Terminal.app, told the command as a line", () => {
  expect(inTerminal(["herdr", "--session", "my work"], "darwin", onPath())).toEqual([
    "osascript",
    "-e",
    `tell application "Terminal" to do script "herdr --session 'my work'"`,
    "-e",
    `tell application "Terminal" to activate`,
  ]);
});

test("a terminal that fails as it starts, or is not there, did not open", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* launched(["true"])).toBe(true);
      expect(yield* launched(["sleep", "1.5"])).toBe(true);
      expect(yield* launched(["false"])).toBe(false);
      expect(yield* launched(["/nonexistent/terminal"])).toBe(false);
    }),
  ));
