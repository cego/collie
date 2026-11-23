import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Cause, Data, Effect, FileSystem, Option, Result, Schema, Semaphore, flow } from "effect";
import { isString } from "../../../src/schema";
import { nowIso } from "../../../src/time";

const WAIT = "30 seconds";
const TRIES = 3;
const LOG_BYTES = 1024 * 1024;

export const Attempted = Schema.Struct({
  door: Schema.Literals(["board", "chat"]),
  machine: Schema.String,
  request: Schema.String,
  kind: Schema.String,
  about: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  ended: Schema.Literals(["accepted", "repeat", "refused", "timed-out", "failed", "not-sent"]),
  reason: Schema.optionalKey(Schema.String),
});
export type Attempted = typeof Attempted.Type;

const lineOf = flow(
  Schema.encodeResult(
    Schema.fromJsonString(Schema.Struct({ at: Schema.String, ...Attempted.fields })),
  ),
  Result.getOrThrow,
);

export type ActionsLog = (line: Attempted) => Effect.Effect<void>;

export const unlogged: ActionsLog = () => Effect.void;

// WARNING: one lock per file, shared by its writers: a rotation is a stat, a rename and an append.
const writing = new Map<string, Semaphore.Semaphore>();

export const actionsLog = (dir: string, maxBytes = LOG_BYTES) =>
  Effect.map(FileSystem.FileSystem, (fs) => {
    const file = `${dir}/actions.log`;
    const lock = writing.get(file) ?? Semaphore.makeUnsafe(1);
    writing.set(file, lock);
    const returned: ActionsLog = (line) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const bytes = new TextEncoder().encode(`${lineOf({ at, ...line })}\n`);
        const size = yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > 0 && size + bytes.length > maxBytes) yield* fs.rename(file, `${file}.1`);
        yield* fs.writeFile(file, bytes, { flag: "a" });
      }).pipe(lock.withPermits(1), Effect.ignoreCause);
    return returned;
  });

export const reasonOf = (error: { readonly message: string }) =>
  "reason" in error && isString(error.reason)
    ? error.reason
    : "detail" in error && isString(error.detail)
      ? error.detail
      : error.message;

export class Outlined extends Data.TaggedError("Outlined")<{
  readonly reason: string;
  readonly logged: string;
}> {}

export class Unconfirmed extends Data.TaggedError("Unconfirmed")<{
  readonly request: string;
  readonly reason: string;
}> {}

const IDS = new Set([
  "_tag",
  "kind",
  "run",
  "runId",
  "proposal",
  "hash",
  "decision",
  "choiceId",
  "machine",
  "workspace",
  "project",
  "id",
  "control",
  "became",
  "ref",
  "agent",
  "offer",
]);

export const withheldOf: (action: Schema.Json, key?: string) => ReadonlyArray<string> = (
  action: Schema.Json,
  key = "",
) => {
  if (IDS.has(key)) return [];
  if (isString(action)) return action === "" ? [] : [action];
  if (Arr.isArray<typeof action>(action)) return Arr.flatMap(action, (value) => withheldOf(value));
  const object = asObject(action);
  return Result.isFailure(object)
    ? []
    : Arr.flatMap(Rec.toEntries(object.success), ([at, value]) => withheldOf(value, at));
};

const asObject = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json));

const without = (reason: string, withheld: ReadonlyArray<string>) =>
  Arr.reduce(withheld, reason, (left, secret) =>
    pipe(left, Str.replace(new RegExp(RegExp.escape(secret), "gi"), "…")),
  );

export interface Sending extends Omit<Attempted, "attempt" | "ended" | "reason"> {
  readonly log: ActionsLog;
  readonly withheld: ReadonlyArray<string>;
  readonly what: string;
}

// WARNING: a retry reuses the request id, which the host takes once.
export const confirmed = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  { log, what, withheld, ...sending }: Sending,
  call: Effect.Effect<A, E, R>,
  repeat: (reply: A) => boolean = () => false,
) => {
  const note = (attempt: number, ended: Attempted["ended"], reason?: string) =>
    log(
      reason === undefined
        ? { ...sending, attempt, ended }
        : { ...sending, attempt, ended, reason: without(reason, withheld) },
    );
  const tried: (attempt: number) => Effect.Effect<A, E | Unconfirmed, R> = (attempt) =>
    call.pipe(
      Effect.timeoutOption(WAIT),
      Effect.tapError((error) =>
        note(
          attempt,
          error._tag === "RpcClientError" ? "failed" : "refused",
          error instanceof Outlined ? error.logged : reasonOf(error),
        ),
      ),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? note(attempt, "failed", "the connection was renewed before this finished")
          : Effect.void,
      ),
      Effect.flatMap(
        Option.match({
          onSome: (reply) =>
            note(attempt, repeat(reply) ? "repeat" : "accepted").pipe(Effect.as(reply)),
          onNone: () =>
            note(attempt, "timed-out").pipe(
              Effect.andThen(
                attempt < TRIES
                  ? tried(attempt + 1)
                  : Effect.fail(
                      new Unconfirmed({
                        request: sending.request,
                        reason: `${sending.machine} did not confirm ${what} within 30 s, ${TRIES} times. It may still land; Try again sends the same request, which ${sending.machine} takes at most once.`,
                      }),
                    ),
              ),
            ),
        }),
      ),
      Effect.catchCause((cause) => {
        const error = Cause.findErrorOption(cause);
        const lost = Cause.hasInterruptsOnly(cause)
          ? "the connection was renewed before its reply"
          : Option.isSome(error) && error.value._tag === "RpcClientError"
            ? reasonOf(error.value)
            : undefined;
        return lost === undefined
          ? Effect.failCause(cause)
          : Effect.fail(
              new Unconfirmed({
                request: sending.request,
                reason: `${sending.machine} did not confirm ${what}: ${lost}. Its outcome is unknown; it may have been applied. Inspect its result before retrying with the same request (${sending.request}).`,
              }),
            );
      }),
    );
  return tried(1);
};
