import {
  Cause,
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Schedule,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Artefact, type ArtefactCollection, type RegisterFile } from "./artefact-model";
import { ATTACHMENT_BYTES, mediaTypeOf, sha256Hex } from "./attachments";
import { HostRefused, PART_BYTES, RequestConflict, type RunFile } from "./board-model";
import { AuditLine } from "./audit";
import type { RunFacts } from "./runs";
import { epochMs, nowIso } from "./time";
import type { PlatformError } from "effect/PlatformError";
import { StoreWrites } from "./store-writes";
import { refreshJobs } from "./artefact-refresh";

const json = Schema.fromJsonString(Artefact);
const decode = (data: string) => Schema.decodeEffect(json)(data).pipe(Effect.orDie);
const encode = (item: Artefact) => Schema.encodeEffect(json)(item).pipe(Effect.orDie);
const refused = (reason: string) => new HostRefused({ reason });
type CopyFailure = HostRefused | PlatformError | Cause.TimeoutError;
const reasonOf = (error: CopyFailure) =>
  error._tag === "HostRefused" ? error.reason : error.message;
const availabilityOf = (error: CopyFailure) =>
  error._tag !== "PlatformError"
    ? "refresh-failed"
    : error.reason._tag === "NotFound"
      ? "missing"
      : error.reason._tag === "PermissionDenied"
        ? "denied"
        : "refresh-failed";
const ASKED = Schema.fromJsonString(
  Schema.Tuple([
    Schema.String,
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.NullOr(Schema.String),
    Schema.Boolean,
  ]),
);
const blob = (run: RunFacts, digest: string) => `${run.dir}/.artefacts/${digest}`;

const retain = Effect.fn("Artefacts.retain")(function* (
  run: RunFacts,
  source: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const [base, real] = yield* Effect.all([fs.realPath(root), fs.realPath(source)]);
  if (!Str.startsWith(`${base}${path.sep}`)(real))
    return yield* refused("The source leaves its source directory");
  yield* fs.access(real, { readable: true });
  const before = yield* fs.stat(real);
  if (before.type !== "File") return yield* refused("The source is not a regular file");
  if (Number(before.size) > ATTACHMENT_BYTES)
    return yield* refused("The source exceeds the 100 MiB file limit");
  const bytes = yield* fs.readFile(real);
  const other = yield* fs.readFile(real);
  const after = yield* fs.stat(real);
  const date = (value: typeof before.mtime) => Option.getOrUndefined(value)?.getTime();
  if (
    bytes.length > ATTACHMENT_BYTES ||
    bytes.length !== Number(before.size) ||
    before.size !== after.size ||
    date(before.mtime) !== date(after.mtime) ||
    date(before.birthtime) !== date(after.birthtime) ||
    before.dev !== after.dev ||
    Option.getOrUndefined(before.ino) !== Option.getOrUndefined(after.ino) ||
    sha256Hex(bytes) !== sha256Hex(other)
  )
    return yield* refused("The source changed while copying; refresh to retry");
  const digest = sha256Hex(bytes);
  const target = blob(run, digest);
  if (!(yield* fs.exists(target))) {
    yield* fs.makeDirectory(`${run.dir}/.artefacts`, { recursive: true });
    const temp = `${target}.${yield* random.uuidV4()}.tmp`;
    yield* fs.writeFile(temp, bytes);
    yield* fs.rename(temp, target);
  }
  return {
    digest,
    size: bytes.length,
    created:
      Option.isSome(before.birthtime) && before.birthtime.value.getTime() > 0
        ? { at: before.birthtime.value.toISOString(), provenance: "filesystem-birthtime" }
        : null,
    updated: Option.isSome(before.mtime)
      ? { at: before.mtime.value.toISOString(), provenance: "filesystem-mtime" }
      : null,
  };
});

/** A stable copy of `source`, retried while it changes under the copy, within a bound. */
const copied = Effect.fn("Artefacts.copied")(function* (run: RunFacts, source: string) {
  const path = yield* Path.Path;
  return yield* retain(run, source, path.dirname(source)).pipe(
    Effect.retry({
      schedule: Schedule.recurs(2),
      while: (error) =>
        error._tag === "HostRefused" && Str.startsWith("The source changed")(error.reason),
    }),
    Effect.timeout("4 seconds"),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reconciling = yield* Semaphore.make(1);
  const refreshing = refreshJobs();
  const discoveryCursor = new Map<string, string>();
  const writes = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
  const list = (run: string) =>
    sql<{
      data: string;
    }>`SELECT data FROM collie_artefacts WHERE run = ${run} ORDER BY origin`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.data))),
    );
  const put = (item: Artefact) =>
    Effect.gen(function* () {
      const data = yield* encode(item);
      yield* sql`UPDATE collie_artefacts SET data = ${data} WHERE run = ${item.run} AND id = ${item.id}`;
    });
  const notify = (run: string) => Effect.sync(() => writes?.([run]));
  const save = (item: Artefact) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const data = yield* encode(item);
          yield* sql`INSERT INTO collie_artefacts (run, id, origin, data) VALUES (${item.run}, ${item.id}, ${item.ref}, ${data}) ON CONFLICT(run, id) DO UPDATE SET origin = excluded.origin, data = excluded.data`;
          yield* sql`INSERT OR IGNORE INTO collie_artefact_revisions (run, id, revision, digest, size) VALUES (${item.run}, ${item.id}, ${item.revision}, ${item.digest}, ${item.size})`;
        }),
      )
      .pipe(Effect.orDie);
  const failed = (prior: Artefact, error: CopyFailure) =>
    Effect.gen(function* () {
      const reason = reasonOf(error);
      const availability = availabilityOf(error);
      const item = {
        ...prior,
        observedAt: yield* nowIso,
        sourceAvailability: availability,
        reason,
      };
      yield* put(item).pipe(Effect.orDie);
      if (prior.sourceAvailability !== availability || prior.reason !== reason)
        yield* notify(prior.run);
      return item;
    });
  const refreshRegistered = Effect.fn("Artefacts.refreshRegistered")(function* (
    run: RunFacts,
    prior: Artefact,
  ) {
    if (prior.tracking !== "local") return prior;
    const result = yield* copied(run, prior.source).pipe(Effect.result);
    if (result._tag === "Failure") return yield* failed(prior, result.failure);
    const at = yield* nowIso;
    const changed = result.success.digest !== prior.digest;
    const item = {
      ...prior,
      ...result.success,
      revision: prior.revision + (changed ? 1 : 0),
      detectedAt: changed ? at : prior.detectedAt,
      observedAt: at,
      sourceAvailability: "available",
      reason: null,
    };
    yield* save(item);
    if (changed || prior.sourceAvailability !== "available") yield* notify(run.id);
    return item;
  });
  const register = Effect.fn("Artefacts.register")(function* (
    run: RunFacts,
    installation: string,
    input: RegisterFile,
    request: string,
    actor: AuditLine["actor"],
  ) {
    const path = yield* Path.Path;
    if (
      !path.isAbsolute(input.path) ||
      input.path.length > 8192 ||
      Arr.contains(Str.split(input.path, /[\\/]/), "..") ||
      /[\x00-\x1f]/.test(input.path)
    )
      return yield* refused(
        "Registration needs an absolute file path without traversal or control characters",
      );
    if ((input.title?.length ?? 0) > 512 || (input.role?.length ?? 0) > 128)
      return yield* refused("The title or role is too long");
    const asked = yield* Schema.encodeEffect(ASKED)([
      input.path,
      input.id ?? null,
      input.title ?? null,
      input.kind ?? null,
      input.role ?? null,
      input.snapshot ?? false,
    ]).pipe(Effect.orDie);
    const receipt = (yield* sql<{
      asked: string;
      data: string;
    }>`SELECT asked, data FROM collie_artefact_registrations WHERE run = ${run.id} AND request = ${request}`.pipe(
      Effect.orDie,
    ))[0];
    if (receipt !== undefined) {
      if (receipt.asked !== asked)
        return yield* new RequestConflict({
          request,
          reason: "This request registered different material",
        });
      return { item: yield* decode(receipt.data), fresh: false };
    }
    const source = path.normalize(input.path);
    const ref = `registered:${source}`;
    const items = yield* list(run.id);
    const prior = Option.getOrUndefined(
      Arr.findFirst(items, (one) =>
        input.id === undefined ? one.ref === ref : one.id === input.id,
      ),
    );
    if (input.id !== undefined && prior === undefined) return yield* refused("No such artefact");
    if (Arr.some(items, (one) => one.ref === ref && prior !== undefined && one.id !== prior.id))
      return yield* refused("This source already belongs to another artefact");
    const observed = yield* copied(run, source).pipe(
      Effect.tapError((error) => (prior === undefined ? Effect.void : failed(prior, error))),
      Effect.mapError((error) => refused(reasonOf(error))),
    );
    const at = yield* nowIso;
    const revision =
      prior === undefined
        ? 1
        : prior.revision + (prior.digest === observed.digest && prior.source === source ? 0 : 1);
    const item: Artefact = {
      ...prior,
      ...observed,
      installation,
      id: prior?.id ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4()),
      run: run.id,
      ref,
      source,
      kind: input.kind ?? prior?.kind ?? "file",
      role: input.role ?? prior?.role ?? "deliverable",
      title: input.title ?? prior?.title ?? path.basename(source),
      mediaType: mediaTypeOf(source),
      revision,
      registeredAt: prior?.registeredAt ?? at,
      observedAt: at,
      detectedAt: prior?.revision === revision ? prior.detectedAt : at,
      seen: prior?.seen ?? null,
      sourceAvailability: "available",
      retainedAvailability: "available",
      reason: null,
      tracking: input.snapshot === true ? "snapshot" : "local",
      registeredBy: prior?.registeredBy ?? actor,
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* save(item);
          const data = yield* encode(item);
          yield* sql`INSERT INTO collie_artefact_registrations (run, request, asked, data) VALUES (${run.id}, ${request}, ${asked}, ${data})`;
        }),
      )
      .pipe(Effect.orDie);
    yield* notify(run.id);
    return { item, fresh: true };
  });
  const reconcile = Effect.fn("Artefacts.reconcile")(function* (run: RunFacts, background = false) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    let changed = false;
    const observedAt = yield* nowIso;
    const existing = yield* list(run.id);
    const origins = new Map(Arr.map(existing, (item) => [item.ref, item]));
    if (!background)
      for (const item of existing)
        if (item.tracking === "local") yield* refreshRegistered(run, item);
    let remaining = background ? 8 : Number.POSITIVE_INFINITY;
    const cursor = discoveryCursor.get(run.id) ?? "";
    for (const [prefix, root, role] of [
      // Sorted by prefix: the background cursor compares whole refs.
      ["attachment", `${run.dir}/attachments`, "input"],
      ["evidence", run.evidence, "evidence"],
      ["handoff", `${run.dir}/handoffs`, "handoff"],
      ["plan", `${run.dir}/plan`, "plan"],
    ] as const) {
      const names = yield* fs
        .readDirectory(root, { recursive: true })
        .pipe(Effect.orElseSucceed(() => []));
      const known = Arr.map(
        Arr.filter(existing, (item) => Str.startsWith(`${prefix}:`)(item.ref)),
        (item) => Str.slice(prefix.length + 1)(item.ref),
      );
      for (const name of [...new Set([...names, ...known])].sort()) {
        const ref = `${prefix}:${name}`;
        if (background && ref <= cursor) continue;
        if (remaining-- <= 0) return { items: yield* list(run.id) } satisfies ArtefactCollection;
        if (background) discoveryCursor.set(run.id, ref);
        const prior = origins.get(ref);
        if (
          Arr.some(
            Str.split(name, /[\\/]/),
            (part) =>
              Str.startsWith(".")(part) ||
              /^(?:credentials?|secrets?|settings)(?:\.|$)/i.test(part),
          )
        )
          continue;
        if (
          prefix === "evidence" &&
          /(?:^|\/)(?:approved\.json|(?:verifications|metrics|measurements)\.jsonl)$/.test(name)
        )
          continue;
        const source = path.join(root, name);
        const observed = yield* Effect.gen(function* () {
          const [base, real] = yield* Effect.all([fs.realPath(root), fs.realPath(source)]);
          if (!Str.startsWith(`${base}${path.sep}`)(real))
            return yield* refused("The source leaves its Run collection");
          const before = yield* fs.stat(real);
          if (before.type !== "File") return null;
          if (Number(before.size) > ATTACHMENT_BYTES)
            return yield* refused("The source exceeds the 100 MiB file limit");
          const bytes = yield* fs.readFile(real);
          const after = yield* fs.stat(real);
          if (
            bytes.length > ATTACHMENT_BYTES ||
            before.size !== after.size ||
            Option.getOrUndefined(before.mtime)?.getTime() !==
              Option.getOrUndefined(after.mtime)?.getTime()
          )
            return yield* refused("The source changed while reading; refresh to retry");
          const digest = sha256Hex(bytes);
          if (digest !== sha256Hex(yield* fs.readFile(real)))
            return yield* refused("The source changed while copying; refresh to retry");
          const target = blob(run, digest);
          if (!(yield* fs.exists(target))) {
            yield* fs.makeDirectory(`${run.dir}/.artefacts`, { recursive: true });
            const temp = `${target}.${yield* random.uuidV4()}.tmp`;
            yield* fs.writeFile(temp, bytes);
            yield* fs.rename(temp, target);
          }
          return {
            digest,
            size: bytes.length,
            updated: Option.isSome(before.mtime)
              ? { at: before.mtime.value.toISOString(), provenance: "filesystem-mtime" }
              : null,
          };
        }).pipe(Effect.result);
        if (observed._tag === "Failure") {
          if (prior !== undefined) {
            const failure = observed.failure;
            const availability =
              failure._tag === "PlatformError" && failure.reason._tag === "NotFound"
                ? "missing"
                : failure._tag === "PlatformError" && failure.reason._tag === "PermissionDenied"
                  ? "denied"
                  : "refresh-failed";
            const item = {
              ...prior,
              observedAt,
              sourceAvailability: availability,
              reason: String(failure),
            };
            yield* put(item).pipe(Effect.orDie);
            changed ||=
              prior.sourceAvailability !== item.sourceAvailability || prior.reason !== item.reason;
          }
          continue;
        }
        if (observed.success === null) {
          if (prior !== undefined) {
            yield* put({
              ...prior,
              observedAt,
              sourceAvailability: "unsupported",
              reason: "The source is no longer a regular file",
            }).pipe(Effect.orDie);
            changed ||= prior.sourceAvailability !== "unsupported";
          }
          continue;
        }
        const { digest, size, updated } = observed.success;
        const revision =
          prior === undefined ? 1 : prior.revision + (prior.digest === digest ? 0 : 1);
        const item: Artefact = {
          id: prior?.id ?? (yield* random.uuidV4()),
          run: run.id,
          kind: "file",
          role,
          title: name,
          ref,
          source,
          mediaType: mediaTypeOf(name),
          size,
          revision,
          digest,
          created: null,
          updated,
          registeredAt: prior?.registeredAt ?? observedAt,
          observedAt,
          detectedAt:
            prior === undefined || prior.digest !== digest ? observedAt : prior.detectedAt,
          seen: prior?.seen ?? null,
          sourceAvailability: "available",
          retainedAvailability: "available",
          reason: null,
        };
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const data = yield* encode(item);
              yield* sql`INSERT INTO collie_artefacts (run, id, origin, data) VALUES (${run.id}, ${item.id}, ${ref}, ${data}) ON CONFLICT(run, origin) DO UPDATE SET data = excluded.data`;
              yield* sql`INSERT OR IGNORE INTO collie_artefact_revisions (run, id, revision, digest, size) VALUES (${run.id}, ${item.id}, ${revision}, ${digest}, ${size})`;
            }),
          )
          .pipe(Effect.orDie);
        changed ||=
          prior === undefined ||
          prior.digest !== digest ||
          prior.sourceAvailability !== "available";
      }
    }
    if (changed) yield* notify(run.id);
    if (background) discoveryCursor.delete(run.id);
    return { items: yield* list(run.id) } satisfies ArtefactCollection;
  });
  const job = (run: RunFacts, item: Artefact) => ({
    key: `${run.id}:${item.id}`,
    observed: epochMs(item.observedAt),
    check: reconciling.withPermit(
      Effect.gen(function* () {
        const current = Option.getOrUndefined(
          Arr.findFirst(yield* list(run.id), (one) => one.id === item.id),
        );
        if (current === undefined) return true;
        return (yield* refreshRegistered(run, current)).sourceAvailability === "available";
      }),
    ),
  });
  const cached = (run: RunFacts) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return {
        items: Arr.map(yield* list(run.id), (item) =>
          item.tracking === "local" ? { ...item, ...refreshing.status(job(run, item), now) } : item,
        ),
      };
    });
  const schedule = (run: RunFacts) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const jobs = Arr.take(
        Arr.filter(
          Arr.map(
            Arr.filter(yield* list(run.id), (item) => item.tracking === "local"),
            (item) => job(run, item),
          ),
          (one) => refreshing.due(one, now),
        ),
        8,
      );
      yield* Effect.forEach(jobs, refreshing.refresh, { concurrency: 2, discard: true });
    });
  const pass = (runs: ReadonlyArray<RunFacts>) =>
    Effect.gen(function* () {
      const jobs = [];
      for (const run of runs) {
        jobs.push({
          key: `${run.id}:~discovery`,
          observed: 0,
          check: reconciling.withPermit(reconcile(run, true)).pipe(Effect.as(true)),
        });
        for (const item of yield* list(run.id))
          if (item.tracking === "local") jobs.push(job(run, item));
      }
      yield* refreshing.pass(jobs);
    });
  const read = Effect.fn("Artefacts.read")(function* (
    run: RunFacts,
    id: string,
    revision: number,
    offset: number,
  ): Effect.fn.Return<RunFile, HostRefused, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return yield* refused("Invalid artefact revision or offset");
    const rows = yield* sql<{
      digest: string;
      size: number;
    }>`SELECT digest, size FROM collie_artefact_revisions WHERE run = ${run.id} AND id = ${id} AND revision = ${revision}`.pipe(
      Effect.orDie,
    );
    const row = rows[0];
    if (row === undefined) return yield* refused("No retained artefact at that revision");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(blob(run, row.digest), { flag: "r" });
        yield* file.seek(BigInt(offset), "start");
        const part = yield* file.readAlloc(Math.max(0, Math.min(PART_BYTES, row.size - offset)));
        return {
          ref: `artefact:${id}:${revision}`,
          encoding: "base64" as const,
          content: Buffer.from(Option.getOrElse(part, () => new Uint8Array())).toString("base64"),
          size: row.size,
        };
      }),
    ).pipe(Effect.mapError((cause) => refused(String(cause))));
  });
  const seen = Effect.fn("Artefacts.seen")(function* (
    run: string,
    id: string,
    revision: number | null,
    request: string,
    actor: AuditLine["actor"],
  ) {
    const answer = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const asked = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.NullOr(Schema.Int)])),
          )([id, revision]).pipe(Effect.orDie);
          const receipts = yield* sql<{
            asked: string;
            data: string;
          }>`SELECT asked, data FROM collie_artefact_receipts WHERE run = ${run} AND request = ${request}`;
          const receipt = receipts[0];
          if (receipt !== undefined) {
            if (receipt.asked !== asked)
              return yield* new RequestConflict({
                request,
                reason: "This request already acknowledged a different artefact or revision",
              });
            return { item: yield* decode(receipt.data), fresh: false };
          }
          const item = Option.getOrUndefined(
            Arr.findFirst(yield* list(run), (one) => one.id === id),
          );
          if (item === undefined) return yield* refused("No such artefact");
          if (
            revision !== null &&
            (!Number.isSafeInteger(revision) || revision < 1 || revision > item.revision)
          )
            return yield* refused("No such artefact revision");
          const at = yield* nowIso;
          const next = {
            ...item,
            seen:
              revision === null
                ? null
                : item.seen !== null && item.seen.revision >= revision
                  ? item.seen
                  : { revision, at },
          };
          yield* put(next);
          const data = yield* encode(next);
          const by = yield* Schema.encodeEffect(Schema.fromJsonString(AuditLine.fields.actor))(
            actor,
          ).pipe(Effect.orDie);
          yield* sql`INSERT INTO collie_artefact_receipts (run, request, asked, data, actor, at) VALUES (${run}, ${request}, ${asked}, ${data}, ${by}, ${at})`;
          return { item: next, fresh: true };
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));
    if (answer.fresh) yield* notify(run);
    return answer;
  });
  return {
    list,
    cached,
    schedule,
    pass,
    reconcile: (run: RunFacts) => reconciling.withPermit(reconcile(run)),
    read,
    seen: (...args: Parameters<typeof seen>) => reconciling.withPermit(seen(...args)),
    register: (...args: Parameters<typeof register>) => reconciling.withPermit(register(...args)),
  };
});

export class Artefacts extends Context.Service<Artefacts, Effect.Success<typeof make>>()(
  "collie/Artefacts",
) {}
export const artefactsLayer = Layer.effect(Artefacts)(make);
