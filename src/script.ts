import { Result } from "effect";
import { CommandLine } from "effect/process";

export const scriptCommand = (command: string, platform: NodeJS.Platform) =>
  platform === "darwin"
    ? ["script", "-q", "/dev/null", "/bin/sh", "-c", command]
    : ["script", "-qefc", command, "/dev/null"];

export const scriptLine = (command: string) => {
  const line = (platform: NodeJS.Platform) =>
    Result.getOrThrow(CommandLine.join(scriptCommand(command, platform)));
  return `if [ "$(uname)" = Darwin ]; then exec ${line("darwin")}; else exec ${line("linux")}; fi`;
};
