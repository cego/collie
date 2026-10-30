import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Effect, Fiber, Option, Queue, Schema, Stream, flow, Result } from "effect";
import type { Offered } from "../shared/chat-choices";
import type { FlockSettings } from "../shared/flock-settings";
import { childEnv, which } from "./login-env";

const Response = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  command: Schema.String,
  success: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Json),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(Response));
const Models = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      id: Schema.String,
      name: Schema.String,
      reasoning: Schema.Boolean,
    }),
  ),
});
const Levels = Schema.Struct({ levels: Schema.Array(Schema.String) });
const encodeCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))),
  Result.getOrThrow,
);

export const readPiModels = (
  _flock: FlockSettings,
  dir: string,
  command: ReadonlyArray<string> | null = which("pi") === null ? null : [which("pi")!],
): Effect.Effect<ReadonlyArray<Omit<Offered, "unsetEffort">>, string> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(
          [
            ...(command ?? ["pi"]),
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
          ],
          { cwd: dir, env: childEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        ),
      catch: String,
    }),
    (child) =>
      Effect.gen(function* () {
        const answers = yield* Queue.unbounded<typeof Response.Type, string>();
        const diagnostics = yield* Effect.promise(() =>
          new globalThis.Response(child.stderr).text(),
        ).pipe(Effect.forkScoped);
        yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) => {
            const decoded = decodeResponse(line);
            return Option.isSome(decoded) ? Queue.offer(answers, decoded.value) : Effect.void;
          }),
          Effect.andThen(
            Effect.gen(function* () {
              const code = yield* Effect.promise(() => child.exited);
              const why = yield* Fiber.join(diagnostics);
              yield* Queue.fail(
                answers,
                Str.trim(why) || `Pi ended its model read (exit ${code}).`,
              );
            }),
          ),
          Effect.catch((why) => Queue.fail(answers, why)),
          Effect.forkScoped,
        );
        let next = 0;
        const request = Effect.fn("PiModels.request")(function* (
          type: string,
          fields: Readonly<Record<string, string>> = {},
        ) {
          const id = `models-${++next}`;
          yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(child.stdin.write(`${encodeCommand({ id, type, ...fields })}\n`)),
            catch: String,
          });
          yield* Effect.tryPromise({
            try: () => Promise.resolve(child.stdin.flush()),
            catch: String,
          });
          while (true) {
            const answer = yield* Queue.take(answers);
            if (answer.id !== id || answer.command !== type) continue;
            if (!answer.success) return yield* Effect.fail(answer.error ?? `Pi refused ${type}`);
            return answer.data;
          }
        });
        const { models } = yield* request("get_available_models").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Models)),
          Effect.mapError(String),
        );
        return yield* Effect.forEach(models, (model) =>
          Effect.gen(function* () {
            if (model.provider === "" || model.id === "") return [];
            const id = `${model.provider}/${model.id}`;
            let efforts: ReadonlyArray<string> = [];
            if (model.reasoning) {
              yield* request("set_model", { provider: model.provider, modelId: model.id });
              const { levels } = yield* request("get_available_thinking_levels").pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Levels)),
                Effect.mapError(String),
              );
              efforts = Arr.some(levels, (level) => level !== "off") ? levels : [];
            }
            return [{ id, label: model.name, efforts }];
          }),
        ).pipe(Effect.map((listed) => listed.flat()));
      }).pipe(Effect.scoped),
    (child) =>
      Effect.sync(() => child.kill()).pipe(Effect.andThen(Effect.promise(() => child.exited))),
  );
