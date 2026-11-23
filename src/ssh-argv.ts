import * as Arr from "effect/Array";
import { Result } from "effect";
import { CommandLine } from "effect/process";

export const MUX_BOUND = "5 seconds";

export const remoteCollie = (args: ReadonlyArray<string>) =>
  Arr.join(
    [
      `exec "\${SHELL:-/bin/sh}" -lc 'exec collie "$@"' collie`,
      ...Arr.map(args, (word) => Result.getOrThrow(CommandLine.quote(word))),
    ],
    " ",
  );

// WARNING: without ProxyCommand=false, ssh falls back to a login of its own.
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

export const viaCommand = (path: string, target: string, ssh = "ssh") =>
  Result.getOrThrow(CommandLine.join(rider(path, target, ssh)));

export const viaTarget = (via: string) => {
  const words: Array<string> = [];
  let word: string | undefined;
  let quoted = false;
  for (let at = 0; at < via.length; at++) {
    const char = via[at]!;
    if (quoted) {
      if (char === "'") {
        quoted = false;
      } else {
        word += char;
      }
    } else if (char === "'") {
      quoted = true;
      word ??= "";
    } else if (char === "\\") {
      word = (word ?? "") + (via[++at] ?? "");
    } else if (/\s/.test(char)) {
      if (word !== undefined) {
        words.push(word);
      }
      word = undefined;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) {
    words.push(word);
  }
  return words.at(-1) ?? "";
};

export type Verb = "check" | "forward" | "cancel" | "exit";

// WARNING: only the named master and explicit forwards: reading SSH config here would replay its forwards.
export const muxArgv = (
  ssh: string,
  path: string,
  verb: Verb,
  destination: string,
  ...forward: ReadonlyArray<string>
) => [ssh, "-F", "/dev/null", "-S", path, "-O", verb, ...forward, destination];
