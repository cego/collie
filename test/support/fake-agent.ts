import * as Str from "effect/String";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Semaphore,
  flow,
  Result,
} from "effect";
import { exec } from "./command";

const QueuedOutputJson = Schema.Union([Schema.String, Schema.Null, Schema.JsonObject]);
const QueueJson = Schema.fromJsonString(Schema.Array(QueuedOutputJson));
const Scripted = Schema.Struct({
  writes: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
  sh: Schema.optionalKey(Schema.String),
  output: QueuedOutputJson,
  status: Schema.optionalKey(Schema.Literals(["idle", "working"])),
  owed: Schema.optionalKey(Schema.Boolean),
});
const encodeJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Any)), Result.getOrThrow);
const Answered = Schema.fromJsonString(Schema.Struct({ outputs: Schema.Finite }));
const encodeAnswered = flow(Schema.encodeResult(Answered), Result.getOrThrow);

const readQueue = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file, "utf8").pipe(
      Effect.map((text) => Option.getOrElse(Schema.decodeOption(QueueJson)(text), () => [])),
      Effect.orElseSucceed(() => []),
    );
  });

const answerFrom = Effect.fn("fakeAgent.answer")(function* (
  answered: number,
  line: string,
  queuePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ref = /is in (\S+\.md)(?: |\. )/.exec(line);
  const text =
    ref && (yield* fs.exists(ref[1]!)) ? yield* fs.readFileString(ref[1]!, "utf8") : line;
  const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
  const owes: string | undefined = undefined;
  const unanswered = { answered, status: "idle", owed: owes };
  if (!match || queuePath === "" || !(yield* fs.exists(queuePath))) return unanswered;
  const next = (yield* readQueue(queuePath))[answered];
  const scripted = Option.getOrNull(Schema.decodeUnknownOption(Scripted)(next));
  for (const one of scripted?.writes ?? []) {
    yield* fs.makeDirectory(path.dirname(one.path), { recursive: true });
    yield* fs.writeFileString(one.path, one.text);
  }
  if (scripted?.sh !== undefined) {
    const ran = yield* exec(["sh", "-c", scripted.sh], {
      cwd: path.dirname(queuePath),
      env: { ...process.env, OUTPUT_PATH: Str.trim(match[1]!), PROMPT_PATH: ref?.[1] ?? "" },
    });
    if (ran.exitCode !== 0) return yield* Effect.die(`the agent's sh failed: ${ran.stderr}`);
  }
  const output = scripted === null ? next : scripted.output;
  const outputPath = Str.trim(match[1]!);
  if (output !== undefined && output !== null) {
    yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
    const plain = Schema.decodeUnknownOption(Schema.String)(output);
    yield* fs.writeFileString(outputPath, Option.isSome(plain) ? plain.value : encodeJson(output));
  }
  return {
    answered: answered + 1,
    status: scripted?.owed === true ? "working" : (scripted?.status ?? "idle"),
    owed: scripted?.owed === true ? outputPath : undefined,
  };
});

// WARNING: Agents answer one prompt at a time, so two never take the same queue entry.
const turn = Semaphore.makeUnsafe(1);

export const answerPrompt = (text: string, log: string, queuePath: string) =>
  turn.withPermits(1)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = `${log}.lock`;
      const countPath = `${log}.answered.json`;
      return yield* Effect.acquireUseRelease(
        fs
          .makeDirectory(lock)
          .pipe(
            Effect.retry({ times: 1000, schedule: Schedule.spaced("2 millis") }),
            Effect.ignore,
          ),
        () =>
          Effect.gen(function* () {
            const read = yield* fs.readFileString(countPath).pipe(Effect.orElseSucceed(() => ""));
            const answered = Option.match(Schema.decodeOption(Answered)(read), {
              onNone: () => 0,
              onSome: (one) => one.outputs,
            });
            const now = yield* answerFrom(answered, text, queuePath);
            yield* fs.writeFileString(countPath, `${encodeAnswered({ outputs: now.answered })}\n`);
            return { status: now.status, owed: now.owed };
          }),
        () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
      );
    }),
  );
