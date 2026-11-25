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
import { TestClock } from "effect/testing";
import { connect } from "../../src/host";
import { exec } from "./command";
import { platformRuntime } from "./effect";
import { submitOutput } from "../../src/output-submit";

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

// WARNING: the tool server a launch wrote beside its prompt is the only place an agent finds its Run.
const ToolServer = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
});
const McpConfig = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Struct({ collie: ToolServer }) }),
);

export type ToolServer = typeof ToolServer.Type;

export interface StepHand {
  readonly tool: ToolServer | null;
  readonly output: string | null;
}

const toolServerOf = (prompt: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = yield* fs
      .readFileString(prompt.replace(/\.prompt\.md$/, ".mcp.json"), "utf8")
      .pipe(Effect.option);
    const found = Option.flatMap(read, (text) => Schema.decodeOption(McpConfig)(text));
    return Option.map(found, (one) => one.mcpServers.collie).pipe(Option.getOrNull);
  });

// WARNING: a harness whose tool server is not written beside the prompt names it on the address line.
const toolServerIn = (
  prompt: string,
  path: string | undefined,
  found: ToolServer | null,
): ToolServer | null => {
  const at = path === undefined ? null : /^(.*)\/agents\/[^/]+\/[^/]+$/.exec(path);
  if (at === null) {
    return found;
  }
  const address = /^You are (\S+) of (\S+) on /m.exec(prompt);
  return {
    command: found?.command ?? "",
    args: found?.args ?? [],
    env: {
      ...(found?.env ?? {}),
      COLLIE_STATE_DIR: at[1]!,
      ...(address === null ? {} : { COLLIE_RUN: address[2]!, COLLIE_AGENT: address[1]! }),
    },
  };
};

// WARNING: the prompt no longer names the Output; the step's file keeps the prompt's name.
const outputOfPrompt = (prompt: string) =>
  prompt.replace(/\.prompt\.md$/, ".json").replace(/\.r\d+\.json$/, ".json");

export interface HandIn {
  readonly server: ToolServer;
  readonly output: Schema.Json;
}

// WARNING: "accepted" is the host recording this step's Output, so it is this step's whatever a later step is doing.
const ours = (answer: string) =>
  answer === "accepted" ||
  (!Str.startsWith("No step of")(answer) &&
    !Str.includes("was already collected")(answer) &&
    !Str.includes("was already accepted")(answer));

// WARNING: A launch can take a while before the host registers its step for a submit.
const RETRIES = 6000;

// WARNING: A scenario's host runs in this process; a `collie host` a test started is one of its own.
export const handIn = ({ server, output }: HandIn) => {
  const run = server.env.COLLIE_RUN;
  const agent = server.env.COLLIE_AGENT;
  const stateDir = server.env.COLLIE_STATE_DIR;
  if (run === undefined || agent === undefined || stateDir === undefined) {
    return Effect.void;
  }
  const elsewhere = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${stateDir}/host.sock`)),
    Effect.orElseSucceed(() => false),
  );
  const answer = (separate: boolean) =>
    separate
      ? Effect.promise(() =>
          platformRuntime.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const client = yield* connect(stateDir);
                yield* client.declare({ frontDoor: "agent", from: { run, agent } });
                return yield* client.submitOutput({ runId: run, output });
              }).pipe(Effect.orElseSucceed(() => "")),
            ),
          ),
        )
      : submitOutput(run, agent, output);
  return Effect.gen(function* () {
    const separate = yield* elsewhere;
    for (let tries = 0; tries < RETRIES; tries++) {
      if (ours(yield* answer(separate))) {
        return;
      }
      // WARNING: Live, never the test's clock: waiting on that one would spend the very budget the host is using.
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
  });
};

const answerFrom = Effect.fn("fakeAgent.answer")(function* (
  answered: number,
  line: string,
  queuePath: string,
  known: StepHand | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ref = /is in (\S+\.md)(?: |\. )/.exec(line);
  const prompt = ref?.[1];
  const text =
    prompt && (yield* fs.exists(prompt)) ? yield* fs.readFileString(prompt, "utf8") : line;
  const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
  // WARNING: A reminder or a repair names no prompt, so what the last turn was given stands in for it.
  const server =
    match !== null
      ? null
      : prompt === undefined
        ? (known?.tool ?? null)
        : (toolServerIn(text, prompt, yield* toolServerOf(prompt)) ?? known?.tool ?? null);
  const written = match === null ? null : Str.trim(match[1]!);
  const outputPath =
    written ?? (prompt === undefined ? (known?.output ?? null) : outputOfPrompt(prompt));
  const hand: StepHand = { tool: server, output: outputPath };
  let submit: HandIn | null = null;
  const byFile = written !== null;
  const owes: string | undefined = undefined;
  const unanswered = {
    answered,
    status: "idle",
    owed: owes,
    hand: known,
    submit: null as HandIn | null,
  };
  if (outputPath === null || queuePath === "" || !(yield* fs.exists(queuePath))) {
    return unanswered;
  }
  const next = (yield* readQueue(queuePath))[answered];
  const scripted = Option.getOrNull(Schema.decodeUnknownOption(Scripted)(next));
  for (const one of scripted?.writes ?? []) {
    yield* fs.makeDirectory(path.dirname(one.path), { recursive: true });
    yield* fs.writeFileString(one.path, one.text);
  }
  if (scripted?.sh !== undefined) {
    const ran = yield* exec(["sh", "-c", scripted.sh], {
      cwd: path.dirname(queuePath),
      env: { ...process.env, OUTPUT_PATH: outputPath ?? "", PROMPT_PATH: prompt ?? "" },
    });
    if (ran.exitCode !== 0) {
      return yield* Effect.die(`the agent's sh failed: ${ran.stderr}`);
    }
  }
  const output = scripted === null ? next : scripted.output;
  if (output !== undefined && output !== null) {
    if (byFile) {
      yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
      const plain = Schema.decodeUnknownOption(Schema.String)(output);
      yield* fs.writeFileString(
        outputPath,
        Option.isSome(plain) ? plain.value : encodeJson(output),
      );
    } else if (server !== null) {
      // WARNING: The caller submits it before reporting the turn over, so what it wrote is there when the host reads.
      submit = { server, output };
    }
  }
  return {
    answered: answered + 1,
    status: scripted?.owed === true ? "working" : (scripted?.status ?? "idle"),
    owed: scripted?.owed === true ? (outputPath ?? undefined) : undefined,
    hand,
    submit,
  };
});

// WARNING: Agents answer one prompt at a time, so two never take the same queue entry.
const turn = Semaphore.makeUnsafe(1);

export const answerPrompt = (
  text: string,
  log: string,
  queuePath: string,
  known: StepHand | null = null,
) =>
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
            const now = yield* answerFrom(answered, text, queuePath, known);
            yield* fs.writeFileString(countPath, `${encodeAnswered({ outputs: now.answered })}\n`);
            return { status: now.status, owed: now.owed, hand: now.hand, submit: now.submit };
          }),
        () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
      );
    }),
  );
