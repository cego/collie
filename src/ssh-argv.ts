// The ssh argv and bounds Desktop shares with the host, without the host's lock.

import * as Arr from "effect/Array";
import { Result } from "effect";
import { CommandLine } from "effect/process";

/** How long a master has to answer one control command, which it does at once when it is well. */
export const MUX_BOUND = "5 seconds";

/** `collie` as a Machine's login shell runs it over SSH. */
export const remoteCollie = (args: ReadonlyArray<string>) =>
  Arr.join(
    [
      `exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`,
      ...Arr.map(args, (word) => Result.getOrThrow(CommandLine.quote(word))),
    ],
    " ",
  );

/**
 * A session that rides the connection and fails where it has gone: without
 * `ProxyCommand=false`, ssh would fall back to a login of its own.
 */
export const riderArgv = (path: string, target: string, remote: string, ssh = "ssh") => [
  ...rider(path, target, ssh),
  remote,
];

const rider = (path: string, target: string, ssh: string) => [
  ssh,
  "-S",
  path,
  "-o",
  "ControlMaster=no",
  "-o",
  "ProxyCommand=false",
  "-T",
  target,
];

/** Core's `via` for a Machine: a rider, given core's shell line last. */
export const viaCommand = (path: string, target: string, ssh = "ssh") =>
  Result.getOrThrow(CommandLine.join(rider(path, target, ssh)));

/** The ssh target a `via` from `viaCommand` ends with: its last word, unquoted. */
export const viaTarget = (via: string) => {
  const words: Array<string> = [];
  let word: string | undefined;
  let quoted = false;
  for (let at = 0; at < via.length; at++) {
    const char = via[at]!;
    if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
    } else if (char === "'") {
      quoted = true;
      word ??= "";
    } else if (char === "\\") word = (word ?? "") + (via[++at] ?? "");
    else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + char;
  }
  if (word !== undefined) words.push(word);
  return words.at(-1) ?? "";
};

export type Verb = "check" | "forward" | "cancel" | "exit";

/** `ssh -S <path> -O <verb> … <destination>`: answered by an open master, or failed. */
export const muxArgv = (
  ssh: string,
  path: string,
  verb: Verb,
  destination: string,
  ...forward: ReadonlyArray<string>
) => [ssh, "-S", path, "-O", verb, ...forward, destination];
