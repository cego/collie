import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schema } from "effect";
import { waitsOnOf } from "./board-model";
import type { MrRef } from "./board-model";
import { forgeOf, forgeOfUrl } from "./forge/forge";
import type { DeployTier } from "./forge/forge";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { whatItSaid } from "./mr";
import type { Ran, Runner } from "./mr";
import { appendLog } from "./oversight";
import { ParkCause } from "./park-cause";

const short = (sha: string) => pipe(sha, Str.slice(0, 8));

const NAMED = 10;

const atMost = (named: ReadonlyArray<string>) =>
  `${Arr.join(Arr.take(named, NAMED), ", ")}${
    named.length > NAMED ? ` and ${named.length - NAMED} more` : ""
  }`;

const changedFiles = (porcelain: string) =>
  atMost(
    Arr.map(
      Arr.filter(Str.split(porcelain, "\n"), (one) => Str.trim(one) !== ""),
      (one) => pipe(one, Str.replace(/^..\s+/, "")),
    ),
  );

const commitsLike = (log: string) =>
  atMost(
    Arr.map(
      Arr.filter(Str.split(Str.trim(log), "\n"), (one) => Str.trim(one) !== ""),
      (one) => {
        const [sha, ...subject] = Str.split(one, " ");
        return `${short(sha)} ${Arr.join(subject, " ")}`;
      },
    ),
  );

const HeadJson = Schema.fromJsonString(Schema.String);

export const FastForwardSchema = Schema.Union([
  Schema.TaggedStruct("At", { head: Schema.String, from: Schema.String }),
  Schema.TaggedStruct("Refused", { why: Schema.String, cause: ParkCause }),
]);
export type FastForward = typeof FastForwardSchema.Type;

// WARNING: a checkout at origin's tip carrying a stale journaled head answers At, not a refusal.
export const fastForward = Effect.fn("Releasing.fastForward")(function* <R>(opts: {
  readonly runDir: string;
  readonly cwd: string;
  readonly head: string;
  readonly branch?: string;
  readonly createdByCollie?: boolean;
  readonly run: Runner<R>;
}) {
  const git = (args: Array<string>) => opts.run("git", args, opts.cwd);
  const heads = runJournal(opts.runDir, "heads.jsonl");
  const dirty: ParkCause =
    opts.createdByCollie === true ? "checkout-dirty-collie" : "checkout-dirty-human";
  const refused: (why: string, cause?: ParkCause) => FastForward = (
    why,
    cause = "release-failed",
  ) => ({ _tag: "Refused", why, cause });
  const at = (head: string, from: string) =>
    appendRunJournal(heads, HeadJson, head).pipe(
      Effect.as({ _tag: "At", head, from } satisfies FastForward),
    );
  if (opts.branch !== undefined) {
    const branch = yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.code !== 0 || Str.trim(branch.stdout) !== opts.branch) {
      return refused(
        `the checkout at ${opts.cwd} is not on source branch ${opts.branch}; restore that branch before repairing its conflict`,
      );
    }
  }
  const status = yield* git(["status", "--porcelain"]);
  const from = Str.trim((yield* git(["rev-parse", "HEAD"])).stdout);
  if (status.code !== 0 || from === "") {
    return refused(`git could not read the checkout at ${opts.cwd}`);
  }
  if (Str.trim(status.stdout) !== "") {
    return refused(
      `the checkout at ${opts.cwd} has uncommitted changes, so it is not taken as ${short(opts.head)}: ${changedFiles(status.stdout)}`,
      dirty,
    );
  }
  if (from === opts.head) {
    return yield* at(opts.head, from);
  }
  yield* git(["fetch", "--quiet", "origin"]);
  if ((yield* git(["cat-file", "-e", `${opts.head}^{commit}`])).code !== 0) {
    return refused(`origin does not have ${short(opts.head)}`);
  }
  if ((yield* git(["merge-base", "--is-ancestor", from, opts.head])).code !== 0) {
    const branch = Str.trim((yield* git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout);
    const named = branch === "" || branch === "HEAD" ? null : branch;
    const where = named === null ? "origin" : `origin's ${named}`;
    const atOrigin =
      named !== null &&
      Str.trim((yield* git(["rev-parse", "--verify", `refs/remotes/origin/${named}`])).stdout) ===
        from;
    if ((yield* git(["merge-base", "--is-ancestor", opts.head, from])).code === 0) {
      if (atOrigin) {
        yield* appendLog(
          opts.runDir,
          `the checkout already carries ${short(opts.head)} and sits at ${short(from)}, where origin's ${named} points`,
        );
        return yield* at(from, from);
      }
      const ahead = yield* git(["log", "--format=%H %s", `${opts.head}..${from}`]);
      return refused(
        `the checkout at ${opts.cwd} is ahead of ${where}: ${commitsLike(ahead.stdout)}, so it is not taken as ${short(opts.head)}`,
        dirty,
      );
    }
    const reflog =
      named === null
        ? ""
        : (yield* git(["reflog", "show", "--format=%H", `refs/remotes/origin/${named}`])).stdout;
    const recorded = yield* readRunJournal(heads, HeadJson).pipe(Effect.orElseSucceed(() => []));
    const tips = Arr.dedupe([
      ...Arr.filter(Str.split(reflog, "\n"), (one) => Str.trim(one) !== ""),
      ...recorded,
    ]);
    const reachable = tips.length === 0 ? null : yield* git(["rev-list", ...tips]);
    const published = new Set(
      reachable !== null && reachable.code === 0
        ? [...tips, ...Str.split(Str.trim(reachable.stdout), "\n")]
        : tips,
    );
    const risky = yield* git(["log", "--format=%H %s", from, "--not", opts.head]);
    const lost = Arr.filter(
      Str.split(Str.trim(risky.stdout), "\n"),
      (one) => Str.trim(one) !== "" && !published.has(pipe(one, Str.split(" "))[0] ?? ""),
    );
    if (lost.length > 0) {
      return refused(
        `the checkout at ${opts.cwd} holds commits ${where} never carried, so it is not taken as ${short(opts.head)}: ${commitsLike(Arr.join(lost, "\n"))}`,
        "branch-force-pushed",
      );
    }
    const reset = yield* git(["reset", "--hard", "--quiet", opts.head]);
    if (reset.code !== 0) {
      return refused(`git reset --hard ${short(opts.head)} failed: ${whatItSaid(reset)}`);
    }
    yield* appendLog(
      opts.runDir,
      `moved the checkout from ${from} to ${opts.head}, which ${where} no longer carries`,
    );
    return yield* at(opts.head, from);
  }
  const moved = yield* git(["merge", "--ff-only", "--quiet", opts.head]);
  if (moved.code !== 0) {
    return refused(`git merge --ff-only ${short(opts.head)} failed: ${whatItSaid(moved)}`);
  }
  yield* appendLog(opts.runDir, `moved the checkout from ${from} to ${opts.head}`);
  return yield* at(opts.head, from);
});

export const carried = Effect.fn("Releasing.carried")(function* <R>(opts: {
  readonly cwd: string;
  readonly head: string;
  readonly commits: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const git = (args: Array<string>) => opts.run("git", args, opts.cwd);
  if (opts.commits.length > 0) {
    yield* git(["fetch", "--quiet", "origin"]);
  }
  const carries: Array<string> = [];
  for (const commit of opts.commits) {
    if ((yield* git(["merge-base", "--is-ancestor", commit, opts.head])).code === 0) {
      carries.push(commit);
    }
  }
  return carries;
});

export const TagProofSchema = Schema.Literals(["finished", "staged"]);

export const JobLinkSchema = Schema.Struct({ name: Schema.String, url: Schema.String });
export type JobLink = typeof JobLinkSchema.Type;

export const TagReadSchema = Schema.Union([
  Schema.TaggedStruct("Proved", {
    production: Schema.Array(JobLinkSchema),
    at: Schema.String,
  }),
  Schema.TaggedStruct("InProduction", {}),
  Schema.TaggedStruct("StageFailed", { why: Schema.String }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type TagRead = typeof TagReadSchema.Type;

export const ProductionReadSchema = Schema.Union([
  Schema.TaggedStruct("Carried", {}),
  Schema.TaggedStruct("Play", { jobs: Schema.Array(JobLinkSchema) }),
  Schema.TaggedStruct("Unproved", { why: Schema.String }),
]);
export type ProductionRead = typeof ProductionReadSchema.Type;

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

export const RollbackReadSchema = Schema.Union([
  Schema.TaggedStruct("Shown", {}),
  Schema.TaggedStruct("Unshown", { why: Schema.String }),
]);
export type RollbackRead = typeof RollbackReadSchema.Type;

const PlanWaveSchema = Schema.Struct({ plan: Schema.String, at: Schema.Finite });
type PlanWave = typeof PlanWaveSchema.Type;

export const MergeRequestReadSchema = Schema.Union([
  Schema.TaggedStruct("Read", {
    state: Schema.String,
    source: Schema.String,
    target: Schema.String,
    merged: Schema.optionalKey(Schema.String),
    checkout: Schema.optionalKey(Schema.String),
    wave: Schema.optionalKey(PlanWaveSchema),
  }),
  Schema.TaggedStruct("Unreadable", { why: Schema.String }),
]);
export type MergeRequestRead = typeof MergeRequestReadSchema.Type;

export const readMergeRequest = Effect.fn("Releasing.readMergeRequest")(function* <R>(opts: {
  readonly ref: MrRef;
  readonly cwd: string;
  readonly run: Runner<R>;
}) {
  const panel = yield* forgeOf(opts.ref).details(opts.ref, opts.cwd, opts.run);
  if (panel._tag !== "Details") {
    const returned: MergeRequestRead = { _tag: "Unreadable", why: panel.reason };
    return returned;
  }
  const returned: MergeRequestRead = {
    _tag: "Read",
    state: panel.state,
    source: panel.sourceBranch,
    target: panel.targetBranch,
    merged: panel.mergedSha,
  };
  return returned;
});

export function stackOrder(
  mrs: ReadonlyArray<{
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly wave?: PlanWave;
  }>,
) {
  const ids = Arr.map(mrs, (one) => one.id);
  const branches = new Map(Arr.map(mrs, (one) => [one.id, one] as const));
  const earlier = (one: (typeof mrs)[number]) =>
    Arr.filter(
      mrs,
      (other) =>
        one.wave !== undefined && other.wave?.plan === one.wave.plan && other.wave.at < one.wave.at,
    );
  const waits = new Map(
    Arr.map(
      mrs,
      (one) =>
        [
          one.id,
          Arr.union(
            waitsOnOf(one.id, ids, branches),
            Arr.map(earlier(one), (other) => other.id),
          ),
        ] as const,
    ),
  );
  const order: Array<{ readonly id: string; readonly waitsOn: ReadonlyArray<string> }> = [];
  let left = ids;
  while (left.length > 0) {
    const placed = new Set(Arr.map(order, (one) => one.id));
    const ready = Arr.filter(left, (id) => Arr.every(waits.get(id) ?? [], (on) => placed.has(on)));
    if (ready.length === 0) {
      const returned:
        | {
            readonly _tag: "Ordered";
            readonly order: ReadonlyArray<{
              readonly id: string;
              readonly waitsOn: ReadonlyArray<string>;
            }>;
          }
        | { readonly _tag: "Cycle"; readonly ids: ReadonlyArray<string> } = {
        _tag: "Cycle",
        ids: left,
      };
      return returned;
    }
    for (const id of ready) {
      order.push({ id, waitsOn: waits.get(id) ?? [] });
    }
    left = Arr.filter(left, (id) => !ready.includes(id));
  }
  const returned:
    | {
        readonly _tag: "Ordered";
        readonly order: ReadonlyArray<{
          readonly id: string;
          readonly waitsOn: ReadonlyArray<string>;
        }>;
      }
    | { readonly _tag: "Cycle"; readonly ids: ReadonlyArray<string> } = {
    _tag: "Ordered",
    order,
  };
  return returned;
}

const failing = new Set(["failed", "cancelled"]);
const unfinished = new Set(["pending", "running"]);

const unsettled = (
  jobs: ReadonlyArray<{ readonly name: string; readonly state: string }>,
  production: ReadonlyArray<string>,
  on: string,
) => {
  const others = Arr.filter(jobs, (job) => !production.includes(job.name));
  const named = (states: Set<string>) =>
    Arr.map(
      Arr.filter(others, (job) => states.has(job.state)),
      (job) => `\`${job.name}\``,
    );
  const failed = named(failing);
  if (failed.length > 0) {
    return `${Arr.join(failed, ", ")} failed ${on}`;
  }
  const running = named(unfinished);
  if (running.length > 0) {
    return `${Arr.join(running, ", ")} has not finished ${on}`;
  }
  const waiting = named(new Set(["manual"]));
  if (waiting.length > 0) {
    return `${Arr.join(waiting, ", ")} waits ${on} for somebody to start it, and is not a production job`;
  }
  return null;
};

const gitOf =
  <R>(opts: { readonly cwd: string; readonly run: Runner<R> }) =>
  (args: Array<string>) =>
    opts.run("git", args, opts.cwd);

const carries = <R>(
  git: (args: Array<string>) => Effect.Effect<Ran, never, R>,
  sha: string,
  ancestor: string,
) =>
  Effect.gen(function* () {
    for (const one of [sha, ancestor]) {
      if ((yield* git(["cat-file", "-e", `${one}^{commit}`])).code !== 0) {
        return null;
      }
    }
    return (yield* git(["merge-base", "--is-ancestor", ancestor, sha])).code === 0;
  });

const tagOn = <R>(
  git: (args: Array<string>) => Effect.Effect<Ran, never, R>,
  tag: string,
  merged: string,
) =>
  Effect.gen(function* () {
    const lacks = (why: string) => ({ ok: false, why }) as const;
    const ref = `refs/tags/${tag}`;
    const listed = yield* git(["ls-remote", "--tags", "origin", ref]);
    if (listed.code !== 0) {
      return lacks(`origin could not be read: ${whatItSaid(listed)}`);
    }
    const at = Str.split(Str.trim(listed.stdout), /\s+/)[0] ?? "";
    if (at === "") {
      return lacks(`${tag} is not on origin`);
    }
    yield* git(["fetch", "--quiet", "--force", "origin", `${ref}:${ref}`]);
    yield* git(["fetch", "--quiet", "origin"]);
    if ((yield* git(["merge-base", "--is-ancestor", merged, ref])).code !== 0) {
      return lacks(`${tag} on origin does not carry the merged commit ${short(merged)}`);
    }
    const commit = Str.trim((yield* git(["rev-parse", `${ref}^{commit}`])).stdout);
    return { ok: true, at, commit } as const;
  });

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
    if (!read.ok) {
      return not(`${opts.tag}'s pipeline could not be read: ${read.reason}`);
    }
    if (Str.toLowerCase(read.project) !== Str.toLowerCase(opts.ref.project ?? "")) {
      return not(`${opts.url} is a pipeline of ${read.project}, not of ${opts.ref.project}`);
    }
    if (read.ref !== opts.tag) {
      return not(`${opts.url} ran for ${read.ref}, not for ${opts.tag}`);
    }
    if (read.sha !== opts.commit) {
      return not(
        `${opts.url} ran on ${short(read.sha)}, not on ${short(opts.commit)}, which ${opts.tag} tags`,
      );
    }
    return { ok: true, read } as const;
  });

const deployedOn = <R>(ref: MrRef, tier: DeployTier, cwd: string, run: Runner<R>) =>
  forgeOf(ref).deployed(ref, tier, cwd, run);

const inProduction = <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly merged: string;
  readonly run: Runner<R>;
}) =>
  Effect.gen(function* () {
    const read = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
    if (!read.ok || read.sha === null) {
      return false;
    }
    return (yield* carries(gitOf(opts), read.sha, opts.merged)) === true;
  });

// WARNING: a manual job waiting to start has not finished, so the tag is not yet proved.
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
  const unproved: (why: string) => TagRead = (why) => ({ _tag: "Unproved", why });
  const tagged = yield* tagOn(git, opts.tag, opts.merged);
  if (!tagged.ok) {
    return unproved(tagged.why);
  }
  if (opts.ref === null) {
    return unproved("this Run recorded no merge request to read pipelines and deployments of");
  }
  const ref = opts.ref;
  const pipelineAt = (url: string) =>
    tagsPipeline({ url, ref, tag: opts.tag, commit: tagged.commit, cwd: opts.cwd, run: opts.run });
  if (opts.proves === "finished") {
    let pipeline = opts.pipeline;
    if (pipeline === null) {
      const found = yield* forgeOf(ref).tagPipeline(ref, opts.tag, opts.cwd, opts.run);
      if (!found.ok) {
        return unproved(`${opts.tag}'s pipelines could not be listed: ${found.reason}`);
      }
      if (found.url === null) {
        return { _tag: "Proved", production: [], at: tagged.at } satisfies TagRead;
      }
      pipeline = found.url;
    }
    const tags = yield* pipelineAt(pipeline);
    if (!tags.ok) {
      return unproved(tags.why);
    }
    const read = tags.read;
    const manual = Arr.map(
      Arr.filter(read.jobs, (job) => job.state === "manual"),
      (job) => `\`${job.name}\``,
    );
    if (manual.length > 0) {
      return unproved(
        `${opts.tag}'s pipeline at ${pipeline} has not finished: ${Arr.join(manual, ", ")} waits for somebody to start it by hand`,
      );
    }
    if (!read.succeeded) {
      return unproved(`${opts.tag}'s pipeline at ${pipeline} has not finished and succeeded`);
    }
    return { _tag: "Proved", production: [], at: tagged.at } satisfies TagRead;
  }

  if (yield* inProduction({ ...opts, ref })) {
    return { _tag: "InProduction" } satisfies TagRead;
  }
  if (opts.pipeline === null) {
    return unproved(`no pipeline of ${opts.tag} was named to prove stage from`);
  }
  const pipeline = opts.pipeline;
  const tags = yield* pipelineAt(pipeline);
  if (!tags.ok) {
    return unproved(tags.why);
  }
  const read = tags.read;
  const on = `on ${opts.tag}'s pipeline at ${pipeline}`;
  const jobNamed = (name: string) =>
    Option.getOrUndefined(Arr.findFirst(read.jobs, (job) => job.name === name));
  if (opts.stage.length > 0) {
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job !== undefined && failing.has(job.state)) {
        return { _tag: "StageFailed", why: `\`${name}\` failed ${on}` } satisfies TagRead;
      }
    }
    for (const name of opts.stage) {
      const job = jobNamed(name);
      if (job === undefined) {
        return unproved(`\`${name}\` is not a job ${on}`);
      }
      if (job.state !== "passed") {
        return unproved(`\`${name}\` has not passed ${on}: it is ${job.state}`);
      }
    }
    const staging = yield* deployedOn(ref, "staging", opts.cwd, opts.run);
    if (!staging.ok) {
      return unproved(`stage could not be read: ${staging.reason}`);
    }
    const staged = staging.sha === null ? false : yield* carries(git, staging.sha, opts.merged);
    if (staged === null) {
      return unproved(
        `stage's ${short(staging.sha ?? "")} could not be compared with the merged commit`,
      );
    }
    if (!staged) {
      return {
        _tag: "StageFailed",
        why: `stage does not carry the merged commit ${short(opts.merged)}`,
      } satisfies TagRead;
    }
  }
  const settled = unsettled(read.jobs, opts.production, on);
  if (settled !== null) {
    return unproved(settled);
  }
  if (opts.production.length === 0) {
    return unproved(`no production job ${on} was named`);
  }
  const production: Array<JobLink> = [];
  for (const name of opts.production) {
    const job = jobNamed(name);
    if (job === undefined) {
      return unproved(`\`${name}\` is not a job ${on}`);
    }
    if (job.state !== "manual") {
      return unproved(
        `\`${name}\` does not wait ${on} for somebody to start it: it is ${job.state}`,
      );
    }
    production.push({ name, url: job.url ?? pipeline });
  }
  return { _tag: "Proved", production, at: tagged.at } satisfies TagRead;
});

export const readProduction = Effect.fn("Releasing.readProduction")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly tag: string;
  readonly at: string;
  readonly merged: string;
  readonly pipeline: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const unproved: (why: string) => ProductionRead = (why) => ({ _tag: "Unproved", why });
  if (yield* inProduction(opts)) {
    return { _tag: "Carried" } satisfies ProductionRead;
  }
  const tagged = yield* tagOn(gitOf(opts), opts.tag, opts.merged);
  if (!tagged.ok) {
    return unproved(tagged.why);
  }
  if (tagged.at !== opts.at) {
    return unproved(
      `${opts.tag} on origin moved since it was proved, from ${short(opts.at)} to ${short(tagged.at)}`,
    );
  }
  const tags = yield* tagsPipeline({ ...opts, url: opts.pipeline, commit: tagged.commit });
  if (!tags.ok) {
    return unproved(tags.why);
  }
  const read = tags.read;
  const on = `on ${opts.tag}'s pipeline at ${opts.pipeline}`;
  const settled = unsettled(read.jobs, opts.jobs, on);
  if (settled !== null) {
    return unproved(settled);
  }
  const jobs: Array<JobLink> = [];
  for (const name of opts.jobs) {
    const job = Option.getOrUndefined(Arr.findFirst(read.jobs, (one) => one.name === name));
    if (job === undefined) {
      return unproved(`\`${name}\` is no longer a job ${on}`);
    }
    if (failing.has(job.state)) {
      return unproved(`\`${name}\` failed ${on}`);
    }
    if (job.state === "manual") {
      jobs.push({ name, url: job.url ?? opts.pipeline });
    }
  }
  return { _tag: "Play", jobs } satisfies ProductionRead;
});

const named = (names: ReadonlyArray<string>) =>
  Arr.join(
    Arr.map(names, (one) => `\`${one}\``),
    ", ",
  );

export const readStage = Effect.fn("Releasing.readStage")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly head: string;
  readonly jobs: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const failed: (why: string, environments?: ReadonlyArray<string>) => StageRead = (
    why,
    environments?,
  ) =>
    environments === undefined ? { _tag: "Failed", why } : { _tag: "Failed", why, environments };
  if (opts.jobs.length === 0) {
    return failed("no stage job of the merge request's pipeline was named");
  }
  const on = `on the merge request's pipeline at ${short(opts.head)}`;
  const jobs: Array<JobLink> = [];
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
    if (job.merge !== null) {
      commit = job.merge;
    }
    if (job.state !== "passed") {
      unpassed ??= `\`${name}\` has not passed ${on}: it is ${job.state}`;
    }
    jobs.push({ name, url: job.url ?? "" });
  }
  const staging = yield* forgeOf(opts.ref).stagingEnvironments(
    opts.ref,
    commit,
    opts.cwd,
    opts.run,
    opts.jobs,
  );
  if (!staging.ok) {
    return failed(unpassed ?? `stage could not be read: ${staging.reason}`);
  }
  const reached = Arr.filter(staging.environments, (env) => env.hasCommit);
  const environments = Arr.map(reached, (env) => env.name);
  if (moved !== null) {
    return { _tag: "Moved", head: moved, environments } satisfies StageRead;
  }
  if (unpassed !== null) {
    return failed(unpassed, environments);
  }
  if (reached.length === 0) {
    return failed(
      `stage does not carry ${short(opts.head)}: no stage environment has a deployment of ${short(commit)} by ${named(opts.jobs)}`,
      environments,
    );
  }
  const uncarried: Array<string> = [];
  for (const env of reached) {
    if (env.live === opts.head || env.live === commit) {
      continue;
    }
    const staged = env.live === null ? false : yield* carries(gitOf(opts), env.live, opts.head);
    if (staged === null) {
      return failed(
        `\`${env.name}\`'s ${short(env.live ?? "")} could not be compared with ${short(opts.head)}`,
        environments,
      );
    }
    if (!staged) {
      uncarried.push(env.name);
    }
  }
  if (uncarried.length > 0) {
    return failed(`stage does not carry ${short(opts.head)} in ${named(uncarried)}`, environments);
  }
  return { _tag: "Staged", jobs, environments } satisfies StageRead;
});

export const readRollback = Effect.fn("Releasing.readRollback")(function* <R>(opts: {
  readonly cwd: string;
  readonly ref: MrRef;
  readonly off: ReadonlyArray<string>;
  readonly environments?: ReadonlyArray<string>;
  readonly run: Runner<R>;
}) {
  const unshown: (why: string) => RollbackRead = (why) => ({ _tag: "Unshown", why });
  const git = gitOf(opts);
  const lives: Array<{ readonly where: string; readonly live: string | null }> = [];
  if (opts.environments === undefined) {
    const staging = yield* deployedOn(opts.ref, "staging", opts.cwd, opts.run);
    if (!staging.ok) {
      return unshown(`stage could not be read: ${staging.reason}`);
    }
    lives.push({ where: "", live: staging.sha });
  } else if (opts.environments.length > 0) {
    const staging = yield* forgeOf(opts.ref).stagingEnvironments(
      opts.ref,
      null,
      opts.cwd,
      opts.run,
    );
    if (!staging.ok) {
      return unshown(`stage could not be read: ${staging.reason}`);
    }
    for (const name of opts.environments) {
      lives.push({
        where: ` in \`${name}\``,
        live:
          Option.getOrUndefined(Arr.findFirst(staging.environments, (env) => env.name === name))
            ?.live ?? null,
      });
    }
  }
  if (lives.length === 0) {
    return { _tag: "Shown" } satisfies RollbackRead;
  }
  const production = yield* deployedOn(opts.ref, "production", opts.cwd, opts.run);
  if (!production.ok) {
    return unshown(`production could not be read: ${production.reason}`);
  }
  if (production.sha === null) {
    return unshown("production has no successful deployment");
  }
  const why: Array<string> = [];
  for (const { where, live } of lives) {
    if (live === null) {
      why.push(`stage has no successful deployment${where}`);
      continue;
    }
    const still: Array<string> = [];
    for (const head of opts.off) {
      const carried = yield* carries(git, live, head);
      if (carried === null) {
        return unshown(`stage's ${short(live)}${where} could not be compared`);
      }
      if (carried) {
        still.push(short(head));
      }
    }
    if (still.length > 0) {
      why.push(`stage still carries ${Arr.join(still, ", ")}${where}`);
    } else if ((yield* carries(git, live, production.sha)) !== true) {
      why.push(
        `stage's ${short(live)}${where} does not carry production's ${short(production.sha)}`,
      );
    }
  }
  return why.length === 0
    ? ({ _tag: "Shown" } satisfies RollbackRead)
    : unshown(Arr.join(why, "; "));
});
