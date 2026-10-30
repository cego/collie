import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { STAGE_CLEARS } from "../workflows/stage.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/stage.gitlab.md" with { type: "text" };
import onGithub from "../workflows/stage.github.md" with { type: "text" };
import releaseOnGitlab from "../workflows/release.gitlab.md" with { type: "text" };
import releaseOnGithub from "../workflows/release.github.md" with { type: "text" };

const content = { gitlab: contentOf(onGitlab), github: contentOf(onGithub) };
const flat = (text: string) => Str.trim(pipe(text, Str.replace(/\s+/g, " ")));
const URL = "https://gitlab.example.com/group/app";

test("both forges' stage content has the steps the module asks for", () => {
  for (const one of Rec.values(content))
    expect([...one.sections.keys()]).toEqual(["assess", "stage", "unstage"]);
});

test("stage decides package or application by release's own rule, word for word", () => {
  const rule = (markdown: string) =>
    /Decide first whether this repository is a package or an application:[\s\S]*?with the\s+evidence\./.exec(
      markdown,
    )?.[0] ?? "";
  for (const [forge, release] of [
    ["gitlab", releaseOnGitlab],
    ["github", releaseOnGithub],
  ] as const) {
    expect(rule(release)).not.toBe("");
    expect(flat(content[forge].sections.get("assess") ?? "")).toContain(flat(rule(release)));
  }
});

test("each Clearance names the repository's URL", () => {
  for (const [step, clears] of Rec.toEntries(STAGE_CLEARS)) {
    const lines = clears(URL, ["deploy-stage"]);
    expect([step, Arr.some(lines, (line) => pipe(line, Str.includes(URL)))]).toEqual([step, true]);
  }
});

test("the stage step is cleared for the jobs it was given, and never a production job", () => {
  const lines = STAGE_CLEARS.stage(URL, ["deploy-stage-spilnu", "deploy-stage-happytiger"]);
  const said = Arr.join(lines, "; ");
  expect(said).toContain("`deploy-stage-spilnu`, `deploy-stage-happytiger`");
  expect(lines).toContain("never a production job");
  expect(said).not.toMatch(/playing[^;]*production/);
});

test("a monorepo's many stage jobs keep the Clearance within what a step may be given, counted where they do not fit", () => {
  const apps = ["bingo", "casino", "happytiger", "lobby", "playground", "poker", "spilnu"];
  const jobs = Arr.map(apps, (app) => `deploy-stage:${app}`);
  for (const clears of Rec.values(STAGE_CLEARS)) {
    const said = Arr.join(clears(URL, jobs), "; ");
    expect(said.length).toBeLessThanOrEqual(400);
    expect(
      pipe(said, Str.includes("7 stage jobs")) ||
        Arr.every(jobs, (job) => pipe(said, Str.includes(`\`${job}\``))),
    ).toBe(true);
  }
  expect(Arr.join(STAGE_CLEARS.stage(URL, jobs), "; ")).toContain(
    "the 7 stage jobs its task names",
  );
});

test("the content's preamble says what a Stage Run does in staging words", () => {
  for (const markdown of [onGitlab, onGithub]) {
    const preamble = pipe(
      markdown,
      Str.slice(
        0,
        Option.getOrElse(pipe(markdown, Str.indexOf("\n## ")), () => -1),
      ),
      Str.replaceAll(/(merge|pull) request/gi, ""),
    );
    expect(preamble).toContain("for the human to test, unmerged");
    expect(preamble).not.toMatch(/\b(release[sd]?|approv\w*|merges?|merging|Go)\b/i);
  }
});

test("staging deploys the head's own pipeline and rolls back only what it staged, never production", () => {
  for (const one of Rec.values(content)) {
    const staging = flat(one.sections.get("stage") ?? "");
    for (const said of [
      "{{head}}",
      "{{stage_jobs}}",
      "Nothing is merged",
      "Roll stage back",
      "only in the",
      "Never play, retry or ask about a production job",
    ])
      expect(staging).toContain(said);
    const unstage = flat(one.sections.get("unstage") ?? "");
    for (const said of ["{{failure}}", "{{head}}", "{{stage_jobs}}", "only in the"])
      expect(unstage).toContain(said);
  }
});
