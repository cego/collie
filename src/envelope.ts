import type { PlatformServices } from "./platform";
import type { Config } from "effect";
import { Effect, FileSystem, Option, Path, Schema, Stdio, Stream, flow, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { PluginEnv } from "./env";
import type { HerdrError } from "./herdr";
import { currentPid, withLock } from "./lock";
import { err, HostUnread, newRequestId, ExpectedError } from "./operations";
import type { OpResult } from "./operations";

export const ResultBoundary = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.ObjectKeyword,
    human: Schema.String,
  }),
  // WARNING: tools reach this module while operations is still loading, so it cannot import operations.
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.suspend(() => ExpectedError) }),
]);
const ResultBoundaryJson = Schema.fromJsonString(ResultBoundary);

const ResultJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.suspend(() => ExpectedError) }),
  ]),
);

export type Result = OpResult;
export type CollieError = Config.ConfigError | Error | HerdrError | PlatformError;
type CollieServices = PlatformServices;

// WARNING: rejected commands write no receipt, as nothing happened for a retry to replay.
export const REJECTED: ReadonlyArray<ExpectedError["code"]> = [
  "invalid_input",
  "needs_input",
  "workspace_required",
];

// WARNING: goes through the Stdio sink, not process.stdout, so an embedding host sees the output.
export const say = Effect.fn("collie.say")(function* (line: string) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout({ endOnDone: false })));
});

export const printResult = Effect.fn("collie.printResult")(function* (
  result: Result,
  json: boolean,
) {
  yield* say(
    json
      ? yield* Schema.encodeEffect(ResultJson)(
          result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error },
        )
      : result.ok
        ? result.human
        : result.error.message,
  );
  // WARNING: exit status has no Effect equivalent, so it is set on the process.
  if (!result.ok) {
    process.exitCode = REJECTED.includes(result.error.code) ? 2 : 1;
  }
}, Effect.orDie);

// WARNING: a defect must still end in one envelope, never empty streams and a bare exit status.
export function attempt<E, R>(operation: Effect.Effect<Result, E, R>, json: boolean) {
  return guarded(operation.pipe(Effect.flatMap((result) => printResult(result, json))), json);
}

// WARNING: whatever escapes a printing command still becomes one envelope.
export function guarded<E, R>(operation: Effect.Effect<void, E, R>, json: boolean) {
  return operation.pipe(
    Effect.catch((cause) =>
      printResult(
        cause instanceof HostUnread
          ? { ok: false, error: cause.error }
          : err("operation_failed", String(cause)),
        json,
      ),
    ),
    Effect.catchDefect((defect) => printResult(err("operation_failed", String(defect)), json)),
    // WARNING: an interrupt still writes an envelope, so a parser never reads an empty stream.
    Effect.onInterrupt(() =>
      printResult(err("operation_failed", "interrupted before it finished"), json).pipe(
        Effect.ignore,
      ),
    ),
  );
}

const requestId = Effect.fn("collie.requestId")(function* (value: Option.Option<string>) {
  return Option.isSome(value) ? value.value : yield* newRequestId();
});

const receiptPath = Effect.fn("collie.receiptPath")(function* (
  env: PluginEnv,
  operation: string,
  id: string,
) {
  const path = yield* Path.Path;
  return path.join(env.stateDir, "requests", operation, `${encodeURIComponent(id)}.json`);
});

const readReceipt = Effect.fn("collie.readReceipt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeEffect(ResultBoundaryJson)(yield* fs.readFileString(file));
});

// WARNING: failures carry the request id too, so a retry replays rather than starting a second Run.
function withRequestId(result: Result, id: string) {
  if (!result.ok) {
    return err(result.error.code, result.error.message, {
      ...result.error.details,
      requestId: id,
    });
  }
  return { ...result, data: { ...result.data, requestId: id } };
}

export const mutation = Effect.fn("collie.mutation")(function* (
  env: PluginEnv,
  operation: string,
  requested: Option.Option<string>,
  apply: (id: string) => Effect.Effect<Result, CollieError, CollieServices>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const id = yield* requestId(requested);
  const path = yield* receiptPath(env, operation, id);
  if (yield* fs.exists(path)) {
    return yield* readReceipt(path);
  }
  yield* fs.makeDirectory(pathSvc.dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  return yield* withLock(
    lock,
    Effect.gen(function* () {
      if (yield* fs.exists(path)) {
        return yield* readReceipt(path);
      }
      return err("operation_failed", `Request "${id}" is already in progress.`, { requestId: id });
    }),
    Effect.gen(function* () {
      if (yield* fs.exists(path)) {
        return yield* readReceipt(path);
      }
      const tmp = `${path}.${yield* currentPid}.tmp`;
      const save = (value: Result) =>
        fs
          .writeFileString(
            tmp,
            `${flow(Schema.encodeResult(ResultBoundaryJson), Result.getOrThrow)(value)}\n`,
          )
          .pipe(Effect.andThen(fs.rename(tmp, path)));
      yield* save(
        err(
          "operation_failed",
          `Request "${id}" is in progress or ended without a recorded result. Check its state before submitting a new request.`,
          { requestId: id, outcome: "unknown" },
        ),
      );
      const incomplete = (cause: unknown) =>
        Effect.succeed(
          err("operation_failed", `The request failed; its effects are unknown: ${String(cause)}`, {
            outcome: "unknown",
          }),
        );
      const result = yield* apply(id).pipe(
        Effect.catch(incomplete),
        Effect.catchDefect(incomplete),
      );
      const withRequest = withRequestId(result, id);
      if (!withRequest.ok && REJECTED.includes(withRequest.error.code)) {
        yield* fs.remove(path);
        return withRequest;
      }
      yield* save(withRequest);
      return withRequest;
    }),
  );
});
