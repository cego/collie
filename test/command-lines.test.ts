import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { scriptLine } from "../src/script";
import { remoteCollie } from "../src/ssh-argv";
import { STATUS_LINE_ARGS, statusLineCommand } from "../src/statusline";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const WORDS = ["two words", "it's", `say "hi"`, "a;b", "$HOME", "*", "back\\slash", "line\nbreak"];

const argvOf = (line: string, program: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = yield* fs.makeTempDirectoryScoped({ prefix: "collie-command-line-" });
    yield* fs.writeFileString(`${bin}/${program}`, `#!/bin/sh\nprintf '%s\\0' "$@"\n`, {
      mode: 0o755,
    });
    const ran = yield* exec(["/bin/sh", "-c", line], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, ...env },
    });
    expect(ran.stderr).toBe("");
    return ran.stdout.split("\0").slice(0, -1);
  }).pipe(Effect.scoped);

test("the status line runs the words it names", () =>
  runEffect(
    Effect.gen(function* () {
      const line = statusLineCommand(["printer", ...WORDS]);
      expect(yield* argvOf(line, "printer")).toEqual([...WORDS, ...STATUS_LINE_ARGS]);
    }),
  ));

test("a Machine's login shell runs collie with the words it was given", () =>
  runEffect(
    Effect.gen(function* () {
      const line = remoteCollie(WORDS);
      expect(yield* argvOf(line, "collie", { SHELL: "/bin/sh" })).toEqual(WORDS);
    }),
  ));

test("a login under script is handed to script as the words it was built from", () =>
  runEffect(
    Effect.gen(function* () {
      for (const word of WORDS)
        expect(yield* argvOf(scriptLine(word), "script")).toEqual(["-qefc", word, "/dev/null"]);
    }),
  ));
