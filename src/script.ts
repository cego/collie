import { Result } from "effect";
import { CommandLine } from "effect/process";

/** `command` under a pseudo-terminal of `script`'s, as a login that wants one is run. */
export const scriptCommand = (command: string, platform: NodeJS.Platform): [string, ...string[]] =>
  platform === "darwin"
    ? ["script", "-q", "/dev/null", "/bin/sh", "-c", command]
    : ["script", "-qefc", command, "/dev/null"];

/** The same, as a shell line for a Machine whose system is only known once it runs there. */
export const scriptLine = (command: string) => {
  const line = (platform: NodeJS.Platform) =>
    Result.getOrThrow(CommandLine.join(scriptCommand(command, platform)));
  return `if [ "$(uname)" = Darwin ]; then exec ${line("darwin")}; else exec ${line("linux")}; fi`;
};
