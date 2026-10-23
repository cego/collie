// Pi's own list of models and each one's thinking levels, from the human's install and login,
// read in an RPC process that loads none of their setup, keeps no session and runs no package check.

import { type Cause, Effect, Option, Queue, Schema, Stream } from "effect";
import type { ListedModel } from "../shared/chat-choices";
import { CHILD_CWD, childEnv, which } from "./login-env";

const ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--offline",
  "--no-mcp",
  "--no-themes",
  "--no-tools",
];

const Answer = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("response"),
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});
type Answer = typeof Answer.Type;
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

const PiModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  reasoning: Schema.Boolean,
});
const Models = Schema.Struct({ models: Schema.Array(PiModel) });
const Levels = Schema.Struct({ levels: Schema.Array(Schema.String) });

/** Pi's list, or why it could not be read; `command` runs Pi, or is null where it is not on PATH. */
export const readPiModels = (command: ReadonlyArray<string> | null) =>
  Effect.gen(function* () {
    if (command === null) return yield* Effect.fail("pi is not on PATH");
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.spawn([...command, ...ARGS], {
            cwd: CHILD_CWD,
            env: childEnv(),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          }),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }),
      (child) =>
        Effect.promise(() => {
          child.kill();
          return child.exited;
        }),
    );
    const said = Effect.promise(() =>
      Promise.all([new Response(child.stderr).text(), child.exited]),
    ).pipe(Effect.map(([stderr, code]) => stderr.trim() || `Pi exited (code ${code})`));
    const answers = yield* Queue.unbounded<Answer, Cause.Done>();
    yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Option.match(decodeAnswer(line), {
          onNone: () => Effect.void,
          onSome: (answer) => Queue.offer(answers, answer),
        }),
      ),
      Effect.ensuring(Queue.end(answers)),
      Effect.forkScoped,
    );
    let sent = 0;
    /** Sends `request` and awaits the answer with its id: Pi answers out of order. */
    const ask = <A>(schema: Schema.Codec<A, unknown>, request: Record<string, string>) =>
      Effect.gen(function* () {
        const id = `models-${++sent}`;
        // A Pi that has exited takes no command; its answer then says why.
        yield* Effect.tryPromise(() =>
          Promise.resolve(
            child.stdin.write(
              `${Schema.encodeSync(Schema.fromJsonString(Schema.Json))({ id, ...request })}\n`,
            ),
          ),
        ).pipe(
          Effect.andThen(Effect.tryPromise(() => Promise.resolve(child.stdin.flush()))),
          Effect.ignore,
        );
        let answer: Answer;
        do
          answer = yield* Queue.take(answers).pipe(
            Effect.catch(() => Effect.flatMap(said, Effect.fail)),
          );
        while (answer.id !== id);
        if (!answer.success)
          return yield* Effect.fail(answer.error ?? `Pi refused ${request.type}`);
        return yield* Schema.decodeUnknownEffect(schema)(answer.data).pipe(
          Effect.mapError(() => `Pi's answer to ${request.type} could not be read`),
        );
      });
    const { models } = yield* ask(Models, { type: "get_available_models" });
    const listed: ListedModel[] = [];
    for (const model of models) {
      const id = `${model.provider}/${model.id}`;
      let efforts: ReadonlyArray<string> = [];
      if (model.reasoning) {
        yield* ask(Schema.Unknown, {
          type: "set_model",
          provider: model.provider,
          modelId: model.id,
        });
        const { levels } = yield* ask(Levels, { type: "get_available_thinking_levels" });
        efforts = levels.length === 1 && levels[0] === "off" ? [] : levels;
      }
      listed.push({ id, label: model.name, efforts });
    }
    yield* Effect.promise(() => Promise.resolve(child.stdin.end()));
    return listed;
  }).pipe(Effect.scoped);

/** Pi's own list, on the command the driver runs. */
export const piModels = Effect.suspend(() => {
  const pi = which("pi");
  return readPiModels(pi === null ? null : [pi]);
});
