import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Command } from "./measurement-model";
import { whatItSaid } from "./mr";
import type { Runner } from "./mr";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(Command));

export type Installed =
  | { readonly ran: string | null; readonly refused?: undefined }
  | { readonly refused: string };

export const installDependencies = Effect.fn("dependencies.installDependencies")(function* <R>(
  run: Runner<R>,
  checkout: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // WARNING: read from this head, not the base verify.json: its lockfile is the one to satisfy.
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
