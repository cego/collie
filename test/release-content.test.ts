import { expect, test } from "bun:test";
import { RELEASE_CLEARS, RELEASE_ON, SHARE_CLEARS } from "../workflows/release.workflow";
import { contentOf } from "../src/sdk";
import onGitlab from "../workflows/release.gitlab.md" with { type: "text" };
import onGithub from "../workflows/release.github.md" with { type: "text" };
import renovateOnGitlab from "../workflows/renovate.gitlab.md" with { type: "text" };
import renovateOnGithub from "../workflows/renovate.github.md" with { type: "text" };

// release keeps a content file per forge, as renovate does (ADR-0050 D1): the procedure
// differs, so each says it its forge's way.

const content = { gitlab: contentOf(onGitlab), github: contentOf(onGithub) };
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

test("both forges' release content has the steps the module asks for, and every step fills from what it gives", () => {
  for (const one of Object.values(content))
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
  expect(Object.keys(RELEASE_ON.github)).toEqual(Object.keys(RELEASE_ON.gitlab));
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
  for (const [step, clears] of Object.entries(RELEASE_CLEARS)) {
    const lines = clears(url, [{ name: "deploy-production", url: `${url}/-/jobs/4` }]);
    expect([step, lines.some((line) => line.includes(url))]).toEqual([step, true]);
  }
});

test("the tag step tags by the repository's conventions, watches its pipeline and plays no production job", () => {
  for (const one of Object.values(content)) {
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
  for (const one of Object.values(content)) {
    const answer = flat(one.sections.get("answer") ?? "");
    expect(answer).toContain("{{comments}}");
    expect(answer).toContain("never a force push");
    expect(answer).toContain("never resolves a thread");
    expect(answer).toContain("a comment you leave out goes to the next round");
    expect(flat(one.sections.get("fix") ?? "")).toContain("never a force push");
  }
});

test("an application's tag step stages the tag, rolls a failed stage back and leaves production waiting", () => {
  for (const one of Object.values(content)) {
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
  for (const one of Object.values(content)) {
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

test("sharing for approval posts one Slack message, the merge request linked by its title, and nothing else", () => {
  for (const [forge, one] of Object.entries(content)) {
    const share = flat(one.sections.get("share") ?? "");
    for (const said of [
      "{{inputs.mr}}",
      "{{channel}}",
      "`<URL|TITLE>`",
      "no other words, no emoji, no mention and no thread reply",
      "Post nowhere else",
      "If you have no Slack tool",
    ])
      expect(share).toContain(said);
    expect(share).toContain(forge === "gitlab" ? "glab mr view" : "gh pr view");
  }
});

test("sharing's Clearance names the channel and the merge request, well under the 400 characters a Clearance may be", () => {
  const mr = "https://gitlab.example.com/spilnu/frontend/monorepo/-/merge_requests/12345";
  const clears = SHARE_CLEARS(mr, "#frontend-approval-requests");
  const joined = clears.join("; ");
  expect(joined).toContain("one Slack message in #frontend-approval-requests");
  expect(joined).toContain(mr);
  expect(joined.length).toBeLessThanOrEqual(200);
});

const gated = (clears: ReadonlyArray<string>) => Array.from(clears.join("; ")).length;
const times = (said: string, url: string) => said.split(url).length - 1;

test("every Clearance fits a 120-character repository URL, and names it exactly once", () => {
  const url = `https://gitlab.example.com/spilnu/frontend/platform/web-applications/${"a".repeat(51)}`;
  expect(url.length).toBe(120);
  const jobs = [
    "deploy-production",
    "deploy-production:spilnu",
    "deploy-production:happytiger",
  ].map((name, n) => ({ name, url: `${url}/-/jobs/${987654321 + n}` }));
  const measured = Object.entries(RELEASE_CLEARS).map(([step, clears]) => {
    const lines = clears(url, jobs);
    return [step, gated(lines) <= 400, times(lines.join("; "), url)];
  });
  expect(measured).toEqual(Object.keys(RELEASE_CLEARS).map((step) => [step, true, 1]));
});

test("production names its jobs with their URLs, then by name, then by count, whichever first fits", () => {
  const url = "https://gitlab.example.com/group/app";
  const job = (name: string, n: number) => ({ name, url: `${url}/-/jobs/${1000000 + n}` });

  const one = RELEASE_CLEARS.production(url, [job("deploy-production", 4)]).join("; ");
  expect(one).toContain(`\`deploy-production\` at ${url}/-/jobs/1000004`);

  const apps = ["bingo", "casino", "happytiger", "lobby", "playground", "poker", "spilnu"];
  const several = apps.map((app, n) => job(`deploy-production:${app}`, n));
  expect(several.map((one) => one.name + one.url).join("").length).toBeGreaterThan(400);
  const byName = RELEASE_CLEARS.production(url, several).join("; ");
  for (const app of apps) expect(byName).toContain(`\`deploy-production:${app}\``);
  expect(byName).not.toContain("/-/jobs/");

  const many = Array.from({ length: 30 }, (_, n) => job(`deploy-production:application-${n}`, n));
  const counted = RELEASE_CLEARS.production(url, many);
  expect(counted.join("; ")).toContain("the 30 production jobs its task names");
  expect(gated(counted)).toBeLessThanOrEqual(400);

  for (const said of [one, byName, counted.join("; ")]) {
    expect(said).toContain(` on ${url}, and no other job`);
  }
});
