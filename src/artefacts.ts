import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { Artefact, type ArtefactCollection } from "./artefact-model";
import { ATTACHMENT_BYTES, mediaTypeOf, sha256Hex } from "./attachments";
import { HostRefused, PART_BYTES, RequestConflict, type RunFile } from "./board-model";
import { AuditLine } from "./audit";
import type { RunFacts } from "./runs";
import { nowIso } from "./time";
import { StoreWrites } from "./store-writes";

const json = Schema.fromJsonString(Artefact);
const decode = (data: string) => Schema.decodeEffect(json)(data).pipe(Effect.orDie);
const encode = (item: Artefact) => Schema.encodeEffect(json)(item).pipe(Effect.orDie);
const refused = (reason: string) => new HostRefused({ reason });
const blob = (run: RunFacts, digest: string) => `${run.dir}/.artefacts/${digest}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reconciling = yield* Semaphore.make(1);
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
  const reconcile = Effect.fn("Artefacts.reconcile")(function* (run: RunFacts) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    let changed = false;
    const observedAt = yield* nowIso;
    const existing = yield* list(run.id);
    const origins = new Map(Arr.map(existing, (item) => [item.ref, item]));
    for (const [prefix, root, role] of [
      ["attachment", `${run.dir}/attachments`, "input"],
      ["plan", `${run.dir}/plan`, "plan"],
      ["evidence", run.evidence, "evidence"],
      ["handoff", `${run.dir}/handoffs`, "handoff"],
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
    return { items: yield* list(run.id) } satisfies ArtefactCollection;
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
    reconcile: (run: RunFacts) => reconciling.withPermit(reconcile(run)),
    read,
    seen: (...args: Parameters<typeof seen>) => reconciling.withPermit(seen(...args)),
  };
});

export class Artefacts extends Context.Service<Artefacts, Effect.Success<typeof make>>()(
  "collie/Artefacts",
) {}
export const artefactsLayer = Layer.effect(Artefacts)(make);
