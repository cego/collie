import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Schedule,
  Struct,
  type Types,
} from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as SecureRandom from "effect/crypto/SecureRandom";
import {
  Artefact,
  type ArtefactCollection,
  type ArtefactMatches,
  type ArtefactSearch,
  RegisterArtefact,
} from "./artefact-model";
import { ATTACHMENT_BYTES, mediaTypeOf, sha256Hex } from "./attachments";
import { HostRefused, PART_BYTES, RequestConflict, type RunFile } from "./board-model";
import { AuditLine } from "./audit";
import type { RunFacts } from "./runs";
import { epochMs, isoAt, nowIso } from "./time";
import type { PlatformError } from "effect/PlatformError";
import { StoreWrites } from "./store-writes";
import { refreshJobs } from "./artefact-refresh";
import { narrativeReports } from "./narrative-reports";

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
const ASKED = Schema.fromJsonString(RegisterArtefact);
const JSON_TEXT = Schema.fromJsonString(Schema.Json);
const blob = (run: RunFacts, digest: string) => `${run.dir}/.artefacts/${digest}`;

/** A verified provider read refused; each state stays distinct from the others and from "untracked". */
export class ObservationFailed extends Data.TaggedError("ObservationFailed")<{
  readonly state: "unsupported" | "auth-expired" | "denied" | "missing";
  readonly reason: string;
}> {}
export interface ProviderRead {
  readonly version: string | null;
  readonly url: string | null;
  readonly created: string | null;
  readonly updated: string | null;
}
export type ProviderReader = (resource: {
  readonly namespace: string | null;
  readonly resource: string | null;
  readonly url: string | null;
}) => Effect.Effect<ProviderRead, ObservationFailed>;
/** Verified readers by provider name. None ships: without one a provider's updates are untracked. */
export class ProviderReaders extends Context.Service<
  ProviderReaders,
  ReadonlyMap<string, ProviderReader>
>()("collie/ProviderReaders") {}
const OBSERVATION_TIMEOUT = "5 seconds";

const KIND = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const METADATA_BYTES = 16 * 1024;
const safeUrl = (url: string) =>
  url.length <= 8192 &&
  !/[\s\x00-\x1f]/.test(url) &&
  URL.canParse(url) &&
  /^https?:$/.test(new URL(url).protocol) &&
  new URL(url).hostname !== "";
const sourceDate = (at: string | undefined) =>
  at === undefined || !ISO.test(at) || Number.isNaN(epochMs(at)) ? undefined : isoAt(epochMs(at));
/** Why `input` cannot be registered, checked before anything is read or written. */
const invalid = (input: RegisterArtefact): string | undefined => {
  const provider = input.provider;
  if (
    input.path === undefined &&
    input.url === undefined &&
    provider?.resource === undefined &&
    input.id === undefined
  )
    return "Registration needs a path, a URL or a provider resource";
  if (input.url !== undefined && !safeUrl(input.url))
    return "A registered URL must be an http or https address without spaces or control characters";
  if (input.kind !== undefined && !KIND.test(input.kind))
    return "A kind is up to 128 letters, digits and . _ : / -";
  if (provider !== undefined && !KIND.test(provider.name))
    return "A provider name is up to 128 letters, digits and . _ : / -";
  if (
    Arr.some(
      [provider?.namespace, provider?.resource, provider?.version],
      (one) => one !== undefined && (one.length > 512 || /[\x00-\x1f]/.test(one)),
    )
  )
    return "A provider namespace, resource or version is up to 512 printable characters";
  if ((input.title?.length ?? 0) > 512 || (input.role?.length ?? 0) > 128)
    return "The title or role is too long";
  if ((input.description?.length ?? 0) > 4096) return "The description exceeds 4 KiB";
  if (
    input.metadata !== undefined &&
    new TextEncoder().encode(jsonText(input.metadata)).length > METADATA_BYTES
  )
    return "Extension metadata exceeds 16 KiB";
  for (const at of [input.created, input.updated])
    if (at !== undefined && sourceDate(at) === undefined)
      return `"${at}" is not an ISO timestamp with a time zone`;
  return undefined;
};
const reported = (at: string | undefined) => {
  const iso = sourceDate(at);
  return iso === undefined ? undefined : { at: iso, provenance: "caller-reported" };
};
type SourceDate = Artefact["created"];
/** A verified date stays; a report never stands in for one. */
const dated = (prior: SourceDate, next: SourceDate) =>
  prior?.provenance === "provider-verified" ? prior : (next ?? prior ?? null);
const isExternal = (item: Artefact) => item.url !== undefined || item.provider !== undefined;
type Fields<K extends keyof Artefact> = Types.Mutable<Partial<Pick<Artefact, K>>>;
const located = (url: string | undefined) => {
  const fields: Fields<"url" | "source"> = {};
  if (url !== undefined) {
    fields.url = url;
    fields.source = url;
  }
  return fields;
};
const jsonText = (value: Schema.Json | undefined) =>
  value === undefined ? "" : Option.getOrElse(Schema.encodeOption(JSON_TEXT)(value), () => "");

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
          if (item.digest !== "")
            yield* sql`INSERT OR IGNORE INTO collie_artefact_revisions (run, id, revision, digest, size) VALUES (${item.run}, ${item.id}, ${item.revision}, ${item.digest}, ${item.size})`;
        }),
      )
      .pipe(Effect.orDie);
  /** An external entry's export failing leaves its hosted source's state alone. */
  const failed = (prior: Artefact, error: CopyFailure) =>
    Effect.gen(function* () {
      const reason = reasonOf(error);
      const availability = availabilityOf(error);
      const item =
        prior.export === undefined
          ? { ...prior, observedAt: yield* nowIso, sourceAvailability: availability, reason }
          : { ...prior, export: { ...prior.export, availability }, reason };
      yield* put(item).pipe(Effect.orDie);
      if (
        (prior.export?.availability ?? prior.sourceAvailability) !== availability ||
        prior.reason !== reason
      )
        yield* notify(prior.run);
      return item;
    });
  const refreshCopy = Effect.fn("Artefacts.refreshCopy")(function* (
    run: RunFacts,
    prior: Artefact,
  ) {
    if (prior.tracking !== "local") return prior;
    const result = yield* copied(run, prior.export?.source ?? prior.source).pipe(Effect.result);
    if (result._tag === "Failure") return yield* failed(prior, result.failure);
    const at = yield* nowIso;
    const changed = result.success.digest !== prior.digest;
    const retained = Struct.omit(result.success, ["created", "updated"]);
    const item =
      prior.export === undefined
        ? {
            ...prior,
            ...result.success,
            observedAt: at,
            sourceAvailability: "available",
            reason: null,
          }
        : { ...prior, ...retained, export: { ...prior.export, availability: "available" } };
    const next = {
      ...item,
      revision: prior.revision + (changed ? 1 : 0),
      detectedAt: changed ? at : prior.detectedAt,
    };
    yield* save(next);
    if (changed || (prior.export?.availability ?? prior.sourceAvailability) !== "available")
      yield* notify(run.id);
    return next;
  });
  /** What a verified reader says of a provider resource; without a reader nothing is claimed. */
  const observe = Effect.fn("Artefacts.observe")(function* (prior: Artefact) {
    const provider = prior.provider;
    const reader =
      provider === undefined
        ? undefined
        : Option.getOrUndefined(yield* Effect.serviceOption(ProviderReaders))?.get(provider.name);
    if (provider === undefined || reader === undefined) return prior;
    const answer = yield* reader({
      namespace: provider.namespace,
      resource: provider.resource,
      url: prior.url ?? null,
    }).pipe(Effect.timeout(OBSERVATION_TIMEOUT), Effect.result);
    const at = yield* nowIso;
    if (answer._tag === "Failure") {
      const failure = answer.failure;
      const item = {
        ...prior,
        observedAt: at,
        ...(failure._tag === "ObservationFailed"
          ? { sourceAvailability: failure.state, reason: failure.reason }
          : {
              sourceAvailability: "timeout",
              reason: `The provider did not answer within ${OBSERVATION_TIMEOUT}`,
            }),
      };
      yield* put(item).pipe(Effect.orDie);
      if (item.sourceAvailability !== prior.sourceAvailability) yield* notify(prior.run);
      return item;
    }
    const read = answer.success;
    const url = read.url !== null && safeUrl(read.url) ? read.url : prior.url;
    const verified = (value: string | null) => {
      const iso = sourceDate(value ?? undefined);
      return iso === undefined ? undefined : { at: iso, provenance: "provider-verified" };
    };
    const changed = url !== prior.url || read.version !== provider.version;
    const item: Artefact = {
      ...prior,
      ...located(url),
      provider: {
        ...provider,
        version: read.version,
        provenance: "provider-verified",
        observedAt: at,
      },
      created: verified(read.created) ?? prior.created ?? null,
      updated: verified(read.updated) ?? prior.updated ?? null,
      observedAt: at,
      sourceAvailability: "available",
      reason: null,
      revision: prior.revision + (changed ? 1 : 0),
      detectedAt: changed ? at : prior.detectedAt,
    };
    yield* save(item);
    if (changed || prior.sourceAvailability !== "available") yield* notify(prior.run);
    return item;
  });
  const refreshRegistered = (run: RunFacts, prior: Artefact) =>
    refreshCopy(run, prior).pipe(Effect.flatMap(observe));
  const register = Effect.fn("Artefacts.register")(function* (
    run: RunFacts,
    installation: string,
    input: RegisterArtefact,
    request: string,
    actor: AuditLine["actor"],
  ) {
    const path = yield* Path.Path;
    const wrong = invalid(input);
    if (wrong !== undefined) return yield* refused(wrong);
    if (
      input.path !== undefined &&
      (!path.isAbsolute(input.path) ||
        input.path.length > 8192 ||
        Arr.contains(Str.split(input.path, /[\\/]/), "..") ||
        /[\x00-\x1f]/.test(input.path))
    )
      return yield* refused(
        "Registration needs an absolute file path without traversal or control characters",
      );
    const asked = yield* Schema.encodeEffect(ASKED)(input).pipe(Effect.orDie);
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
    const items = yield* list(run.id);
    const named = Option.getOrUndefined(Arr.findFirst(items, (one) => one.id === input.id));
    if (input.id !== undefined && named === undefined) return yield* refused("No such artefact");
    // An update by id keeps each locator it does not replace.
    const given = input.path ?? named?.export?.source;
    const file = given ?? (named === undefined || isExternal(named) ? undefined : named.source);
    const source = file === undefined ? undefined : path.normalize(file);
    const url = input.url ?? named?.url;
    const at = yield* nowIso;
    const provider =
      input.provider === undefined
        ? named?.provider
        : {
            name: input.provider.name,
            namespace: input.provider.namespace ?? null,
            resource: input.provider.resource ?? null,
            version: input.provider.version ?? null,
            provenance: "caller-reported",
            observedAt: at,
          };
    const external = url !== undefined || provider !== undefined;
    const ref =
      named !== undefined &&
      source === (named.export?.source ?? named.source) &&
      url === named.url &&
      provider === named.provider
        ? named.ref
        : provider?.resource != null
          ? `provider:${Arr.join(
              Arr.map(
                [provider.name, provider.namespace ?? "", provider.resource],
                encodeURIComponent,
              ),
              ":",
            )}`
          : url !== undefined
            ? `url:${url}`
            : `registered:${source}`;
    const prior = named ?? Option.getOrUndefined(Arr.findFirst(items, (one) => one.ref === ref));
    if (Arr.some(items, (one) => one.ref === ref && prior !== undefined && one.id !== prior.id))
      return yield* refused("This source already belongs to another artefact");
    const observed =
      source === undefined
        ? undefined
        : yield* copied(run, source).pipe(
            Effect.tapError((error) => (prior === undefined ? Effect.void : failed(prior, error))),
            Effect.mapError((error) => refused(reasonOf(error))),
          );
    const metadata = input.metadata ?? prior?.metadata;
    const unchanged =
      prior !== undefined &&
      prior.ref === ref &&
      prior.digest === (observed?.digest ?? "") &&
      (prior.export?.source ?? (isExternal(prior) ? undefined : prior.source)) === source &&
      prior.url === url &&
      prior.provider?.version === provider?.version &&
      jsonText(prior.metadata) === jsonText(metadata);
    const revision = prior === undefined ? 1 : prior.revision + (unchanged ? 0 : 1);
    const description = input.description ?? prior?.description;
    const tracking = input.snapshot === true ? ("snapshot" as const) : ("local" as const);
    const common = {
      installation,
      id: prior?.id ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4()),
      run: run.id,
      ref,
      role: input.role ?? prior?.role ?? "deliverable",
      revision,
      registeredAt: prior?.registeredAt ?? at,
      observedAt: at,
      detectedAt: prior?.revision === revision ? prior.detectedAt : at,
      seen: prior?.seen ?? null,
      reason: null,
      registeredBy: prior?.registeredBy ?? actor,
    };
    const described: Fields<"description" | "metadata"> = {};
    if (description !== undefined) described.description = description;
    if (metadata !== undefined) described.metadata = metadata;
    const hosted: Fields<"url" | "provider" | "export" | "tracking"> = {};
    if (url !== undefined) hosted.url = url;
    if (provider !== undefined) hosted.provider = provider;
    if (source !== undefined) {
      hosted.export = { source, availability: "available" };
      hosted.tracking = tracking;
    }
    const item: Artefact = external
      ? {
          ...common,
          ...described,
          ...hosted,
          kind: input.kind ?? prior?.kind ?? "link",
          title:
            input.title ??
            prior?.title ??
            url ??
            Str.trim(`${provider?.name} ${provider?.resource ?? ""}`),
          source: url ?? `${provider?.name}/${provider?.resource ?? ""}`,
          mediaType: source === undefined ? "" : mediaTypeOf(source),
          size: observed?.size ?? 0,
          digest: observed?.digest ?? "",
          created: dated(prior?.created, reported(input.created)),
          updated: dated(prior?.updated, reported(input.updated)),
          sourceAvailability: "untracked",
          retainedAvailability: observed === undefined ? "none" : "available",
        }
      : {
          ...common,
          ...described,
          ...observed!,
          created: observed!.created ?? reported(input.created) ?? null,
          updated: observed!.updated ?? reported(input.updated) ?? null,
          source: source!,
          kind: input.kind ?? prior?.kind ?? "file",
          title: input.title ?? prior?.title ?? path.basename(source!),
          mediaType: mediaTypeOf(source!),
          sourceAvailability: "available",
          retainedAvailability: "available",
          tracking,
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
  const narratives = yield* narrativeReports(
    (run, installation, input, request, actor, original) =>
      register(run, installation, input, request, actor).pipe(
        Effect.flatMap((receipt) =>
          Effect.gen(function* () {
            const item = {
              ...receipt.item,
              created: original === null ? null : { at: original, provenance: "source-event" },
              updated: null,
            };
            yield* save(item);
            return { ...receipt, item };
          }),
        ),
      ),
    notify,
  );
  const reconcile = Effect.fn("Artefacts.reconcile")(function* (run: RunFacts, background = false) {
    yield* narratives.reconcile(run, background ? 8 : Number.POSITIVE_INFINITY);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const observedAt = yield* nowIso;
    const existing = yield* list(run.id);
    const origins = new Map(Arr.map(existing, (item) => [item.ref, item]));
    if (!background)
      for (const item of existing)
        if (item.tracking === "local" || item.provider !== undefined)
          yield* refreshRegistered(run, item);
    let remaining = background ? 8 : Number.POSITIVE_INFINITY;
    const cursor = background
      ? ((yield* sql<{
          cursor: string;
        }>`SELECT cursor FROM collie_artefact_index WHERE run = ${run.id}`.pipe(Effect.orDie))[0]
          ?.cursor ?? "")
      : "";
    for (const [prefix, root, role] of [
      // Sorted by prefix: the background cursor compares whole refs.
      ["attachment", `${run.dir}/attachments`, "input"],
      ["evidence", run.evidence, "evidence"],
      ["handoff", `${run.dir}/handoffs`, "handoff"],
      ["plan", `${run.dir}/plan`, "plan"],
    ] as const) {
      const listing = yield* fs.readDirectory(root, { recursive: true }).pipe(Effect.result);
      if (listing._tag === "Failure" && listing.failure.reason._tag !== "NotFound")
        return { items: yield* list(run.id) } satisfies ArtefactCollection;
      const names = listing._tag === "Success" ? listing.success : [];
      const known = Arr.map(
        Arr.filter(existing, (item) => Str.startsWith(`${prefix}:`)(item.ref)),
        (item) => Str.slice(prefix.length + 1)(item.ref),
      );
      for (const name of [...new Set([...names, ...known])].sort()) {
        const ref = `${prefix}:${name}`;
        if (background && ref <= cursor) continue;
        if (remaining-- <= 0) {
          return { items: yield* list(run.id) } satisfies ArtefactCollection;
        }
        yield* Effect.gen(function* () {
          const prior = origins.get(ref);
          if (
            Arr.some(
              Str.split(name, /[\\/]/),
              (part) =>
                Str.startsWith(".")(part) ||
                /^(?:credentials?|secrets?|settings)(?:\.|$)/i.test(part),
            )
          )
            return;
          if (
            prefix === "evidence" &&
            /(?:^|\/)(?:approved\.json|(?:verifications|metrics|measurements)\.jsonl)$/.test(name)
          )
            return;
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
              if (
                prior.sourceAvailability !== item.sourceAvailability ||
                prior.reason !== item.reason
              )
                yield* notify(run.id);
            }
            return;
          }
          if (observed.success === null) {
            if (prior !== undefined) {
              yield* put({
                ...prior,
                observedAt,
                sourceAvailability: "unsupported",
                reason: "The source is no longer a regular file",
              }).pipe(Effect.orDie);
              if (prior.sourceAvailability !== "unsupported") yield* notify(run.id);
            }
            return;
          }
          const { digest, size, updated } = observed.success;
          const revision =
            prior === undefined ? 1 : prior.revision + (prior.digest === digest ? 0 : 1);
          const item: Artefact = {
            ...prior,
            id: prior?.id ?? (yield* random.uuidV4()),
            run: run.id,
            kind: prior?.kind ?? "file",
            role: prior?.role ?? role,
            title: prior?.title ?? name,
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
          if (
            prior === undefined ||
            prior.digest !== digest ||
            prior.sourceAvailability !== "available"
          )
            yield* notify(run.id);
        });
        if (background)
          yield* sql`INSERT INTO collie_artefact_index (run, cursor, done) VALUES (${run.id}, ${ref}, 0) ON CONFLICT(run) DO UPDATE SET cursor = excluded.cursor`.pipe(
            Effect.orDie,
          );
      }
    }
    yield* sql`INSERT INTO collie_artefact_index (run, cursor, done) VALUES (${run.id}, '', 1) ON CONFLICT(run) DO UPDATE SET cursor = '', done = 1`.pipe(
      Effect.orDie,
    );
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
        const next = yield* refreshRegistered(run, current);
        return (next.export?.availability ?? next.sourceAvailability) === "available";
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
  /** A page of this host's catalogue, from its metadata alone; no file is read. */
  const search = Effect.fn("Artefacts.search")(function* (
    asked: ArtefactSearch,
    eligible: ReadonlyArray<string>,
  ) {
    const limit = Math.min(Math.max(asked.limit ?? 50, 1), 200);
    const runs =
      asked.run === undefined ? eligible : Arr.filter(eligible, (run) => run === asked.run);
    const query = asked.query === undefined ? "" : Str.trim(asked.query);
    const field = (name: string) =>
      sql.literal(`lower(coalesce(json_extract(data, '$.${name}'), ''))`);
    const where = [
      runs.length === 0 ? sql`0` : sql`run IN ${sql.in(runs)}`,
      query === ""
        ? sql`1`
        : sql.or(
            Arr.map(
              ["title", "description", "url", "source", "export.source"],
              (name) => sql`instr(${field(name)}, lower(${query})) > 0`,
            ),
          ),
      asked.run === undefined ? sql`1` : sql`run = ${asked.run}`,
      asked.kind === undefined ? sql`1` : sql`json_extract(data, '$.kind') = ${asked.kind}`,
      asked.role === undefined ? sql`1` : sql`json_extract(data, '$.role') = ${asked.role}`,
      asked.unseen === true
        ? sql`coalesce(json_extract(data, '$.seen.revision'), 0) < json_extract(data, '$.revision')`
        : sql`1`,
      asked.after === undefined
        ? sql`1`
        : sql`(json_extract(data, '$.detectedAt') < ${asked.after.detectedAt} OR (json_extract(data, '$.detectedAt') = ${asked.after.detectedAt} AND (run > ${asked.after.run} OR (run = ${asked.after.run} AND id > ${asked.after.id}))))`,
    ];
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM collie_artefacts WHERE ${sql.and(where)} ORDER BY json_extract(data, '$.detectedAt') DESC, run, id LIMIT ${limit + 1}`.pipe(
      Effect.orDie,
    );
    const done = new Set(
      Arr.map(
        yield* sql<{
          run: string;
        }>`SELECT run FROM collie_artefact_index WHERE done = 1`.pipe(Effect.orDie),
        (row) => row.run,
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      items: yield* Effect.forEach(Arr.take(rows, limit), (row) =>
        decode(row.data).pipe(
          Effect.map((item) =>
            item.tracking === "local"
              ? {
                  ...item,
                  ...refreshing.status(
                    { key: `${item.run}:${item.id}`, observed: epochMs(item.observedAt) },
                    now,
                  ),
                }
              : item,
          ),
        ),
      ),
      more: rows.length > limit,
      coverage: {
        runs: runs.length,
        indexed: Arr.filter(runs, (run) => done.has(run)).length,
      },
    } satisfies ArtefactMatches;
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
  let indexing = false;
  let indexedThrough = "";
  /** Reaches a few Runs the catalogue has not yet, at most one round at a time. */
  const index = (runs: ReadonlyArray<RunFacts>) =>
    Effect.suspend(() => {
      if (indexing) return Effect.void;
      indexing = true;
      return indexRound(runs).pipe(Effect.ensuring(Effect.sync(() => (indexing = false))));
    });
  const indexRound = (runs: ReadonlyArray<RunFacts>) =>
    Effect.gen(function* () {
      const done = new Set(
        Arr.map(
          yield* sql<{
            run: string;
          }>`SELECT run FROM collie_artefact_index WHERE done = 1`.pipe(Effect.orDie),
          (row) => row.run,
        ),
      );
      const waiting = Arr.filter(runs, (run) => !done.has(run.id)).sort((a, b) =>
        Str.localeCompare(b.id)(a.id),
      );
      const round = Arr.take(
        [
          ...Arr.filter(waiting, (run) => run.id > indexedThrough),
          ...Arr.filter(waiting, (run) => run.id <= indexedThrough),
        ],
        4,
      );
      indexedThrough = round.at(-1)?.id ?? indexedThrough;
      yield* Effect.forEach(
        round,
        (run) =>
          reconciling.withPermit(reconcile(run, true)).pipe(Effect.timeoutOption("5 seconds")),
        { discard: true, concurrency: 2 },
      );
    });
  return {
    reports: narratives.reports,
    prepareReports: (run: RunFacts) => reconciling.withPermit(narratives.reconcile(run, 8)),
    list,
    cached,
    index,
    schedule,
    pass,
    search,
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
