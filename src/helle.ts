// Helle — the team's "who holds this project" service — as Collie's own client, and
// the gate a Step declares with `waits: helle`.
//
// Helle ships an MCP server and a REST API, and no client CLI. The wait has to happen
// in the runner, before any agent starts, or a queue of hours is a queue of hours of
// model tokens. So this is four endpoints over `/api/v1`, with the bearer credentials
// read from the same environment file the MCP wrapper sources.

import { Data, Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { reason } from "./naming";

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
const Member = Schema.Struct({ user_id: Schema.String });
const Project = Schema.Struct({
  slug: Schema.String,
  group: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  const url = values.get("HELLE_API_URL");
  const token = values.get("HELLE_API_TOKEN");
  if (!url) return yield* Effect.fail(failed(`helle credentials: no HELLE_API_URL in ${file}`));
  if (!token) return yield* Effect.fail(failed(`helle credentials: no HELLE_API_TOKEN in ${file}`));
  return { url: url.replace(/\/+$/, ""), token } satisfies HelleCredentials;
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

/**
 * Which Helle project a repository is. `group` is the GitLab group path and `slug` is
 * normally the repository name, so `<group>/<slug>` is the tail of the project's own
 * GitLab path; a project Helle lists without a group can only be matched by name.
 * Group case is Helle's own typing (`Players` and `players` are both in there) and
 * never decides a match.
 */
export function resolveProject(
  projects: readonly HelleProject[],
  gitlabPath: string | null,
  repoName: string,
): Resolution {
  const path = gitlabPath?.toLowerCase() ?? "";
  const byGroup = projects.filter(
    (p) => p.group && path.endsWith(`/${p.group.toLowerCase()}/${p.slug.toLowerCase()}`),
  );
  const matched = byGroup.length > 0 ? byGroup : projects.filter((p) => p.slug === repoName);
  if (matched.length === 1) return { _tag: "Project", slug: matched[0]!.slug };
  if (matched.length === 0) return { _tag: "None" };
  return { _tag: "Ambiguous", slugs: matched.map((p) => p.slug) };
}

/** Where this user stands: 0 while they hold it, else their place in the queue. */
function positionOf(project: HelleProject, user: string): number | null {
  if (project.holder?.user_id === user) return 0;
  const at = (project.queue ?? []).findIndex((member) => member.user_id === user);
  return at < 0 ? null : at + 1;
}

export interface HelleGate<E, R> {
  home: string;
  envFile?: string | null;
  /** `host/group/…/name` for the repository, or null where it has no GitLab remote. */
  gitlabPath: string | null;
  repoName: string;
  /** What this Run already recorded, which is what makes it a resume rather than a start. */
  claimed: HelleClaim | null;
  record: (claim: HelleClaim) => Effect.Effect<void, E, R>;
  out: (line: string) => Effect.Effect<void, E, R>;
  ask: (question: string) => Effect.Effect<string | null, E, R>;
  pollMs?: number;
}

const AFFIRMATIVE = /^(y|yes)$/i;

/**
 * Blocks until this Run holds the repository's Helle project, and answers which one it
 * is — or null where the repository has no Helle project at all, which is not a reason
 * to stop. Everything else Helle can do to this — several matching projects, an
 * unreachable API, a rejected token — fails, because "we could not ask" and "there is
 * nothing to ask about" must never come out the same way.
 */
export const waitForHelle = Effect.fn("Helle.waitForHelle")(function* <E, R>(
  gate: HelleGate<E, R>,
) {
  const creds = yield* credentials(gate);
  const resolved = resolveProject(yield* helleProjects(creds), gate.gitlabPath, gate.repoName);
  if (resolved._tag === "Ambiguous") {
    return yield* Effect.fail(
      failed(
        `helle has ${resolved.slugs.length} projects matching ${gate.repoName}: ${resolved.slugs.join(", ")} — say which`,
      ),
    );
  }
  if (resolved._tag === "None") {
    yield* gate.out(`◦ no Helle project for ${gate.repoName} — carrying on without one`);
    return null;
  }
  const slug = resolved.slug;
  const me = yield* helleMe(creds);

  // Claimed on every entry, resume included: an idempotent claim is the only way back
  // into a queue this Run may have fallen out of while it was not running.
  const claimed = yield* claimProject(creds, slug);
  if (claimed.already_queued && gate.claimed === null) {
    const answer = yield* gate.ask(
      `You already hold or are queued for the Helle project ${slug}. Take that claim over, and release it when the Run is done? [y/N]`,
    );
    if (answer === null || !AFFIRMATIVE.test(answer.trim())) {
      return yield* Effect.fail(
        failed(`the Helle claim on ${slug} was already yours and was not taken over`),
      );
    }
    yield* gate.record({ slug, claim: "adopted" });
  } else if (gate.claimed === null) {
    yield* gate.record({ slug, claim: "mine" });
  }

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
    if (position === 0) return { slug };
    yield* Effect.sleep(gate.pollMs ?? POLL_MS);
    // A queue this Run is no longer in is not a turn it has taken: it keeps the last
    // position it knew rather than reporting a place it does not have.
    position = positionOf(yield* helleProject(creds, slug), me.user_id) ?? position;
  }
});
