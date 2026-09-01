import type { BunServices } from "@effect/platform-bun/BunServices";
import { Config, Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { PluginEnv } from "./env";
import type { HerdrError } from "./herdr";
import { acquireLock, currentPid, releaseOwnLock } from "./lock";
import { err, newRequestId, ExpectedError, type OpResult } from "./operations";

const ResultBoundary = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.ObjectKeyword,
    human: Schema.String,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ExpectedError }),
]);
const ResultBoundaryJson = Schema.fromJsonString(ResultBoundary);

const ResultJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
    Schema.Struct({ ok: Schema.Literal(false), error: ExpectedError }),
  ]),
);

export type Result = OpResult;
export type CollieError = Config.ConfigError | Error | HerdrError | PlatformError;
type CollieServices = BunServices;

/**
 * The codes that mean the command line was wrong rather than the operation failed:
 * exit 2, and no receipt, because nothing happened for a retry to replay. A caller
 * given `needs_input` is meant to fill the gaps and retry with the same request id.
 */
const REJECTED: ReadonlyArray<ExpectedError["code"]> = [
  "invalid_input",
  "needs_input",
  "workspace_required",
];

/**
 * One line on stdout, through the Stdio sink rather than `process.stdout`, so a host
 * that supplies its own streams — a test layer, an embedder — sees what a command
 * wrote. The exit status has no Effect equivalent and stays a process property.
 */
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
      ? Schema.encodeSync(ResultJson)(
          result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error },
        )
      : result.ok
        ? result.human
        : result.error.message,
  ).pipe(Effect.orDie);
  // No Effect equivalent: the runtime decides its own exit status from the program's
  // outcome, and these commands report failure in the envelope while still exiting
  // non-zero, so the status is set on the process directly.
  if (!result.ok) process.exitCode = REJECTED.includes(result.error.code) ? 2 : 1;
});

/**
 * Every command ends in exactly one envelope. `Effect.catch` sees typed failures only,
 * so a defect — anything that throws where the error channel was not declared — used
 * to leave both streams empty and only an exit status behind. Both are caught here.
 */
export function attempt<E, R>(operation: Effect.Effect<Result, E, R>, json: boolean) {
  return guarded(operation.pipe(Effect.flatMap((result) => printResult(result, json))), json);
}

/**
 * The same promise for a command that prints as it goes rather than returning one
 * result: whatever escapes still becomes one envelope, never an empty stream and a
 * bare exit status.
 */
export function guarded<E, R>(operation: Effect.Effect<void, E, R>, json: boolean) {
  return operation.pipe(
    Effect.catch((cause) => printResult(err("operation_failed", String(cause)), json)),
    Effect.catchDefect((defect) => printResult(err("operation_failed", String(defect)), json)),
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

/** A receipt this version cannot read is a failure to report, never a defect to die on. */
const readReceipt = Effect.fn("collie.readReceipt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeUnknownEffect(ResultBoundaryJson)(yield* fs.readFileString(file));
});

/**
 * The request id a caller can replay with. A receipt is written for a failure too, so
 * a failure that omits the id leaves the caller nothing to retry with but a fresh one
 * — which is a second Run, not a retry.
 */
function withRequestId(result: Result, id: string): Result {
  if (!result.ok)
    return err(result.error.code, result.error.message, {
      ...result.error.details,
      requestId: id,
    });
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
  if (yield* fs.exists(path)) return yield* readReceipt(path);
  yield* fs.makeDirectory(pathSvc.dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  if (!(yield* acquireLock(lock))) {
    if (yield* fs.exists(path)) return yield* readReceipt(path);
    return err("operation_failed", `Request "${id}" is already in progress.`, { requestId: id });
  }
  // Effect.ensuring, not try/finally: a typed failure out of `apply` unwinds past a
  // generator's finally without entering it, and the lock would outlive the request.
  return yield* Effect.gen(function* () {
    const result = yield* apply(id);
    const withRequest = withRequestId(result, id);
    if (!withRequest.ok && REJECTED.includes(withRequest.error.code)) return withRequest;
    const tmp = `${path}.${yield* currentPid}.tmp`;
    yield* fs.writeFileString(tmp, `${Schema.encodeSync(ResultBoundaryJson)(withRequest)}\n`);
    yield* fs.rename(tmp, path);
    return withRequest;
  }).pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
});
