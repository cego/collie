// A Run's audit trail: every operation a front door asked of it, who asked, and what came
// of it. Written by the host alone, which stamps the front door the channel declared.

import { Effect, Schema } from "effect";
import { FrontDoor, RequestConflict, Where } from "./board-model";
import { appendJournal, readJournal } from "./journal";
import { nowIso } from "./time";

export const AuditLine = Schema.Struct({
  at: Schema.String,
  operation: Schema.String,
  request: Schema.String,
  actor: Schema.Struct({
    origin: FrontDoor,
    requestId: Schema.String,
    from: Schema.optionalKey(Where),
  }),
  /** Why, in the asker's own words, where they gave one. */
  reason: Schema.optionalKey(Schema.String),
  /** What the request asked for, which the same request asking again has to match. */
  asked: Schema.optionalKey(Schema.Json),
  result: Schema.Json,
});
export type AuditLine = typeof AuditLine.Type;

const AuditJson = Schema.fromJsonString(AuditLine);
const sameJson = Schema.toEquivalence(Schema.Json);
export const AUDIT_FILE = "operations.jsonl";
const fileOf = (runDir: string) => `${runDir}/${AUDIT_FILE}`;

export const readAudit = (runDir: string) => readJournal(fileOf(runDir), AuditJson);

/** What one operation did, written down under the request that asked for it. */
export const recordAudit = Effect.fn("Audit.record")(function* <A, I extends Schema.Json>(
  runDir: string,
  line: {
    readonly operation: string;
    readonly request: string;
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly reason?: string | undefined;
    readonly asked?: Schema.Json | undefined;
    readonly result: Schema.Codec<A, I>;
    readonly value: A;
  },
) {
  const written: AuditLine = {
    at: yield* nowIso(),
    operation: line.operation,
    request: line.request,
    actor:
      line.from === undefined
        ? { origin: line.origin, requestId: line.request }
        : { origin: line.origin, requestId: line.request, from: line.from },
    result: Schema.encodeSync(line.result)(line.value),
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
  line: {
    readonly operation: string;
    readonly request: string;
    readonly origin: FrontDoor;
    readonly from?: Where | undefined;
    readonly reason?: string | undefined;
    readonly asked?: Schema.Json | undefined;
    readonly result: Schema.Codec<A, I>;
  },
  act: Effect.Effect<A, E, R>,
) {
  const prior = (yield* readAudit(runDir)).find((one) => one.request === line.request);
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
