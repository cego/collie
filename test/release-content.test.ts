import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { RELEASE_CLEARS, RELEASE_ON } from "../workflows/release.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/release.gitlab.md" with { type: "text" };
import onGithub from "../workflows/release.github.md" with { type: "text" };
import renovateOnGitlab from "../workflows/renovate.gitlab.md" with { type: "text" };
import renovateOnGithub from "../workflows/renovate.github.md" with { type: "text" };

// release keeps a content file per forge, as renovate does (ADR-0050 D1): the procedure
// differs, so each says it its forge's way.

const content = { gitlab: contentOf(onGitlab), github: contentOf(onGithub) };
const flat = (text: string) => Str.trim(pipe(text, Str.replace(/\s+/g, " ")));

test("both forges' release content has the steps the module asks for, and every step fills from what it gives", () => {
  for (const one of Rec.values(content))
    expect([...one.sections.keys()]).toEqual([
      "assess",
      "answer",
      "fix",
      "stage-merge-request",
      "unstage",
      "tag",
      "tag-tested",
      "stage",
      "rollback",
      "production",
      "share",
    ]);
  // A template naming anything ReleaseInput does not give is refused as it is made.
  expect(Rec.keys(RELEASE_ON.github)).toEqual(Rec.keys(RELEASE_ON.gitlab));
});

test("release decides package or application by renovate's own rule, word for word", () => {
  const rule = (markdown: string) =>
    /Decide first whether this repository is a package or an application:[\s\S]*?with the\s+evidence\./.exec(
      markdown,
    )?.[0] ?? "";
  for (const [forge, renovate] of [
    ["gitlab", renovateOnGitlab],
    ["github", renovateOnGithub],
  ] as const) {
    expect(rule(renovate)).not.toBe("");
    expect(flat(content[forge].sections.get("assess") ?? "")).toContain(flat(rule(renovate)));
  }
});

test("each Clearance names the repository's URL", () => {
  const url = "https://gitlab.example.com/group/app";
  for (const [step, clears] of Rec.toEntries(RELEASE_CLEARS)) {
    const lines = clears(url, [{ name: "deploy-production", url: `${url}/-/jobs/4` }]);
    expect([step, Arr.some(lines, (line) => pipe(line, Str.includes(url)))]).toEqual([step, true]);
  }
});

test("the tag step tags by the repository's conventions, watches its pipeline and plays no production job", () => {
  for (const one of Rec.values(content)) {
    const tag = flat(one.sections.get("tag") ?? "");
    expect(tag).toContain("the repository's own tag and notes conventions");
    expect(tag).toContain("`## <version> - <YYYY-MM-DD>`");
    expect(tag).toContain("--cleanup=verbatim");
    expect(tag).toContain("Production deploy jobs are mine");
    expect(tag).toContain("{{recovery}}");
    expect(tag).toContain("{{merged}}");
  }
});

test("a comment round fixes test first and pushes plainly, and leaves every reply to Collie", () => {
  for (const one of Rec.values(content)) {
    const answer = flat(one.sections.get("answer") ?? "");
    expect(answer).toContain("{{comments}}");
    expect(answer).toContain("never a force push");
    expect(answer).toContain("never resolves a thread");
    expect(answer).toContain("a comment you leave out goes to the next round");
    expect(flat(one.sections.get("fix") ?? "")).toContain("never a force push");
  }
});

test("an application's tag step stages the tag, rolls a failed stage back and leaves production waiting", () => {
  for (const one of Rec.values(content)) {
    const stage = flat(one.sections.get("stage") ?? "");
    for (const said of [
      "{{recovery}}",
      "{{merged}}",
      "{{stage_jobs}}",
      "the repository's own tag and notes conventions",
      "--cleanup=verbatim",
      "Roll stage back",
      "Never play, retry or ask about a production job",
    ])
      expect(stage).toContain(said);
    expect(flat(one.sections.get("rollback") ?? "")).toContain("{{failure}}");
    const production = flat(one.sections.get("production") ?? "");
    expect(production).toContain("{{jobs}}");
    expect(production).toContain("no other job");
  }
});

test("staging a merge request deploys its own pipeline's head, checks stage and rolls it back, unmerged and never to production", () => {
  for (const one of Rec.values(content)) {
    const staging = flat(one.sections.get("stage-merge-request") ?? "");
    for (const said of [
      "{{head}}",
      "{{stage_jobs}}",
      "Nothing is merged",
      "Roll stage back",
      "Never play, retry or ask about a production job",
    ])
      expect(staging).toContain(said);
    const unstage = flat(one.sections.get("unstage") ?? "");
    expect(unstage).toContain("{{failure}}");
    expect(unstage).toContain("{{head}}");
    const tagging = flat(one.sections.get("tag-tested") ?? "");
    for (const said of [
      "{{recovery}}",
      "{{merged}}",
      "the repository's own tag and notes conventions",
      "--cleanup=verbatim",
      "Never play, retry or ask about a production job",
    ])
      expect(tagging).toContain(said);
  }
});

test("sharing content describes the host's one approval post and the manual fallback", () => {
  for (const [forge, one] of Rec.toEntries(content)) {
    const share = flat(one.sections.get("share") ?? "");
    for (const said of [
      "{{inputs.mr}}",
      "{{channel}}",
      "`<URL|TITLE>`",
      "no other words, no emoji, no mention and no thread reply",
      "host's Slack adapter",
      "share it yourself",
    ])
      expect(share).toContain(said);
    expect(share).toContain(forge === "gitlab" ? "GitLab" : "GitHub");
  }
});
