import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Schema, flow, Result } from "effect";
import { RENOVATE, RENOVATE_ON, Released, Tracked } from "../workflows/renovate.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/renovate.gitlab.md" with { type: "text" };
import onGithub from "../workflows/renovate.github.md" with { type: "text" };

// renovate keeps a content file per forge (ADR-0050 D1, as amended): the procedure differs,
// so each says it its forge's way, and what is Linear's is said the same in both.

const gitlab = contentOf(onGitlab);
const github = contentOf(onGithub);

test("both forges' renovate content has the same steps, and every step fills from what renovate gives it", () => {
  expect([...github.sections.keys()]).toEqual([...gitlab.sections.keys()]);
  expect([...gitlab.sections.keys()]).toEqual([
    "track",
    "assess",
    "batch",
    "stage",
    "approval",
    "merge",
    "release",
    "record",
  ]);
  // A template naming anything RenovateInput does not give is refused as it is made.
  expect(Rec.keys(RENOVATE_ON.github)).toEqual(Rec.keys(RENOVATE_ON.gitlab));
});

test("tracking and recording are Linear's, and word for word the same on both forges", () => {
  for (const step of ["track", "record"])
    expect(github.sections.get(step)).toBe(gitlab.sections.get(step));
});

test("RENOVATE is still the GitLab content a fork written before there were two reads", () => {
  expect(RENOVATE).toBe(RENOVATE_ON.gitlab);
  expect(RENOVATE.merge.text).toContain("glab mr approve");
  expect(RENOVATE_ON.github.merge.text).toContain("gh pr merge");
});

test("the batch branch is named outside Renovate Bot's branch prefix on both forges", () => {
  for (const content of [gitlab, github]) {
    const batch = content.sections.get("batch") ?? "";
    expect(batch).toContain("`deps/batch-<YYYY-MM-DD>`");
    expect(batch).toContain("`collie/batch-<YYYY-MM-DD>`");
    expect(batch).toContain("git push -u origin <batch branch>");
    expect(batch).not.toContain("git push -u origin deps/");
    expect(batch).not.toContain("renovate/batch");
  }
});

test("the batch leaves out a bump it cannot fix small, with a recommendation, and never stops to ask", () => {
  for (const content of [gitlab, github]) {
    const batch = pipe(content.sections.get("batch") ?? "", Str.replace(/\s+/g, " "));
    expect(batch).not.toContain("consult");
    expect(batch).toContain(
      "Anything that needs more than that is **left out of the batch** and reported with why and what you recommend",
    );
    expect(batch).toContain("take the option you would recommend");
    expect(batch).toContain("Do not stop to ask.");
    expect(content.sections.get("assess")).toContain("consultation");
    expect(content.sections.get("merge")).toContain("consultation");
  }
});

test("renovate picks among several issues by rule, asks approval on the Run, and leaves production to the human", () => {
  for (const content of [gitlab, github]) {
    const flat = (step: string) => pipe(content.sections.get(step) ?? "", Str.replace(/\s+/g, " "));
    const track = flat("track");
    expect(track).toContain("the one whose title names the current month or cycle");
    expect(track).toContain("otherwise the one with the earliest due date");
    expect(track).toContain("otherwise the newest");
    expect(track).toContain("`picked_because`");
    expect(track).not.toMatch(/ask me which(?! team)/);
    expect(track).toContain("ask me which team");
    const approval = flat("approval");
    expect(approval).not.toContain("in this pane");
    expect(approval).toContain("question tool");
    const release = flat("release");
    expect(release).toContain("`prod_jobs`");
    expect(release).toContain("never play, retry or ask about them");
    expect(release).not.toContain("including its publish or deploy jobs");
  }
});

test("a landing's own Outputs decode with or without the pick and the production jobs", () => {
  const tracked = { verdict: "clean", issue: "REN-1" };
  expect(
    flow(Schema.decodeUnknownResult(Tracked), Result.getOrThrow)(tracked).picked_because,
  ).toBeUndefined();
  expect(
    flow(
      Schema.decodeUnknownResult(Tracked),
      Result.getOrThrow,
    )({ ...tracked, picked_because: "names October" }).picked_because,
  ).toBe("names October");
  const released = { verdict: "clean", tagged: true, version: "1.2.0" };
  expect(
    flow(Schema.decodeUnknownResult(Released), Result.getOrThrow)(released).prod_jobs,
  ).toBeUndefined();
  const jobs = [
    { name: "deploy-prod", url: "https://gitlab.example.com/x/-/jobs/9" },
    { name: "prod" },
  ];
  expect(
    flow(Schema.decodeUnknownResult(Released), Result.getOrThrow)({ ...released, prod_jobs: jobs })
      .prod_jobs,
  ).toEqual(jobs);
});
