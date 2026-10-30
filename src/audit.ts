// A Run's audit trail: every operation a front door asked of it, who asked, and what came
// of it. Written by the host alone, which stamps the front door the channel declared.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { FrontDoor, RequestConflict, Where } from "./board-model";
import { voiceOf, type Voice } from "./proposals";
import { appendJournal, readJournal } from "./journal";
import { nowIso } from "./time";

export const ScheduledBy = Schema.Struct({ name: Schema.String, occurrence: Schema.String });
export type ScheduledBy = typeof ScheduledBy.Type;

export const AuditLine = Schema.Struct({
  at: Schema.String,
  operation: Schema.String,
  request: Schema.String,
  actor: Schema.Struct({
    origin: FrontDoor,
    requestId: Schema.String,
    from: Schema.optionalKey(Where),
    conversation: Schema.optionalKey(Schema.String),
    said: Schema.optionalKey(Schema.String),
    attachments: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The Schedule, and the occurrence it was for, where the host started a Run for one. */
    schedule: Schema.optionalKey(ScheduledBy),
  }),
  /** Why, in the asker's own words, where they gave one. */
  reason: Schema.optionalKey(Schema.String),
  /** What the request asked for, which the same request asking again has to match. */
  asked: Schema.optionalKey(Schema.Json),
  result: Schema.Json,
});
export type AuditLine = typeof AuditLine.Type;

const STARTED_FROM: Partial<Record<FrontDoor, string>> = {
  chat: "chat",
  desktop: "Desktop",
  board: "the board",
  cli: "the CLI",
  "cli-tty": "the CLI",
};

/** Who started a Run, from its start line, else from its parent; undefined where neither says. */
export const startedBy = (
  lines: ReadonlyArray<AuditLine>,
  run: { readonly id: string; readonly parent: string | null },
): string | undefined => {
  const actor = Option.getOrUndefined(
    Arr.findFirst(lines, (line) => line.operation === "start"),
  )?.actor;
  if (actor?.schedule !== undefined)
    return `Started by schedule \`${actor.schedule.name}\` for ${actor.schedule.occurrence}`;
  const door = actor === undefined ? undefined : STARTED_FROM[actor.origin];
  if (door !== undefined) return `Started from ${door}`;
  if (run.parent === null) return undefined;
  const invocation = pipe_(run.id, Str.startsWith(`${run.parent}.`))
    ? pipe_(run.id, Str.slice(run.parent.length + 1))
    : run.id;
  return `Started by ${run.parent} as ${invocation}`;
};

/** Who did something, in the words a Flow says it: the agent's name, or the front door a human used. */
export const whoActed = (actor: AuditLine["actor"]): string =>
  actor.from?.agent ?? STARTED_FROM[actor.origin] ?? actor.origin;

const AuditJson = Schema.fromJsonString(AuditLine);
const sameJson = Schema.toEquivalence(Schema.Json);
export const AUDIT_FILE = "operations.jsonl";
const fileOf = (runDir: string) => `${runDir}/${AUDIT_FILE}`;

export const readAudit = (runDir: string) => readJournal(fileOf(runDir), AuditJson);

/** Keeps a trail's newest `keep` lines, for one that is written too often to keep whole. */
export const trimAudit = Effect.fn("Audit.trim")(function* (runDir: string, keep: number) {
  const lines = yield* readAudit(runDir);
  if (lines.length <= keep) return;
  const fs = yield* FileSystem.FileSystem;
  const encode = flow(Schema.encodeResult(AuditJson), Result.getOrThrow);
  const tmp = `${fileOf(runDir)}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    tmp,
    Arr.join(
      Arr.map(lines.slice(-keep), (line) => `${encode(line)}\n`),
      "",
    ),
  );
  yield* fs.rename(tmp, fileOf(runDir));
});

/** What one operation did, written down under the request that asked for it. */
/** Who asked, as an audit line records them under `request`. */
export const actorOf = (
  who: Voice & {
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly schedule?: ScheduledBy | undefined;
  },
  request: string,
): AuditLine["actor"] => {
  const voiced = { origin: who.origin, requestId: request, ...voiceOf(who) };
  const spoken = who.schedule === undefined ? voiced : { ...voiced, schedule: who.schedule };
  return who.from === undefined ? spoken : { ...spoken, from: who.from };
};

export const recordAudit = Effect.fn("Audit.record")(function* <A, I extends Schema.Json>(
  runDir: string,
  line: Voice & {
    readonly operation: string;
    readonly request: string;
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly schedule?: ScheduledBy | undefined;
    readonly reason?: string | undefined;
    readonly asked?: Schema.Json | undefined;
    readonly result: Schema.Codec<A, I>;
    readonly value: A;
  },
) {
  const written: AuditLine = {
    at: yield* nowIso,
    operation: line.operation,
    request: line.request,
    actor: actorOf(line, line.request),
    result: yield* Schema.encodeEffect(line.result)(line.value).pipe(Effect.orDie),
  };
  let full = written;
  if (line.reason !== undefined) full = { ...full, reason: line.reason };
  if (line.asked !== undefined) full = { ...full, asked: line.asked };
  yield* appendJournal(fileOf(runDir), AuditJson, full);
});

/**
 * An operation that is not idempotent by itself, done once per request: a request already
 * in the trail hands back what it did then, and one that asked for something else is refused.
 */
// ponytail: two copies of one request arriving together can both act; a lock per Run if that happens.
export const once = Effect.fn("Audit.once")(function* <A, I extends Schema.Json, E, R>(
  runDir: string,
  line: Voice & {
    readonly operation: string;
    readonly request: string;
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly schedule?: ScheduledBy | undefined;
    readonly reason?: string | undefined;
    readonly asked?: Schema.Json | undefined;
    readonly result: Schema.Codec<A, I>;
  },
  act: Effect.Effect<A, E, R>,
) {
  const prior = Option.getOrUndefined(
    Arr.findFirst(yield* readAudit(runDir), (one) => one.request === line.request),
  );
  if (prior !== undefined) {
    if (prior.operation !== line.operation) {
      return yield* new RequestConflict({
        request: line.request,
        reason: `request "${line.request}" was already ${prior.operation}, not ${line.operation}`,
      });
    }
    if (prior.asked !== undefined && !sameJson(prior.asked, line.asked ?? null)) {
      return yield* new RequestConflict({
        request: line.request,
        reason: `request "${line.request}" already asked ${line.operation} for something else`,
      });
    }
    return yield* Schema.decodeUnknownEffect(line.result)(prior.result).pipe(Effect.orDie);
  }
  const value = yield* act;
  yield* recordAudit(runDir, { ...line, value }).pipe(Effect.orDie);
  return value;
});
