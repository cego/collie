// A Release Run's checkout and its tag, stage and production, read from git and the forge.

import { Effect, Schema } from "effect";
import type { MrRef } from "./board-model";
import { forgeOf, forgeOfUrl, type DeployTier } from "./forge/forge";
import { whatItSaid, type Ran, type Runner } from "./mr";
import { appendLog } from "./oversight";

const short = (sha: string) => sha.slice(0, 8);

/** Where a fast-forward left the checkout, or why it left it alone. */
export const FastForwardSchema = Schema.Union([
  Schema.TaggedStruct("At", { head: Schema.String, from: Schema.String }),
  Schema.TaggedStruct("Refused", { why: Schema.String }),
]);
export type FastForward = typeof FastForwardSchema.Type;

/**
 * Fetches origin and fast-forwards the checkout at `cwd` to `head`, recording the move in
 * the Run's log. Uncommitted changes, or a head the checkout neither is at nor sits behind,
 * are refused: nothing is reset or discarded. The one refusal it does not make is a plain
 * push that moved the branch past a `head` the Run had journaled while it parked: where the
 * checkout already carries `head` and sits at origin's branch tip, it answers `At` on what
 * it actually holds, so a resumed Run re-proves the real head instead of parking on the
 * stale one.
 */
export const fastForward = Effect.fn("Releasing.fastForward")(function* <R>(opts: {
  readonly runDir: string;
  readonly cwd: string;
  readonly head: string;
  readonly run: Runner<R>;
}) {
  const git = (args: string[]) => opts.run("git", args, opts.cwd);
  const refused = (why: string): FastForward => ({ _tag: "Refused", why });
  const status = yield* git(["status", "--porcelain"]);
  const from = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  if (status.code !== 0 || from === "")
    return refused(`git could not read the checkout at ${opts.cwd}`);
  if (status.stdout.trim() !== "")
    return refused(
      `the checkout at ${opts.cwd} has uncommitted changes, so it is not taken as ${short(opts.head)}`,
    );
  if (from === opts.head) return { _tag: "At", head: opts.head, from } satisfies FastForward;
  yield* git(["fetch", "--quiet", "origin"]);
  if ((yield* git(["cat-file", "-e", `${opts.head}^{commit}`])).code !== 0)
    return refused(`origin does not have ${short(opts.head)}`);
  if ((yield* git(["merge-base", "--is-ancestor", from, opts.head])).code !== 0) {
    // The checkout is not behind `head`. Before refusing as a force push, tell
    // apart a plain push that moved the branch past `head` while the Run parked
    // from a true rewrite: where `head` is an ancestor of the checkout and the
    // checkout sits exactly at origin's branch tip, the Run's journal simply
    // holds a stale head, so answer `At` and let the next read see the real
    // head instead of parking on the same journaled head forever.
    const carries = (yield* git(["merge-base", "--is-ancestor", opts.head, from])).code === 0;
    const branch = (yield* git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const atOrigin =
      branch !== "" &&
      branch !== "HEAD" &&
      (yield* git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`])).stdout.trim() ===
        from;
    if (carries && atOrigin) {
      yield* appendLog(
        opts.runDir,
        `the checkout already carries ${short(opts.head)} and sits at ${short(from)}, where origin's ${branch} points`,
      );
      return { _tag: "At", head: from, from } satisfies FastForward;
    }
    return refused(
      `${short(opts.head)} does not fast-forward ${short(from)} in ${opts.cwd}, as after a force push`,
    );
  }
  const moved = yield* git(["merge", "--ff-only", "--quiet", opts.head]);
  if (moved.code !== 0)
    return refused(`git merge --ff-only ${short(opts.head)} failed: ${whatItSaid(moved)}`);
  yield* appendLog(opts.runDir, `moved the checkout from ${from} to ${opts.head}`);
  return { _tag: "At", head: opts.head, from } satisfies FastForward;
});

/** Which of `commits` `head` carries, once origin is fetched. */
export const carried = Effect.fn("Releasing.carried")(function* <R>(opts: {
  readonly cwd: string;
  readonly head: string;
  readonly commits: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const git = (args: string[]) => opts.run("git", args, opts.cwd);
  if (opts.commits.length > 0) yield* git(["fetch", "--quiet", "origin"]);
  const carries: string[] = [];
  for (const commit of opts.commits)
    if ((yield* git(["merge-base", "--is-ancestor", commit, opts.head])).code === 0)
      carries.push(commit);
  return carries;
});

/**
 * What a tag must be shown to be: `finished` is a package's, its pipeline succeeded;
 * `staged` is an application's, on stage and ready for production.
 */
export const TagProofSchema = Schema.Literals(["finished", "staged"]);

/** A job of a tag's pipeline, at the address the forge gives it. */
export const JobLinkSchema = Schema.Struct({ name: Schema.String, url: Schema.String });
export type JobLink = typeof JobLinkSchema.Type;

/**
 * A tag proved, with the production jobs waiting on it; already in production; failed on
 * stage after the merge; or what it lacks.
 */
export const TagReadSchema = Schema.Union([
  Schema.TaggedStruct("Proved", {
    production: Schema.Array(JobLinkSchema),
    /** The tag's object on origin, which a later read must find unchanged. */
    at: Schema.String,
  }),
  Schema.TaggedStruct("InProduction", {}),
  Schema.TaggedStruct("StageFailed", { why: Schema.String }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type TagRead = typeof TagReadSchema.Type;

/** Production already carries the merge, the jobs still to play, or why none may be. */
export const ProductionReadSchema = Schema.Union([
  Schema.TaggedStruct("Carried", {}),
  Schema.TaggedStruct("Play", { jobs: Schema.Array(JobLinkSchema) }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type ProductionRead = typeof ProductionReadSchema.Type;

/**
 * A merge request's head proved on stage, with its stage jobs and the stage environments it
 * proved; its head moved; or why not, with the stage environments its pipeline reached where
 * they could be read.
 */
export const StageReadSchema = Schema.Union([
  Schema.TaggedStruct("Staged", {
    jobs: Schema.Array(JobLinkSchema),
    environments: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("Moved", {
    head: Schema.String,
    environments: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.TaggedStruct("Failed", {
    why: Schema.String,
    environments: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);
export type StageRead = typeof StageReadSchema.Type;

/** Stage shown back on what production carries, or why not. */
export const RollbackReadSchema = Schema.Union([
  Schema.TaggedStruct("Shown", {}),
  Schema.TaggedStruct("Unshown", { why: Schema.String }),
]);
export type RollbackRead = typeof RollbackReadSchema.Type;

const failing = new Set(["failed", "cancelled"]);
const unfinished = new Set(["pending", "running"]);

/** Why a pipeline's jobs other than `production` have not all run and passed, or null. */
const unsettled = (
  jobs: ReadonlyArray<{ readonly name: string; readonly state: string }>,
  production: ReadonlyArray<string>,
  on: string,
) => {
  const others = jobs.filter((job) => !production.includes(job.name));
  const named = (states: Set<string>) =>
    others.filter((job) => states.has(job.state)).map((job) => `\`${job.name}\``);
  const failed = named(failing);
  if (failed.length > 0) return `${failed.join(", ")} failed ${on}`;
  const running = named(unfinished);
  if (running.length > 0) return `${running.join(", ")} has not finished ${on}`;
  const waiting = named(new Set(["manual"]));
  if (waiting.length > 0)
    return `${waiting.join(", ")} waits ${on} for somebody to start it, and is not a production job`;
  return null;
};

const gitOf =
  <R>(opts: { readonly cwd: string; readonly run: Runner<R> }) =>
  (args: string[]) =>
    opts.run("git", args, opts.cwd);

/** Whether `sha` carries `ancestor`, or null where git does not have one of them. */
const carries = <R>(
  git: (args: string[]) => Effect.Effect<Ran, never, R>,
  sha: string,
  ancestor: string,
) =>
  Effect.gen(function* () {
    for (const one of [sha, ancestor])
      if ((yield* git(["cat-file", "-e", `${one}^{commit}`])).code !== 0) return null;
    return (yield* git(["merge-base", "--is-ancestor", ancestor, sha])).code === 0;
  });

/** `tag` on origin carrying `merged`, with its object there and the commit it tags; or why not. */
const tagOn = <R>(
  git: (args: string[]) => Effect.Effect<Ran, never, R>,
  tag: string,
  merged: string,
) =>
  Effect.gen(function* () {
    const lacks = (why: string) => ({ ok: false, why }) as const;
    const ref = `refs/tags/${tag}`;
    const listed = yield* git(["ls-remote", "--tags", "origin", ref]);
    if (listed.code !== 0) return lacks(`origin could not be read: ${whatItSaid(listed)}`);
    const at = listed.stdout.trim().split(/\s+/)[0] ?? "";
    if (at === "") return lacks(`${tag} is not on origin`);
    yield* git(["fetch", "--quiet", "--force", "origin", `${ref}:${ref}`]);
    yield* git(["fetch", "--quiet", "origin"]);
    if ((yield* git(["merge-base", "--is-ancestor", merged, ref])).code !== 0)
      return lacks(`${tag} on origin does not carry the merged commit ${short(merged)}`);
    const commit = (yield* git(["rev-parse", `${ref}^{commit}`])).stdout.trim();
    return { ok: true, at, commit } as const;
  });

/** The pipeline at `url`, where the forge shows it ran for `tag` at `commit` in `ref`'s project. */
const tagsPipeline = <R>(opts: {
  readonly url: string;
  readonly ref: MrRef;
  readonly tag: string;
  readonly commit: string;
  readonly cwd: string;
  readonly run: Runner<R>;
}) =>
  Effect.gen(function* () {
    const not = (why: string) => ({ ok: false, why }) as const;
    const read = yield* forgeOfUrl(opts.url).pipeline(opts.url, opts.cwd, opts.run);
    if (!read.ok) return not(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
    if (read.project.toLowerCase() !== (opts.ref.project ?? "").toLowerCase())
      return not(`${opts.url} is a pipeline of ${read.project}, not of ${opts.ref.project}`);
    if (read.ref !== opts.tag) return not(`${opts.url} ran for ${read.ref}, not for ${opts.tag}`);
    if (read.sha !== opts.commit)
      return not(
        `${opts.url} ran on ${short(read.sha)}, not on ${short(opts.commit)}, which ${opts.tag} tags`,
      );
    return { ok: true, read } as const;
  });

/** What `tier` runs, by the commit its newest successful deployment has, or why not. */
const deployedOn = <R>(ref: MrRef, tier: DeployTier, cwd: string, run: Runner<R>) =>
  forgeOf(ref).deployed(ref, tier, cwd, run);

/** Whether production carries `merged`; null where the forge or git cannot say. */
const inProduction = <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly merged: string;
  readonly run: Runner<R>;
}) =>
  Effect.gen(function* () {
    const read = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
    if (!read.ok || read.sha === null) return false;
    return (yield* carries(gitOf(opts), read.sha, opts.merged)) === true;
  });

/**
 * Reads `tag` back: on origin and carrying `merged`, then against what it `proves`, on a
 * pipeline the forge shows ran for `tag` at its commit in `ref`'s project.
 * `finished`: `pipeline`, else the newest the tag started, if any, finished and succeeded by
 * the forge's word, and a job waiting to be started by hand has not finished. `staged`: production carrying `merged`
 * already is `InProduction`; otherwise, where `stage` names jobs, each passed and stage carries
 * `merged`, or else it is `StageFailed`; every other job passed and none is still running or waiting to run; and each
 * `production` job, at least one, waits on the pipeline to be started by hand. The
 * pipeline's own state is not read.
 */
export const readTag = Effect.fn("Releasing.readTag")(function* <R>(opts: {
  readonly cwd: string;
  readonly tag: string;
  readonly merged: string;
  readonly pipeline: string | null;
  readonly proves: typeof TagProofSchema.Type;
  readonly ref: MrRef | null;
  readonly stage: ReadonlyArray<string>;
  readonly production: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const git = gitOf(opts);
  const unproved = (why: string): TagRead => ({ _tag: "Unproved", why });
  const tagged = yield* tagOn(git, opts.tag, opts.merged);
  if (!tagged.ok) return unproved(tagged.why);
  if (opts.ref === null)
    return unproved("this Run recorded no merge request to read pipelines and deployments of");
  const ref = opts.ref;
  const pipelineAt = (url: string) =>
    tagsPipeline({ url, ref, tag: opts.tag, commit: tagged.commit, cwd: opts.cwd, run: opts.run });
  if (opts.proves === "finished") {
    let pipeline = opts.pipeline;
    if (pipeline === null) {
      const found = yield* forgeOf(ref).tagPipeline(ref, opts.tag, opts.cwd, opts.run);
      if (!found.ok)
        return unproved(`${opts.tag}'s pipelines could not be listed: ${found.reason}`);
      if (found.url === null)
        return { _tag: "Proved", production: [], at: tagged.at } satisfies TagRead;
      pipeline = found.url;
    }
    const tags = yield* pipelineAt(pipeline);
    if (!tags.ok) return unproved(tags.why);
    const read = tags.read;
    const manual = read.jobs
      .filter((job) => job.state === "manual")
      .map((job) => `\`${job.name}\``);
    if (manual.length > 0)
      return unproved(
        `${opts.tag}'s pipeline at ${pipeline} has not finished: ${manual.join(", ")} waits for somebody to start it by hand`,
      );
    if (!read.succeeded)
      return unproved(`${opts.tag}'s pipeline at ${pipeline} has not finished and succeeded`);
    return { _tag: "Proved", production: [], at: tagged.at } satisfies TagRead;
  }

  if (yield* inProduction({ ...opts, ref })) return { _tag: "InProduction" } satisfies TagRead;
  if (opts.pipeline === null)
    return unproved(`no pipeline of ${opts.tag} was named to prove stage from`);
  const pipeline = opts.pipeline;
  const tags = yield* pipelineAt(pipeline);
  if (!tags.ok) return unproved(tags.why);
  const read = tags.read;
  const on = `on ${opts.tag}'s pipeline at ${pipeline}`;
  const jobNamed = (name: string) => read.jobs.find((job) => job.name === name);
  if (opts.stage.length > 0) {
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job !== undefined && failing.has(job.state))
        return { _tag: "StageFailed", why: `\`${name}\` failed ${on}` } satisfies TagRead;
    }
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job === undefined) return unproved(`\`${name}\` is not a job ${on}`);
      if (job.state !== "passed")
        return unproved(`\`${name}\` has not passed ${on}: it is ${job.state}`);
    }
    const staging = yield* deployedOn(ref, "staging", opts.cwd, opts.run);
    if (!staging.ok) return unproved(`stage could not be read: ${staging.reason}`);
    const staged = staging.sha === null ? false : yield* carries(git, staging.sha, opts.merged);
    if (staged === null)
      return unproved(
        `stage's ${short(staging.sha ?? "")} could not be compared with the merged commit`,
      );
    if (!staged)
      return {
        _tag: "StageFailed",
        why: `stage does not carry the merged commit ${short(opts.merged)}`,
      } satisfies TagRead;
  }
  const settled = unsettled(read.jobs, opts.production, on);
  if (settled !== null) return unproved(settled);
  if (opts.production.length === 0) return unproved(`no production job ${on} was named`);
  const production: JobLink[] = [];
  for (const name of opts.production) {
    const job = jobNamed(name);
    if (job === undefined) return unproved(`\`${name}\` is not a job ${on}`);
    if (job.state !== "manual")
      return unproved(
        `\`${name}\` does not wait ${on} for somebody to start it: it is ${job.state}`,
      );
    production.push({ name, url: job.url ?? pipeline });
  }
  return { _tag: "Proved", production, at: tagged.at } satisfies TagRead;
});

/**
 * Reads, before production jobs are played, what is left to play: nothing where production
 * already carries `merged`, the `jobs` still waiting to be started by hand, and none at all
 * where the tag on origin is no longer `at` or no longer carries `merged`, a job is gone or failed, or any other job failed or
 * is still running or waiting to run.
 */
export const readProduction = Effect.fn("Releasing.readProduction")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly tag: string;
  /** The tag's object on origin when it was proved. */
  readonly at: string;
  readonly merged: string;
  readonly pipeline: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const unproved = (why: string): ProductionRead => ({ _tag: "Unproved", why });
  if (yield* inProduction(opts)) return { _tag: "Carried" } satisfies ProductionRead;
  const tagged = yield* tagOn(gitOf(opts), opts.tag, opts.merged);
  if (!tagged.ok) return unproved(tagged.why);
  if (tagged.at !== opts.at)
    return unproved(
      `${opts.tag} on origin moved since it was proved, from ${short(opts.at)} to ${short(tagged.at)}`,
    );
  const tags = yield* tagsPipeline({ ...opts, url: opts.pipeline, commit: tagged.commit });
  if (!tags.ok) return unproved(tags.why);
  const read = tags.read;
  const on = `on ${opts.tag}'s pipeline at ${opts.pipeline}`;
  const settled = unsettled(read.jobs, opts.jobs, on);
  if (settled !== null) return unproved(settled);
  const jobs: JobLink[] = [];
  for (const name of opts.jobs) {
    const job = read.jobs.find((one) => one.name === name);
    if (job === undefined) return unproved(`\`${name}\` is no longer a job ${on}`);
    if (failing.has(job.state)) return unproved(`\`${name}\` failed ${on}`);
    if (job.state === "manual") jobs.push({ name, url: job.url ?? opts.pipeline });
  }
  return { _tag: "Play", jobs } satisfies ProductionRead;
});

const named = (names: ReadonlyArray<string>) => names.map((one) => `\`${one}\``).join(", ");

/**
 * A merge request's head on stage: each of `jobs`, one at least, passed on the pipeline of its
 * head, and that head is `head`; at least one stage environment was deployed by those jobs
 * at that pipeline's commit; and every such environment's newest successful deployment carries `head`.
 */
export const readStage = Effect.fn("Releasing.readStage")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly head: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const failed = (why: string, environments?: ReadonlyArray<string>): StageRead =>
    environments === undefined ? { _tag: "Failed", why } : { _tag: "Failed", why, environments };
  if (opts.jobs.length === 0)
    return failed("no stage job of the merge request's pipeline was named");
  const on = `on the merge request's pipeline at ${short(opts.head)}`;
  const jobs: JobLink[] = [];
  let unpassed: string | null = null;
  let moved: string | null = null;
  let commit = opts.head;
  for (const name of opts.jobs) {
    const job = yield* forgeOf(opts.ref).job(opts.ref, name, opts.cwd, opts.run);
    if (!job.ok) {
      unpassed ??= `\`${name}\` could not be read: ${job.reason}`;
      continue;
    }
    if (job.head !== opts.head) {
      moved = job.head;
      continue;
    }
    if (job.merge !== null) commit = job.merge;
    if (job.state !== "passed") unpassed ??= `\`${name}\` has not passed ${on}: it is ${job.state}`;
    jobs.push({ name, url: job.url ?? "" });
  }
  const staging = yield* forgeOf(opts.ref).stagingEnvironments(
    opts.ref,
    commit,
    opts.cwd,
    opts.run,
    opts.jobs,
  );
  if (!staging.ok) return failed(unpassed ?? `stage could not be read: ${staging.reason}`);
  const reached = staging.environments.filter((env) => env.hasCommit);
  const environments = reached.map((env) => env.name);
  if (moved !== null) return { _tag: "Moved", head: moved, environments } satisfies StageRead;
  if (unpassed !== null) return failed(unpassed, environments);
  if (reached.length === 0)
    return failed(
      `stage does not carry ${short(opts.head)}: no stage environment has a deployment of ${short(commit)} by ${named(opts.jobs)}`,
      environments,
    );
  const uncarried: string[] = [];
  for (const env of reached) {
    if (env.live === opts.head || env.live === commit) continue;
    const staged = env.live === null ? false : yield* carries(gitOf(opts), env.live, opts.head);
    if (staged === null)
      return failed(
        `\`${env.name}\`'s ${short(env.live ?? "")} could not be compared with ${short(opts.head)}`,
        environments,
      );
    if (!staged) uncarried.push(env.name);
  }
  if (uncarried.length > 0)
    return failed(`stage does not carry ${short(opts.head)} in ${named(uncarried)}`, environments);
  return { _tag: "Staged", jobs, environments } satisfies StageRead;
});

/**
 * Whether stage is shown back on what production carries, and off each of `off`: in each of
 * `environments` by its newest successful deployment, or, where none are named, by stage's
 * newest successful deployment.
 */
export const readRollback = Effect.fn("Releasing.readRollback")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly off: ReadonlyArray<string>;
  readonly environments?: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const unshown = (why: string): RollbackRead => ({ _tag: "Unshown", why });
  const git = gitOf(opts);
  const lives: Array<{ readonly where: string; readonly live: string | null }> = [];
  if (opts.environments === undefined) {
    const staging = yield* deployedOn(opts.ref, "staging", opts.cwd, opts.run);
    if (!staging.ok) return unshown(`stage could not be read: ${staging.reason}`);
    lives.push({ where: "", live: staging.sha });
  } else if (opts.environments.length > 0) {
    const staging = yield* forgeOf(opts.ref).stagingEnvironments(
      opts.ref,
      null,
      opts.cwd,
      opts.run,
    );
    if (!staging.ok) return unshown(`stage could not be read: ${staging.reason}`);
    for (const name of opts.environments)
      lives.push({
        where: ` in \`${name}\``,
        live: staging.environments.find((env) => env.name === name)?.live ?? null,
      });
  }
  if (lives.length === 0) return { _tag: "Shown" } satisfies RollbackRead;
  const production = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
  if (!production.ok) return unshown(`production could not be read: ${production.reason}`);
  if (production.sha === null) return unshown("production has no successful deployment");
  const why: string[] = [];
  for (const { where, live } of lives) {
    if (live === null) {
      why.push(`stage has no successful deployment${where}`);
      continue;
    }
    const still: string[] = [];
    for (const head of opts.off) {
      const carried = yield* carries(git, live, head);
      if (carried === null) return unshown(`stage's ${short(live)}${where} could not be compared`);
      if (carried) still.push(short(head));
    }
    if (still.length > 0) why.push(`stage still carries ${still.join(", ")}${where}`);
    else if ((yield* carries(git, live, production.sha)) !== true)
      why.push(
        `stage's ${short(live)}${where} does not carry production's ${short(production.sha)}`,
      );
  }
  return why.length === 0 ? ({ _tag: "Shown" } satisfies RollbackRead) : unshown(why.join("; "));
});
