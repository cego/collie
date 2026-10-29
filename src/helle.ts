// Helle — the team's "who holds this project" service — as Collie's own client, and
// the gate a Step declares with `waits: helle`.
//
// Helle ships an MCP server and a REST API, and no client CLI. The wait has to happen
// in the runner, before any agent starts, or a queue of hours is a queue of hours of
// model tokens. So this is four endpoints over `/api/v1`, with the bearer credentials
// read from the same environment file the MCP wrapper sources.

import { Data, Effect, Exit, FileSystem, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HELLE_URL } from "./helle-url";

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class HelleError extends Data.TaggedError("HelleError")<{
  readonly message: string;
}> {}

const failed = (message: string) => new HelleError({ message });

/** One request. Helle is a small internal service; nothing here is slow on purpose. */
const REQUEST_MS = 15_000;
/** How often the gate asks where it is in the queue. */
const POLL_MS = 30_000;

export interface HelleCredentials {
  url: string;
  token: string;
}

/** What a Run recorded about a claim, so a resumed one knows whose it was. */
export interface HelleClaim {
  slug: string;
  /** `mine` — the Run queued for it; `adopted` — it was the operator's and they said so. */
  claim: "mine" | "adopted";
}

/** The same, for a host that keeps it in a file of its own rather than in a Run record. */
export const HelleClaimSchema = Schema.Struct({
  slug: Schema.String,
  claim: Schema.Literals(["mine", "adopted"]),
});

const Me = Schema.Struct({ user_id: Schema.String });
const Member = Schema.Struct({
  user_id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
});
const Project = Schema.Struct({
  slug: Schema.String,
  group: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shorthand: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  holder: Schema.optionalKey(Schema.NullOr(Member)),
  queue: Schema.optionalKey(Schema.NullOr(Schema.Array(Member))),
});
const Projects = Schema.Array(Project);
const Claimed = Schema.Struct({ position: Schema.Number, already_queued: Schema.Boolean });

export interface HelleProject extends Schema.Schema.Type<typeof Project> {}

/**
 * The environment file the MCP wrapper sources, as `KEY=VALUE` lines. A file that is
 * not there, or one without a token, is a refusal: Collie must never mistake "Helle
 * could not be asked" for "this repository has no Helle project".
 */
export const credentials = Effect.fn("Helle.credentials")(function* (where: {
  home: string;
  envFile?: string | null;
  url?: string | null;
}) {
  const file = where.envFile ?? `${where.home}/.config/helle/env`;
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError(() => failed(`helle credentials: cannot read ${file}`)));
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const entry = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (entry) values.set(entry[1]!, entry[2]!.replace(/^["']|["']$/g, ""));
  }
  const token = values.get("HELLE_API_TOKEN");
  if (!token) return yield* Effect.fail(failed(`helle credentials: no HELLE_API_TOKEN in ${file}`));
  return { url: where.url ?? HELLE_URL, token } satisfies HelleCredentials;
});

/**
 * One call, decoded. Every non-2xx is a failure carrying the status, because the whole
 * point of this client is that a Helle which cannot answer stops the Run.
 */
const call = Effect.fn("Helle.call")(function* <S extends Schema.Top>(
  creds: HelleCredentials,
  method: "GET" | "POST",
  path: string,
  schema: S,
) {
  const what = `helle ${method} ${path}`;
  const url = `${creds.url}/api/v1${path}`;
  const request = (
    method === "POST"
      ? HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe({}))
      : HttpClientRequest.get(url)
  ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${creds.token}`));
  const response = yield* HttpClient.execute(request).pipe(
    Effect.timeout(REQUEST_MS),
    Effect.mapError((cause) =>
      cause._tag === "TimeoutError"
        ? failed(`${what} was not answered within ${REQUEST_MS}ms`)
        : failed(`${what}: ${reason(cause)}`),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    return yield* Effect.fail(failed(`${what} answered ${response.status}: ${body.slice(0, 200)}`));
  }
  const body = yield* response.json.pipe(Effect.mapError((c) => failed(`${what}: ${reason(c)}`)));
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((c) => failed(`${what}: ${String(c)}`)),
  );
}, Effect.provide(FetchHttpClient.layer));

/** The user this token is, which is what "the claim is ours" is judged against. */
export const helleMe = (creds: HelleCredentials) => call(creds, "GET", "/me", Me);

export const helleProjects = (creds: HelleCredentials) => call(creds, "GET", "/projects", Projects);

export const helleProject = (creds: HelleCredentials, slug: string) =>
  call(creds, "GET", `/projects/${slug}`, Project);

export const claimProject = (creds: HelleCredentials, slug: string) =>
  call(creds, "POST", `/projects/${slug}/claim`, Claimed);

export const releaseClaim = (creds: HelleCredentials, slug: string) =>
  call(creds, "POST", `/projects/${slug}/release`, Schema.Unknown);

export type Resolution =
  | { _tag: "Project"; slug: string }
  | { _tag: "None" }
  | { _tag: "Ambiguous"; slugs: string[] };

const answersTo = (project: HelleProject, name: string) =>
  [project.slug, ...(project.shorthand ?? [])].some(
    (one) => one.toLowerCase() === name.toLowerCase(),
  );

/**
 * Which Helle project a repository is. `group` is the repository's group or owner path and
 * the slug or a shorthand is normally the repository name, so `<group>/<name>` is the tail of
 * the repository's own path on its forge; a project Helle lists without a group can only be
 * matched by name — the last segment of that path where there is one, else the name the
 * caller gives.
 * Group case is Helle's own typing (`Players` and `players` are both in there) and
 * never decides a match.
 */
export function resolveProject(
  projects: readonly HelleProject[],
  repositoryPath: string | null,
  repoName: string,
): Resolution {
  const path = repositoryPath?.toLowerCase() ?? "";
  // The remote names the repository; the checkout's own clone may be named anything, and a
  // roaming Run's clone is named by a hash that no Helle project will ever be called.
  const name = repositoryPath?.split("/").pop() || repoName;
  const byGroup = projects.filter(
    (p) =>
      p.group &&
      answersTo(p, name) &&
      path.endsWith(`/${p.group.toLowerCase()}/${name.toLowerCase()}`),
  );
  const matched = byGroup.length > 0 ? byGroup : projects.filter((p) => answersTo(p, name));
  if (matched.length === 1) return { _tag: "Project", slug: matched[0]!.slug };
  if (matched.length === 0) return { _tag: "None" };
  return { _tag: "Ambiguous", slugs: matched.map((p) => p.slug) };
}

export type Needed = { _tag: "Projects"; slugs: string[] } | { _tag: "Unresolved"; why: string };

/** What a release deploys, which is what decides the Helle projects it needs. */
export interface Deploys {
  repositoryPath: string | null;
  repoName: string;
  /** The applications it deploys, by the name their deploy jobs give it. */
  applications: readonly string[];
  jobs: readonly string[];
  /** The repository's own `.collie/helle.json`, which is the whole answer where it is there. */
  declared: readonly string[] | null;
}

/** The path's first segment is the forge's host, which no Helle group names. */
const groupOf = (repositoryPath: string | null) =>
  repositoryPath?.toLowerCase().split("/").slice(1, -1).join("/") ?? null;

const inGroupOf = (projects: readonly HelleProject[], repositoryPath: string | null) => {
  const group = groupOf(repositoryPath);
  return (name: string) =>
    projects.filter(
      (p) => group !== null && p.group?.toLowerCase() === group && answersTo(p, name),
    );
};

const partsOf = (job: string) => job.split(/[:/\s]+/);

const twice = (name: string, found: readonly HelleProject[]) =>
  `${name} names ${found.length} Helle projects: ${found.map((p) => p.slug).join(", ")}`;

/**
 * Every Helle project a release needs: the repository's own alone where it has one, else each
 * project of the repository's group that an application or a deploy job's name
 * (`stage:spilnu`) names, by slug or shorthand. Anything it cannot settle is `Unresolved`,
 * never an empty set.
 */
export function resolveProjects(projects: readonly HelleProject[], release: Deploys): Needed {
  if (release.declared !== null) {
    const slugs = new Set<string>();
    const unknown: string[] = [];
    for (const entry of release.declared) {
      const found = projects.filter((p) => answersTo(p, entry));
      if (found.length > 1)
        return { _tag: "Unresolved", why: `.collie/helle.json's ${twice(entry, found)}` };
      if (found.length === 0) unknown.push(entry);
      else slugs.add(found[0]!.slug);
    }
    return unknown.length > 0
      ? {
          _tag: "Unresolved",
          why: `.collie/helle.json names ${unknown.join(", ")}, which Helle does not know`,
        }
      : { _tag: "Projects", slugs: [...slugs].sort() };
  }
  const own = resolveProject(projects, release.repositoryPath, release.repoName);
  if (own._tag === "Ambiguous")
    return {
      _tag: "Unresolved",
      why: `helle has ${own.slugs.length} projects matching ${release.repoName}: ${own.slugs.join(", ")}`,
    };
  if (own._tag === "Project") return { _tag: "Projects", slugs: [own.slug] };
  const group = groupOf(release.repositoryPath);
  const inGroup = inGroupOf(projects, release.repositoryPath);
  const slugs = new Set<string>();
  for (const application of release.applications) {
    const found = inGroup(application);
    if (found.length > 1)
      return { _tag: "Unresolved", why: `the application ${twice(application, found)}` };
    if (found.length === 0)
      return {
        _tag: "Unresolved",
        why: `no Helle project in ${group ?? release.repoName}'s group for the application ${application}`,
      };
    slugs.add(found[0]!.slug);
  }
  for (const job of release.jobs)
    for (const part of partsOf(job)) {
      const found = inGroup(part);
      if (found.length > 1)
        return { _tag: "Unresolved", why: `the deploy job ${job}'s ${twice(part, found)}` };
      if (found.length === 1) slugs.add(found[0]!.slug);
    }
  if (slugs.size === 0)
    return {
      _tag: "Unresolved",
      why: `no Helle project for ${release.repoName}, its applications or its deploy jobs`,
    };
  return { _tag: "Projects", slugs: [...slugs].sort() };
}

/** Where this user stands: 0 while they hold it, else their place in the queue. */
function positionOf(project: HelleProject, user: string): number | null {
  if (project.holder?.user_id === user) return 0;
  const at = (project.queue ?? []).findIndex((member) => member.user_id === user);
  return at < 0 ? null : at + 1;
}

/** Who holds or queues for a project ahead of this user, by name; null where nobody else does. */
function holderOf(project: HelleProject, user: string): string | null {
  if (project.holder?.user_id === user) return null;
  const other = [project.holder, ...(project.queue ?? [])].find(
    (member) => member != null && member.user_id !== user,
  );
  return other ? (other.display_name ?? other.user_id) : null;
}

/** Where the Helle projects a Run needs are resolved from. */
export interface HelleWhere {
  home: string;
  envFile?: string | null;
  url?: string | null;
  /** `host/group/…/name` for the repository, or null where it has no remote on a forge. */
  repositoryPath: string | null;
  repoName: string;
  /** What a release deploys; null where only the repository's own project is needed. */
  deploys: Pick<Deploys, "applications" | "jobs"> | null;
  declared: readonly string[] | null;
}

const neededOf = Effect.fn("Helle.neededOf")(function* (
  projects: readonly HelleProject[],
  where: HelleWhere,
) {
  if (where.deploys !== null || where.declared !== null)
    return resolveProjects(projects, {
      repositoryPath: where.repositoryPath,
      repoName: where.repoName,
      applications: where.deploys?.applications ?? [],
      jobs: where.deploys?.jobs ?? [],
      declared: where.declared,
    });
  const resolved = resolveProject(projects, where.repositoryPath, where.repoName);
  if (resolved._tag === "Ambiguous")
    return yield* Effect.fail(
      failed(
        `helle has ${resolved.slugs.length} projects matching ${where.repoName}: ${resolved.slugs.join(", ")} — say which`,
      ),
    );
  return resolved._tag === "Project"
    ? ({ _tag: "Projects", slugs: [resolved.slug] } satisfies Needed)
    : ({ _tag: "Unresolved", why: `no Helle project for ${where.repoName}` } satisfies Needed);
});

export const HoldersSchema = Schema.Union([
  Schema.TaggedStruct("Read", {
    /** Each needed project, and who else holds or queues for it; null where it is free. */
    projects: Schema.Array(
      Schema.Struct({ slug: Schema.String, holder: Schema.NullOr(Schema.String) }),
    ),
    /** The projects each application needs before it may go on stage. */
    applications: Schema.Array(
      Schema.Struct({ name: Schema.String, needs: Schema.Array(Schema.String) }),
    ),
    /** The applications each deploy job's name names; none means it belongs to every one. */
    jobs: Schema.Array(
      Schema.Struct({ name: Schema.String, applications: Schema.Array(Schema.String) }),
    ),
  }),
  Schema.TaggedStruct("Unresolved", { why: Schema.String }),
]);
export type Holders = typeof HoldersSchema.Type;

/** Who holds each project `where` needs, read without joining any queue. */
export const helleHolders = Effect.fn("Helle.holders")(function* (where: HelleWhere) {
  const creds = yield* credentials(where);
  const projects = yield* helleProjects(creds);
  const needed = yield* neededOf(projects, where);
  if (needed._tag === "Unresolved") return needed satisfies Holders;
  const me = yield* helleMe(creds);
  const read: { slug: string; holder: string | null }[] = [];
  for (const slug of needed.slugs)
    read.push({ slug, holder: holderOf(yield* helleProject(creds, slug), me.user_id) });
  const applications = where.deploys?.applications ?? [];
  const inGroup = inGroupOf(projects, where.repositoryPath);
  const names = (application: string, part: string) =>
    part.toLowerCase() === application.toLowerCase() ||
    inGroup(application).some((own) => answersTo(own, part));
  return {
    _tag: "Read",
    projects: read,
    applications: applications.map((name) => {
      const needs = resolveProjects(projects, {
        repositoryPath: where.repositoryPath,
        repoName: where.repoName,
        applications: [name],
        jobs: [],
        declared: where.declared,
      });
      return { name, needs: needs._tag === "Projects" ? needs.slugs : [] };
    }),
    jobs: (where.deploys?.jobs ?? []).map((name) => ({
      name,
      applications: applications.filter((application) =>
        partsOf(name).some((part) => names(application, part)),
      ),
    })),
  } satisfies Holders;
});

export interface HelleGate<E, R> extends HelleWhere {
  /** Takes only what nobody else holds or queues for, waits for none, and says what it left. */
  free?: boolean;
  /** What this Run already recorded, which is what makes it a resume rather than a start. */
  claimed: readonly HelleClaim[];
  record: (claim: HelleClaim) => Effect.Effect<void, E, R>;
  forget: (slug: string) => Effect.Effect<void, E, R>;
  out: (line: string) => Effect.Effect<void, E, R>;
  ask: (question: string) => Effect.Effect<string | null, E, R>;
  /** Told this Run's place in the queue on every read of it, while it is not the holder. */
  queued?: (slug: string, position: number) => Effect.Effect<void, E, R>;
  /** Told once the gate ends, however it ends, unless it is interrupted. */
  ended?: () => Effect.Effect<void, E, R>;
  pollMs?: number;
}

export type Held =
  | { _tag: "Held"; slugs: string[]; left?: { slug: string; holder: string }[] }
  | { _tag: "Unresolved"; why: string };

const AFFIRMATIVE = /^(y|yes)$/i;

/**
 * Blocks until this Run holds every Helle project it needs, and answers which — or why
 * they could not be settled, which only the caller may decide to carry on from. Helle
 * failing to answer, or several projects the repository could be without `deploys`,
 * fails: "we could not ask" and "there is nothing to ask about" never come out the same.
 * Projects are held one at a time in a fixed order, and never waited for while a later
 * one is held, so Runs needing overlapping sets cannot each hold what the other waits for.
 */
export const waitForHelle = <E, R>(gate: HelleGate<E, R>) =>
  gateOf(gate).pipe(
    Effect.onExit((exit) =>
      gate.ended === undefined || Exit.hasInterrupts(exit) ? Effect.void : gate.ended(),
    ),
  );

const gateOf = Effect.fn("Helle.waitForHelle")(function* <E, R>(gate: HelleGate<E, R>) {
  const creds = yield* credentials(gate);
  const projects = yield* helleProjects(creds);
  const needed = yield* neededOf(projects, gate);
  if (needed._tag === "Unresolved") return needed satisfies Held;
  const me = yield* helleMe(creds);
  const recorded = new Set(gate.claimed.map((one) => one.slug));
  let adopting: boolean | null = null;

  const takeOver = Effect.fn("Helle.takeOver")(function* (slug: string) {
    adopting ??= AFFIRMATIVE.test(
      (yield* gate.ask(
        `You already hold or are queued for the Helle project ${slug}. Take that claim over, and release it when the Run is done? [y/N]`,
      ))?.trim() ?? "",
    );
    if (!adopting) {
      return yield* Effect.fail(
        failed(`the Helle claim on ${slug} was already yours and was not taken over`),
      );
    }
    yield* gate.record({ slug, claim: "adopted" });
    recorded.add(slug);
  });

  if (gate.free) {
    const slugs: string[] = [];
    const left: { slug: string; holder: string }[] = [];
    for (const slug of needed.slugs) {
      const holder = holderOf(yield* helleProject(creds, slug), me.user_id);
      if (holder !== null) {
        left.push({ slug, holder });
        continue;
      }
      const claimed = yield* claimProject(creds, slug);
      if (claimed.already_queued && !recorded.has(slug)) yield* takeOver(slug);
      else if (!recorded.has(slug)) yield* gate.record({ slug, claim: "mine" });
      recorded.add(slug);
      if (claimed.position === 0) {
        yield* gate.out(`✓ this Run holds ${slug}`);
        slugs.push(slug);
        continue;
      }
      const taker = holderOf(yield* helleProject(creds, slug), me.user_id);
      yield* releaseClaim(creds, slug);
      yield* gate.forget(slug);
      recorded.delete(slug);
      left.push({ slug, holder: taker ?? "someone" });
    }
    return { _tag: "Held", slugs, left } satisfies Held;
  }

  const hold = Effect.fn("Helle.hold")(function* (slug: string) {
    // Claimed on every entry, resume included: an idempotent claim is the only way back
    // into a queue this Run may have fallen out of while it was not running.
    const claimed = yield* claimProject(creds, slug);
    if (claimed.already_queued && !recorded.has(slug)) {
      yield* takeOver(slug);
    } else if (!recorded.has(slug)) {
      yield* gate.record({ slug, claim: "mine" });
    }
    recorded.add(slug);

    let said: number | null = null;
    let position = claimed.position;
    while (true) {
      if (position !== said) {
        yield* gate.out(
          position === 0
            ? `✓ this Run holds ${slug}`
            : `⏳ waiting for ${slug} — position ${position}`,
        );
        said = position;
      }
      if (position === 0) return;
      if (gate.queued !== undefined) yield* gate.queued(slug, position);
      yield* Effect.sleep(gate.pollMs ?? POLL_MS);
      // A queue this Run is no longer in is not a turn it has taken: it keeps the last
      // position it knew rather than reporting a place it does not have.
      position = positionOf(yield* helleProject(creds, slug), me.user_id) ?? position;
    }
  });

  // A claim on a later project, the operator's own included, is given back before an earlier
  // one is waited for, whether this attempt is fresh, resumed or retried, or it lost the
  // earlier one while it waited.
  while (true) {
    const positions: (number | null)[] = [];
    for (const slug of needed.slugs)
      positions.push(positionOf(yield* helleProject(creds, slug), me.user_id));
    const from = needed.slugs.findIndex((slug, i) => !recorded.has(slug) || positions[i] !== 0);
    if (from < 0) break;
    const later = needed.slugs.filter((_, i) => i > from && positions[i] !== null);
    for (const slug of later) if (!recorded.has(slug)) yield* takeOver(slug);
    if (later.length > 0)
      yield* gate.out(
        `⚠ this Run does not hold ${needed.slugs[from]}, so it gives back ${later.join(", ")} to take them again in order`,
      );
    for (const slug of later) {
      yield* releaseClaim(creds, slug);
      yield* gate.forget(slug);
      recorded.delete(slug);
    }
    for (const slug of needed.slugs.slice(from)) yield* hold(slug);
  }
  return { _tag: "Held", slugs: needed.slugs } satisfies Held;
});
