import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Duration, Schema, flow, Result } from "effect";
import { holdLock } from "./lock";
import { FrontDoor, RequestConflict, Where } from "./board-model";
import { voiceOf } from "./proposals";
import type { Voice } from "./proposals";
import {
  appendJournal,
  appendRunJournal,
  lastRunJournal,
  readJournal,
  readRunJournal,
  runJournal,
} from "./journal";
import { parentOf, runOfDir } from "./run-records";
import { nowIso } from "./time";

export const ScheduledBy = Schema.Struct({ name: Schema.String, occurrence: Schema.String });
export type ScheduledBy = typeof ScheduledBy.Type;

export const AuditLine = Schema.Struct({
  at: Schema.String,
  requested: Schema.optionalKey(Schema.String),
  operation: Schema.String,
  request: Schema.String,
  actor: Schema.Struct({
    origin: FrontDoor,
    requestId: Schema.String,
    from: Schema.optionalKey(Where),
    conversation: Schema.optionalKey(Schema.String),
    said: Schema.optionalKey(Schema.String),
    attachments: Schema.optionalKey(Schema.Array(Schema.String)),
    schedule: Schema.optionalKey(ScheduledBy),
  }),
  reason: Schema.optionalKey(Schema.String),
  asked: Schema.optionalKey(Schema.Json),
  result: Schema.Json,
  // WARNING: a request that has not finished with its answer keeps it, so a retry asks only what is left.
  unfinal: Schema.optionalKey(Schema.Boolean),
});
export type AuditLine = typeof AuditLine.Type;

const STARTED_FROM: Partial<Record<FrontDoor, string>> = {
  chat: "chat",
  desktop: "Desktop",
  board: "the board",
  cli: "the CLI",
  "cli-tty": "the CLI",
};

export const startedBy = (
  lines: ReadonlyArray<AuditLine>,
  run: { readonly id: string; readonly parent: string | null },
) => {
  const actor = Option.getOrUndefined(
    Arr.findFirst(lines, (line) => line.operation === "start"),
  )?.actor;
  if (actor?.schedule !== undefined) {
    return `Started by schedule \`${actor.schedule.name}\` for ${actor.schedule.occurrence}`;
  }
  const door = actor === undefined ? undefined : STARTED_FROM[actor.origin];
  if (door !== undefined) {
    return `Started from ${door}`;
  }
  if (run.parent === null) {
    return undefined;
  }
  const invocation = pipe_(run.id, Str.startsWith(`${run.parent}.`))
    ? pipe_(run.id, Str.slice(run.parent.length + 1))
    : run.id;
  return `Started by ${run.parent} as ${invocation}`;
};

export const whoActed = (actor: AuditLine["actor"]) =>
  actor.from?.agent ?? STARTED_FROM[actor.origin] ?? actor.origin;

const AuditJson = Schema.fromJsonString(AuditLine);
const sameJson = Schema.toEquivalence(Schema.Json);
export const AUDIT_FILE = "operations.jsonl";
const fileOf = (runDir: string) => `${runDir}/${AUDIT_FILE}`;

const ofRun = (dir: string) => runOfDir(parentOf(dir)) === "runs";

export const readAudit = Effect.fn("Audit.read")(function* (dir: string) {
  if (ofRun(dir)) {
    return yield* readRunJournal(runJournal(dir, AUDIT_FILE), AuditJson);
  }
  return yield* readJournal(fileOf(dir), AuditJson);
});

export const lastAudit = Effect.fn("Audit.last")(function* (
  dir: string,
  operations: ReadonlyArray<string> | null,
) {
  if (ofRun(dir)) {
    return yield* lastRunJournal(runJournal(dir, AUDIT_FILE), AuditJson, operations);
  }
  return Arr.findLast(
    yield* readJournal(fileOf(dir), AuditJson),
    (line) => operations === null || operations.includes(line.operation),
  );
});

export const trimAudit = Effect.fn("Audit.trim")(function* (runDir: string, keep: number) {
  const lines = yield* readAudit(runDir);
  if (lines.length <= keep) {
    return;
  }
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

export const actorOf = (
  who: Voice & {
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly schedule?: ScheduledBy | undefined;
  },
  request: string,
) => {
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
    readonly requested?: string | undefined;
    readonly unfinal?: boolean | undefined;
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
  if (line.reason !== undefined) {
    full = { ...full, reason: line.reason };
  }
  if (line.asked !== undefined) {
    full = { ...full, asked: line.asked };
  }
  if (line.requested !== undefined) {
    full = { ...full, requested: line.requested };
  }
  if (line.unfinal === true) {
    full = { ...full, unfinal: true };
  }
  yield* ofRun(runDir)
    ? appendRunJournal(runJournal(runDir, AUDIT_FILE), AuditJson, full)
    : appendJournal(fileOf(runDir), AuditJson, full);
});

const recorded = Effect.fn("Audit.recorded")(function* <A, I extends Schema.Json, E, R>(
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
    // WARNING: an answer that is not final is kept only for a line that says how to carry on with it.
    readonly settles?: (value: A) => boolean | undefined;
    readonly more?: ((kept: A) => Effect.Effect<A, E, R>) | undefined;
  },
  act: Effect.Effect<A, E, R>,
) {
  const prior = Option.getOrUndefined(
    Arr.findLast(yield* readAudit(runDir), (one) => one.request === line.request),
  );
  const requested = yield* nowIso;
  let value: A;
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
    const kept = yield* Schema.decodeUnknownEffect(line.result)(prior.result).pipe(Effect.orDie);
    if (prior.unfinal !== true || line.more === undefined) {
      return kept;
    }
    value = yield* line.more(kept);
  } else {
    value = yield* act;
  }
  const settled = line.settles === undefined || line.settles(value);
  if (!settled && line.more === undefined) {
    return value;
  }
  yield* recordAudit(runDir, { ...line, value, requested, unfinal: !settled }).pipe(Effect.orDie);
  return value;
});

// WARNING: the claim is taken before the audit is read, so copies of one request arriving together act once.
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
    readonly settles?: (value: A) => boolean | undefined;
    readonly more?: ((kept: A) => Effect.Effect<A, E, R>) | undefined;
  },
  act: Effect.Effect<A, E, R>,
) {
  const claim = `${runDir}/claim-${Str.replaceAll(/[^A-Za-z0-9._-]/g, "_")(line.request)}.lock`;
  return yield* holdLock(
    claim,
    Effect.fail(
      new RequestConflict({
        request: line.request,
        reason: `request "${line.request}" is still being acted on`,
      }),
    ),
    Effect.suspend(() => recorded(runDir, line, act)),
    Duration.seconds(30),
  );
});
