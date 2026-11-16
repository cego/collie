// What a checkout runs to bring its installed dependencies to its head's lockfile, as the
// project declares in `.collie/dependencies.json` (ADR-0031).

import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Command } from "./measurement-model";
import { whatItSaid, type Runner } from "./mr";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(Command));

/** The command it ran, null where nothing is declared, or why the dependencies are not in place. */
export type Installed =
  | { readonly ran: string | null; readonly refused?: undefined }
  | { readonly refused: string };

export const installDependencies = Effect.fn("dependencies.installDependencies")(function* <R>(
  run: Runner<R>,
  checkout: string,
): Effect.fn.Return<Installed, never, R | FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // From this head, not the base `verify.json` is read from: its lockfile is the one to satisfy.
  const file = path.join(checkout, ".collie", "dependencies.json");
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    return { ran: null };
  }
  const declared = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeCommand), Effect.result);
  if (declared._tag === "Failure") {
    return {
      refused: `${file} does not declare one command: ${declared.failure.message}`,
    };
  }
  const { executable, argv } = declared.success;
  const command = Arr.join([executable, ...argv], " ");
  const ran = yield* run(executable, [...argv], checkout);
  if (ran.code !== 0) {
    const said = whatItSaid(ran);
    return { refused: `${command} exited ${ran.code}${said && `: ${said}`}` };
  }
  return { ran: command };
});
