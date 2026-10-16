import { Config, Effect, FileSystem } from "effect";

/**
 * Appends `<name> <command> [<subcommand>]` to `COLLIE_TEST_STARTS`, so a suite can count the
 * processes it started. Unset, it does nothing.
 */
export const recordStart = (name: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const file = yield* Config.String("COLLIE_TEST_STARTS").pipe(Config.withDefault(""));
    if (file === "") return;
    const at = args.findIndex((arg) => !arg.startsWith("-"));
    const asked =
      at === -1 ? [] : args.slice(at, at + 2).filter((arg) => /^[a-z][a-z-]*$/.test(arg));
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(file, `${[name, ...asked].join(" ")}\n`, { flag: "a" });
  }).pipe(Effect.ignore);
