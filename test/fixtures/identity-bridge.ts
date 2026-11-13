import { BunRuntime } from "@effect/platform-bun";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Option, Schema } from "effect";
import { BRIDGE_READY, PROTOCOL } from "../../src/board-model";
import { platformLayer } from "../../src/platform";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeArgs = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.String, Schema.String, Schema.String]),
);
const decodeFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
      tag: Schema.optionalKey(Schema.String),
    }),
  ),
);

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const [mode, events, as] = yield* decodeArgs(Arr.drop(process.argv, 2));
  const note = (event: string) =>
    encode({ event, pid: process.pid, as }).pipe(
      Effect.flatMap((line) => fs.writeFileString(events, `${line}\n`, { flag: "a" })),
    );
  const run = Effect.runForkWith(yield* Effect.context<never>());
  yield* note("ready");
  process.stdout.write(`${BRIDGE_READY}\n`);
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    for (;;) {
      const end = Option.getOrElse(Str.indexOf("\n")(pending), () => -1);
      if (end < 0) return;
      const line = Str.slice(0, end)(pending);
      pending = Str.slice(end + 1)(pending);
      if (line === "") continue;
      run(
        Effect.gen(function* () {
          const frame = yield* decodeFrame(line);
          if (frame._tag !== "Request" || frame.tag !== "identity") return;
          yield* note("identity");
          if (mode === "silent") return;
          const value =
            mode === "malformed"
              ? { build: 42 }
              : {
                  build: "1.0.5",
                  pid: process.pid,
                  dir: "/fixture",
                  installation: "vm",
                  protocol: PROTOCOL,
                };
          const reply = yield* encode({
            _tag: "Exit",
            requestId: frame.id,
            exit: { _tag: "Success", value },
          });
          process.stdout.write(`${reply}\n`);
        }),
      );
    }
  });
  return yield* Effect.never;
}).pipe(Effect.provide(platformLayer), BunRuntime.runMain);
