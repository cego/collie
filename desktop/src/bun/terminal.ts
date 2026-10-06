// Go to pane on this computer: a new herdr client, in a terminal of its own.

import { quoted } from "./machine";

/** A herdr client attached to a Machine's session: over SSH where it has a target, else Local's. */
export const attachCommand = (target: string | undefined, session: string | null) => [
  "herdr",
  ...(target === undefined ? [] : ["--remote", target]),
  ...(session === null ? [] : ["--session", session]),
];

export const shellLine = (command: ReadonlyArray<string>) =>
  command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : quoted(word))).join(" ");

/** In the order this computer's default terminal is looked for, with how each is told what to run. */
const TERMINALS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

const appleString = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** `command` in this computer's default terminal, or null where none is found. */
export const inTerminal = (
  command: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  which: (name: string) => string | null,
): ReadonlyArray<string> | null => {
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      `tell application "Terminal" to do script ${appleString(shellLine(command))}`,
      "-e",
      `tell application "Terminal" to activate`,
    ];
  for (const [name, run] of TERMINALS) {
    const found = which(name);
    if (found !== null) return [found, ...run, ...command];
  }
  return null;
};
