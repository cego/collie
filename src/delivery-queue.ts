import { Effect, FileSystem, Schema, Semaphore, Struct } from "effect";
import { AuditLine } from "./audit";

export const Steered = Schema.Struct({
  note: Schema.optional(Schema.String),
  agent: Schema.String,
  /** Submission to the harness, never acceptance by this queue. */
  delivered: Schema.Boolean,
  detail: Schema.String,
  /** Durably kept until a supported submission is possible; nothing has been sent. */
  queued: Schema.optionalKey(Schema.Boolean),
  gone: Schema.optionalKey(Schema.Boolean),
  finished: Schema.optionalKey(Schema.Boolean),
  /** Whether the harness was seen to take the submission, and how. */
  observed: Schema.optionalKey(Schema.Boolean),
  how: Schema.optionalKey(Schema.String),
  pane: Schema.optionalKey(Schema.String),
  kept: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Queued = Schema.Struct({
  runId: Schema.String,
  request: Schema.String,
  text: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(AuditLine.fields.actor.mapFields(Struct.omit(["requestId"]))),
  result: Schema.NullOr(Steered),
});
export type Queued = typeof Queued.Type;
const json = Schema.fromJsonString(Schema.Array(Queued));
const lock = Semaphore.makeUnsafe(1);

export const readQueue = Effect.fn("DeliveryQueue.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${dir}/delivery-queue.json`;
  if (!(yield* fs.exists(file))) return [];
  return yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(json)));
});

export const keepQueued = (dir: string, queued: Queued) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const before = yield* readQueue(dir);
      const old = before.find((one) => one.request === queued.request);
      if (old !== undefined && (old.result !== null || queued.result === null)) return;
      const next =
        old === undefined
          ? [...before, queued]
          : before.map((one) =>
              one.request === queued.request ? { ...one, result: queued.result } : one,
            );
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/delivery-queue.json.tmp`, Schema.encodeSync(json)(next));
      yield* fs.rename(`${dir}/delivery-queue.json.tmp`, `${dir}/delivery-queue.json`);
    }),
  );
