// Times the forge interface's `job` or `details` read over the CLI, as the adapters asked
// it before ADR-draft-a-forge-is-asked-over-http-with-its-clis-login, and over the `forges`
// library, as they ask it now, against a live pull request and merge request. Manual, not
// a test:
//
//   bun run tools/forges-benchmark.ts \
//     --github https://github.com/cego/collie/pull/181 --github-job check \
//     --gitlab https://gitlab.example.com/group/app/-/merge_requests/7 --gitlab-job test \
//     [--read job|details] [--reads 20]
//
// `details` needs no job names.
//
// The reads alternate between the transports, so both see the same network. The library's
// reads share one ForgeHttp, as a host's poll does: its first read pays the credential
// read and the connection.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { parseArgs } from "node:util";
import { Clock, Console, Effect, Option, Schema } from "effect";
import { mrRefOf, type MrRef } from "../src/board-model";
import { forgeOf } from "../src/forge/forge";
import { forgeHttpLayer } from "../src/forge/http";
import { shell } from "../src/mr";
import * as Layer from "effect/Layer";

const { values } = parseArgs({
  options: {
    github: { type: "string" },
    "github-job": { type: "string" },
    gitlab: { type: "string" },
    "gitlab-job": { type: "string" },
    read: { type: "string", default: "job" },
    reads: { type: "string", default: "20" },
  },
});
const reads = Number(values.reads);
const reading = values.read === "details" ? "details" : "job";

const run = (cmd: string, args: string[]) => shell(cmd, args, process.cwd());
const decoded = <S extends Schema.Decoder<unknown>>(schema: S, text: string) =>
  Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(schema))(text));

/** The CLI's `job` before the move: the commands `src/forge/github.ts` ran. */
const githubCli = Effect.fn("benchmark.githubCli")(function* (ref: MrRef, name: string) {
  const repo = pipe_(ref.project!, Str.slice("github.com/".length));
  const view = yield* run("gh", ["pr", "view", ref.iid, "--repo", repo, "--json", "headRefOid"]);
  const head = decoded(Schema.Struct({ headRefOid: Schema.String }), view.stdout)?.headRefOid;
  if (head === undefined) return yield* Effect.die(`gh could not read ${repo}#${ref.iid}`);
  const query = `check_name=${encodeURIComponent(name)}`;
  const listed = yield* run("gh", ["api", `repos/${repo}/commits/${head}/check-runs?${query}`]);
  if (listed.code !== 0) return yield* Effect.die(`gh could not list the check runs on ${head}`);
});

const GitlabMr = Schema.Struct({
  sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
  head_pipeline: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ id: Schema.Finite, sha: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const GitlabJobs = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The CLI's `job` before the move: the commands `src/forge/gitlab.ts` ran. */
const gitlabCli = Effect.fn("benchmark.gitlabCli")(function* (ref: MrRef, name: string) {
  const project = ref.project!;
  const host = Str.split(project, "/")[0]!;
  const path = encodeURIComponent(pipe_(project, Str.slice(host.length + 1)));
  yield* run("glab", ["--version"]);
  if ((yield* run("glab", ["auth", "status", "--hostname", host])).code !== 0)
    return yield* Effect.die(`glab is not logged in to ${host}`);
  const api = (route: string) =>
    run("glab", ["api", "--hostname", host, "-X", "GET", `projects/${path}/${route}`]);
  const view = yield* run("glab", ["mr", "view", ref.iid, "--repo", project, "-F", "json"]);
  const mr = decoded(GitlabMr, view.stdout);
  if (mr === undefined) return yield* Effect.die(`glab could not read ${project}!${ref.iid}`);
  const pipeline = mr.head_pipeline;
  if (pipeline == null) return;
  if (pipeline.sha && pipeline.sha !== mr.sha) yield* api(`repository/commits/${pipeline.sha}`);
  for (let page = 1; ; page++) {
    const listed = yield* api(`pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`);
    const jobs = decoded(GitlabJobs, listed.stdout);
    if (jobs === undefined)
      return yield* Effect.die(`glab could not list the jobs of ${pipeline.id}`);
    if (Arr.some(jobs, (one) => one.name === name) || jobs.length < 100) return;
  }
});

const GITHUB_FIELDS = Arr.join(
  [
    "title",
    "state",
    "isDraft",
    "author",
    "assignees",
    "headRefName",
    "isCrossRepository",
    "baseRefName",
    "headRefOid",
    "mergeCommit",
    "mergedAt",
    "statusCheckRollup",
    "reviewDecision",
    "comments",
    "updatedAt",
    "url",
    "autoMergeRequest",
    "mergeable",
    "mergeStateStatus",
  ],
  ",",
);

/** The CLI's `details` before the move: the one `gh pr view` `src/forge/github.ts` ran. */
const githubDetailsCli = Effect.fn("benchmark.githubDetailsCli")(function* (ref: MrRef) {
  const repo = pipe_(ref.project!, Str.slice("github.com/".length));
  const view = yield* run("gh", ["pr", "view", ref.iid, "--repo", repo, "--json", GITHUB_FIELDS]);
  if (view.code !== 0) return yield* Effect.die(`gh could not read ${repo}#${ref.iid}`);
});

/** The CLI's `details` before the move: the commands `src/forge/gitlab.ts` ran. */
const gitlabDetailsCli = Effect.fn("benchmark.gitlabDetailsCli")(function* (ref: MrRef) {
  const project = ref.project!;
  const host = Str.split(project, "/")[0]!;
  yield* run("glab", ["--version"]);
  if ((yield* run("glab", ["auth", "status", "--hostname", host])).code !== 0)
    return yield* Effect.die(`glab is not logged in to ${host}`);
  const view = yield* run("glab", ["mr", "view", ref.iid, "--repo", project, "-F", "json"]);
  if (view.code !== 0) return yield* Effect.die(`glab could not read ${project}!${ref.iid}`);
});

/** How long `read` took, in ms. */
const timed = <R>(read: Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeNanos;
    yield* read;
    return Number((yield* Clock.currentTimeNanos) - start) / 1e6;
  });

const quantile = (times: ReadonlyArray<number>, q: number) => {
  const sorted = Arr.sort(times, Order.Number);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};

interface Measured {
  readonly url: string | undefined;
  readonly name: string | undefined;
  readonly job: (ref: MrRef, name: string) => Effect.Effect<void, never, BunServices.BunServices>;
  readonly details: (ref: MrRef) => Effect.Effect<void, never, BunServices.BunServices>;
}

const forgesProgram = Effect.gen(function* () {
  const rows: string[] = [];
  const medians: { cli: number; library: number }[] = [];
  const measured: Measured[] = [
    { url: values.github, name: values["github-job"], job: githubCli, details: githubDetailsCli },
    { url: values.gitlab, name: values["gitlab-job"], job: gitlabCli, details: gitlabDetailsCli },
  ];
  for (const { url, name = "", job, details } of measured) {
    if (url === undefined || (reading === "job" && name === "")) continue;
    const ref = mrRefOf(url);
    if (ref === null) return yield* Effect.die(`${url} is not a merge request`);
    const forge = forgeOf(ref);
    const cli = reading === "job" ? job(ref, name) : details(ref);
    const library =
      reading === "job"
        ? Effect.flatMap(forge.job(ref, name, process.cwd(), shell), (read) =>
            read.ok ? Effect.void : Effect.die(read.reason),
          )
        : Effect.flatMap(forge.details(ref, process.cwd(), shell), (panel) =>
            panel._tag === "Details" ? Effect.void : Effect.die(panel.reason),
          );
    const cliTimes: number[] = [];
    const libraryTimes: number[] = [];
    for (let n = 0; n < reads; n++) {
      cliTimes.push(yield* timed(cli));
      libraryTimes.push(yield* timed(library));
    }
    medians.push({ cli: quantile(cliTimes, 0.5), library: quantile(libraryTimes, 0.5) });
    for (const [transport, times] of [
      [forge.cli, cliTimes],
      ["forges", libraryTimes],
    ] satisfies [string, number[]][])
      rows.push(
        `| ${forge.display} | ${url} | ${transport} | ${reads} | ${quantile(times, 0.5).toFixed(0)} ms | ${quantile(times, 0.9).toFixed(0)} ms |`,
      );
  }
  const go = Arr.every(medians, (one) => one.library <= one.cli);
  yield* Console.log(
    Arr.join(
      [
        "| Forge | Merge request | Transport | Reads | Median | p90 |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
        "",
        `${go ? "Go" : "No-go"}: the library's median \`${reading}\` is ${go ? "no slower than" : "slower than"} the CLI's on ${go ? "every forge measured" : "a forge measured"}.`,
      ],
      "\n",
    ),
  );
});

BunRuntime.runMain(
  forgesProgram.pipe(Effect.provide(forgeHttpLayer.pipe(Layer.provideMerge(BunServices.layer)))),
);
