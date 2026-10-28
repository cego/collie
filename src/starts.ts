import { Config, Effect, FileSystem } from "effect";

/**
 * Appends `<name> <command> [<subcommand>]` to `COLLIE_TEST_STARTS`, so a suite can count the
 * processes it started, followed by a tab and `COLLIE_TEST_FILE` where that names the test file
 * that caused it. Unset, it does nothing.
 */
export const recordStart = (name: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const file = yield* Config.String("COLLIE_TEST_STARTS").pipe(Config.withDefault(""));
    if (file === "") return;
    const at = args.findIndex((arg) => !arg.startsWith("-"));
    const asked =
      at === -1 ? [] : args.slice(at, at + 2).filter((arg) => /^[a-z][a-z-]*$/.test(arg));
    const by = yield* Config.String("COLLIE_TEST_FILE").pipe(Config.withDefault(""));
    const fs = yield* FileSystem.FileSystem;
    const line = [name, ...asked].join(" ");
    yield* fs.writeFileString(file, `${by === "" ? line : `${line}\t${by}`}\n`, { flag: "a" });
  }).pipe(Effect.ignore);
