import type { PlatformServices } from "./platform";
import type { Config } from "effect";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Option, Path, Schema, Stdio, Stream, flow, Result } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { PluginEnv } from "./env";
import type { HerdrError } from "./herdr";
import { sha256Hex } from "./attachments";
import { canonical } from "./canonical";
import type { Given } from "./canonical";
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

const Stored = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.ObjectKeyword,
    human: Schema.String,
    operation: Schema.optionalKey(Schema.String),
    digest: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.suspend(() => ExpectedError),
    operation: Schema.optionalKey(Schema.String),
    digest: Schema.optionalKey(Schema.String),
  }),
]);
const StoredJson = Schema.fromJsonString(Stored);

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

export const requestId = Effect.fn("collie.requestId")(function* (value: Option.Option<string>) {
  return Option.isSome(value) ? value.value : yield* newRequestId();
});

const NO_DIRECTORIES: Array<string> = [];

const receiptPath = Effect.fn("collie.receiptPath")(function* (env: PluginEnv, id: string) {
  const path = yield* Path.Path;
  return path.join(env.stateDir, "requests", "by-id", `${encodeURIComponent(id)}.json`);
});

type Found = { readonly file: string; readonly operation?: string };

// WARNING: receipts written before they were scoped live under their operation's own directory.
const receiptFound = Effect.fn("collie.receiptFound")(function* (
  env: PluginEnv,
  operation: string,
  id: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(env.stateDir, "requests");
  const file = `${encodeURIComponent(id)}.json`;
  const mine = yield* receiptPath(env, id);
  if (yield* fs.exists(mine)) {
    return Option.some<Found>({ file: mine });
  }
  const scoped = path.join(root, operation, file);
  if (yield* fs.exists(scoped)) {
    return Option.some<Found>({ file: scoped, operation });
  }
  const listed = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => NO_DIRECTORIES));
  const elsewhere = Arr.filter(listed, (one) => one !== "by-id" && one !== operation);
  const there = yield* Effect.forEach(elsewhere, (one) =>
    Effect.map(fs.exists(path.join(root, one, file)), (is) =>
      is ? [{ file: path.join(root, one, file), operation: one }] : [],
    ),
  );
  return Option.fromUndefinedOr(Arr.flatten(there)[0]);
});

const readReceipt = Effect.fn("collie.readReceipt")(function* (found: Found) {
  const fs = yield* FileSystem.FileSystem;
  const stored = yield* Schema.decodeEffect(StoredJson)(yield* fs.readFileString(found.file));
  const result: Result = stored.ok
    ? { ok: true, data: stored.data, human: stored.human }
    : { ok: false, error: stored.error };
  return {
    operation: stored.operation ?? found.operation,
    digest: stored.digest,
    result,
  };
});

export type Call = {
  readonly operation: string;
  readonly run: string | null;
  readonly destination?: "cwd";
  readonly at?: string | null;
  readonly files?: ReadonlyArray<string>;
  readonly args: Given;
};

const NamedRun = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ runId: Schema.String })])),
});

const namedRun = (result: Result) => {
  if (!result.ok || !Schema.is(NamedRun)(result.data)) {
    return null;
  }
  const { runId, run } = result.data;
  if (runId !== undefined) {
    return runId;
  }
  return run === undefined ? null : Schema.is(Schema.String)(run) ? run : run.runId;
};

const scopeRefusal = (id: string, unscoped: boolean) =>
  err(
    "invalid_input",
    unscoped
      ? `Request "${id}" was used before receipts were scoped to a Run and its arguments, so it is not replayed. Check that operation's effect before retrying under a new id.`
      : `Request "${id}" was already used for another request, so this one applied nothing. Check that first request's effect before retrying under a new id.`,
    { requestId: id },
  );

const digestOf = (call: Call, env: PluginEnv, files: ReadonlyArray<string>) =>
  sha256Hex(
    canonical({
      operation: call.operation,
      caller: env.caller ?? null,
      run: call.run,
      where: {
        machine: env.machine ?? null,
        cwd: call.destination === "cwd" ? env.cwd : null,
        asked: call.destination === "cwd" ? (env.asked ?? null) : null,
        at: call.at ?? null,
      },
      files,
      args: call.args,
    }),
  );

const replayOf =
  (call: Call, id: string, caller: string | null, digest: string) =>
  (stored: {
    readonly operation?: string | undefined;
    readonly digest?: string | undefined;
    readonly result: Result;
  }) => {
    if (stored.operation !== undefined && stored.operation !== call.operation) {
      return scopeRefusal(id, false);
    }
    if (stored.digest === digest) {
      return stored.result;
    }
    const named = namedRun(stored.result);
    const unscoped =
      stored.digest === undefined &&
      named !== null &&
      named === call.run &&
      (caller === null || caller === named);
    return unscoped ? stored.result : scopeRefusal(id, stored.digest === undefined);
  };

// WARNING: failures carry the request id too, so a retry replays rather than starting a second Run.
export function withRequestId(result: Result, id: string) {
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
  call: Call,
  requested: Option.Option<string>,
  apply: (id: string) => Effect.Effect<Result, CollieError, CollieServices>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;
  const id = yield* requestId(requested);
  const path = yield* receiptPath(env, id);
  const digest = digestOf(
    call,
    env,
    Arr.map(call.files ?? [], (one) => pathSvc.resolve(env.cwd, one)),
  );
  const replay = replayOf(call, id, env.caller ?? null, digest);
  const recorded = Effect.gen(function* () {
    const found = yield* receiptFound(env, call.operation, id);
    return Option.isNone(found) ? null : replay(yield* readReceipt(found.value));
  });
  const already = yield* recorded;
  if (already !== null) {
    return already;
  }
  yield* fs.makeDirectory(pathSvc.dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const meanwhile = Effect.gen(function* () {
    const found = yield* recorded;
    return (
      found ?? err("operation_failed", `Request "${id}" is already in progress.`, { requestId: id })
    );
  });
  return yield* withLock(
    lock,
    meanwhile,
    Effect.gen(function* () {
      const found = yield* recorded;
      if (found !== null) {
        return found;
      }
      const tmp = `${path}.${yield* currentPid}.tmp`;
      const save = (value: Result) =>
        fs
          .writeFileString(
            tmp,
            `${flow(
              Schema.encodeResult(StoredJson),
              Result.getOrThrow,
            )({
              ...value,
              operation: call.operation,
              digest,
            })}\n`,
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
