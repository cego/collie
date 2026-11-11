import { strict as assert } from "node:assert";
import { Config, Effect } from "effect";
import * as Str from "effect/String";

const [modelPath, cwd, kind, production] = Bun.argv.slice(2);
assert(modelPath && cwd);
const paths = await Effect.runPromise(
  Effect.all({ prompt: Config.String("PROMPT_PATH"), output: Config.String("OUTPUT_PATH") }),
);
const prompt = await Bun.file(paths.prompt).text();
const model = await Bun.file(modelPath).json();
const run = /You are \S+ of (\S+) on /.exec(prompt)?.[1];
assert(run);
const merged = /merged commit is `([^`]+)`/.exec(prompt)?.[1];
let output;
if (merged) {
  const project = /https:\/\/([^\s]+)\/-\/merge_requests\/\d+/.exec(prompt)?.[1];
  assert(project);
  const tag = `v1.2.0-${Str.split(project, "/").at(-1)}`;
  let at = merged;
  if (Str.includes("This is the set's tag Run")(prompt)) {
    const tip: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      ["git", "-C", cwd, "rev-parse", "origin/main"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    at = Str.trim(await new Response(tip.stdout).text());
    assert.equal(await tip.exited, 0);
  }
  for (const args of [
    ["tag", "-a", tag, "-m", tag, at],
    ["push", "-q", "origin", tag],
  ]) {
    const child: Bun.Subprocess = Bun.spawn(["git", "-C", cwd, ...args]);
    assert.equal(await child.exited, 0);
  }
  model.tags ??= [];
  model.tags.push({
    project,
    run,
    sha: at,
    merged: (model.merges ?? []).map((one: { key: string }) => one.key),
  });
  if (kind === "application") {
    model.environments = [
      { name: "stage", tier: "staging", deployed: at, job: "deploy-stage" },
      { name: "production", tier: "production", deployed: production },
    ];
    model.runs = {
      "7": {
        ref: tag,
        sha: at,
        status: "manual",
        jobs: [
          { name: "deploy-stage", state: "passed" },
          { name: "deploy-production", state: "manual" },
        ],
      },
    };
  }
  await Bun.write(modelPath, JSON.stringify(model));
  output = {
    verdict: "clean",
    tag,
    pipeline_url: kind === "application" ? `https://${project}/-/pipelines/7` : undefined,
    stage_jobs: ["deploy-stage"],
    production_jobs: [{ name: "deploy-production", url: `https://${project}/-/jobs/2` }],
  };
} else if (Str.includes('"played"')(prompt)) {
  const sha = model.tags.at(-1).sha;
  model.environments = [
    { name: "stage", tier: "staging", deployed: sha, job: "deploy-stage" },
    { name: "production", tier: "production", deployed: sha },
  ];
  await Bun.write(modelPath, JSON.stringify(model));
  output = { verdict: "clean", played: ["deploy-production"] };
} else {
  output = {
    verdict: "clean",
    is_package: kind !== "application",
    kind_evidence: "fixture pipeline",
    stage_jobs: { merge_request: [], tag: ["deploy-stage"] },
  };
}
await Bun.write(paths.output, JSON.stringify(output));
