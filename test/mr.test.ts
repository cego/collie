import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MR_TEMPLATE,
  gitlabForProject,
  gitlabReadiness,
  hostOf,
  linearIssues,
  mrFacts,
  mrTarget,
  parseMrTarget,
  projectFromRemote,
  repoArgs,
  resolveAssignee,
  templateFile,
} from "../src/mr";
import { RunStore } from "../src/run";
import { Rig } from "./support/recorder";

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.close();
});

/** A scripted shell, so these tests never touch a real glab or git. */
function runner(table: Record<string, { code?: number; stdout?: string }>) {
  return async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    const hit = table[key] ?? table[`${cmd} ${args[0]}`];
    return { code: hit?.code ?? (hit ? 0 : 1), stdout: hit?.stdout ?? "" };
  };
}

test("GitLab is ready only with glab installed and a GitLab remote", async () => {
  const ok = runner({
    "glab --version": { stdout: "glab 1.40" },
    "git remote -v": { stdout: "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)\n" },
  });
  expect(await gitlabReadiness(rig.projectDir, ok)).toEqual({ ok: true, reason: "" });

  const noGlab = runner({ "git remote -v": { stdout: "origin\tgit@gitlab.cego.dk:x.git (fetch)\n" } });
  expect(await gitlabReadiness(rig.projectDir, noGlab)).toMatchObject({ ok: false, reason: "glab is not installed" });

  const noRemote = runner({ "glab --version": { stdout: "glab 1.40" }, "git remote -v": { stdout: "" } });
  expect(await gitlabReadiness(rig.projectDir, noRemote)).toMatchObject({ ok: false, reason: "this repo has no remote" });

  const elsewhere = runner({
    "glab --version": { stdout: "glab 1.40" },
    "git remote -v": { stdout: "origin\tgit@github.com:someone/x.git (fetch)\n" },
  });
  expect(await gitlabReadiness(rig.projectDir, elsewhere)).toMatchObject({ ok: false, reason: "no GitLab remote" });
});

test("the assignee is the configured one, else whoever glab is logged in as", async () => {
  const glab = runner({ "glab api user": { stdout: '{"username": "mk", "name": "Mads"}' } });

  expect(await resolveAssignee(rig.projectDir, "someone-else", glab)).toBe("someone-else");
  expect(await resolveAssignee(rig.projectDir, "  ", glab)).toBe("mk");
  expect(await resolveAssignee(rig.projectDir, undefined, glab)).toBe("mk");
  // Not logged in, and nothing configured: say so rather than guess a username.
  expect(await resolveAssignee(rig.projectDir, undefined, runner({}))).toBeNull();
});

test("the repo's own MR template is found when it has one", () => {
  expect(templateFile(rig.projectDir)).toBeNull();
  mkdirSync(join(rig.projectDir, ".gitlab", "merge_request_templates"), { recursive: true });
  writeFileSync(join(rig.projectDir, MR_TEMPLATE.replace(/\//g, "/")), "## Description\n");
  expect(templateFile(rig.projectDir)).toBe(MR_TEMPLATE);
});

test("Linear ids come from the work source, the branch and the plan run, deduplicated", async () => {
  const store = new RunStore(rig.stateDir);
  const plan = store.create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 5,
    primaryInput: "goal",
  });
  const choice = join(plan.dir, "steps", "next", "offload-to-linear-1");
  mkdirSync(choice, { recursive: true });
  writeFileSync(join(choice, "next.json"), JSON.stringify({ verdict: "clean", issue: "ENG-42", url: "u" }));
  const planDir = join(plan.dir, "plan");

  const git = runner({ "git rev-parse --abbrev-ref HEAD": { stdout: "feature/FRO-149-modal\n" } });

  // A plan dir contributes what the plan offloaded; the branch contributes its own.
  expect(
    await linearIssues(
      { cwd: rig.projectDir, inputs: { plan: planDir, plan_kind: "plan-dir" } },
      git,
    ),
  ).toEqual(["FRO-149", "ENG-42"]);

  // A linear work source contributes itself, and is not repeated by the branch.
  expect(
    await linearIssues(
      { cwd: rig.projectDir, inputs: { plan: "FRO-149", plan_kind: "linear" } },
      git,
    ),
  ).toEqual(["FRO-149"]);

  // Free text names no ticket, so only the branch does.
  expect(
    await linearIssues({ cwd: rig.projectDir, inputs: { plan: "make it nicer", plan_kind: "text" } }, git),
  ).toEqual(["FRO-149"]);
});

test("a branch with no ticket and a plan that offloaded nothing yields no ids", async () => {
  const git = runner({ "git rev-parse --abbrev-ref HEAD": { stdout: "add-a-picker\n" } });
  expect(await linearIssues({ cwd: rig.projectDir, inputs: {} }, git)).toEqual([]);
});

test("mrFacts gathers the three things the prompt needs in one go", async () => {
  const run = runner({
    "glab api user": { stdout: '{"username": "mk"}' },
    "git rev-parse --abbrev-ref HEAD": { stdout: "FRO-149-modal\n" },
  });

  expect(await mrFacts({ cwd: rig.projectDir, inputs: {} }, run)).toEqual({
    assignee: "mk",
    template: null,
    issues: ["FRO-149"],
  });
});

test("an MR target carries host, group and project, and reads back", () => {
  expect(mrTarget("gitlab.cego.dk/cego/herdr-plugin", "42")).toBe("mr:gitlab.cego.dk/cego/herdr-plugin!42");
  expect(parseMrTarget("mr:gitlab.cego.dk/cego/herdr-plugin!42")).toEqual({
    project: "gitlab.cego.dk/cego/herdr-plugin",
    iid: "42",
  });
  // The shape that came before, still understood: an iid in whatever repo you are in.
  expect(mrTarget(null, "42")).toBe("mr:42");
  expect(parseMrTarget("mr:42")).toEqual({ project: null, iid: "42" });
  // Anything that is not an MR target, and anything malformed, is not one.
  expect(parseMrTarget("worktree")).toBeNull();
  expect(parseMrTarget("branch:main...x")).toBeNull();
  expect(parseMrTarget("mr:cego/x!")).toBeNull();
  expect(parseMrTarget("mr:cego/x")).toBeNull();

  expect(repoArgs("cego/x")).toEqual(["--repo", "cego/x"]);
  expect(repoArgs(null)).toEqual([]);
  expect(hostOf("gitlab.cego.dk/cego/x")).toBe("gitlab.cego.dk");
  expect(hostOf("cego/x")).toBeNull();
  expect(hostOf(null)).toBeNull();
});

test("a project is read out of either remote shape", () => {
  const want = "gitlab.cego.dk/cego/herdr-plugin";
  expect(projectFromRemote("git@gitlab.cego.dk:cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("https://gitlab.cego.dk/cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("https://gitlab.cego.dk/cego/herdr-plugin")).toBe(want);
  expect(projectFromRemote("ssh://git@gitlab.cego.dk/cego/herdr-plugin.git")).toBe(want);
  expect(projectFromRemote("git@gitlab.cego.dk:cego/sub/deep.git")).toBe("gitlab.cego.dk/cego/sub/deep");
  // Not a remote this plugin can name a project from.
  expect(projectFromRemote("")).toBeNull();
  expect(projectFromRemote("/srv/git/bare.git")).toBeNull();
});

test("a step pointed at a project needs glab logged in to that host, not a checkout", async () => {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "glab" && args[0] === "--version") return { code: 0, stdout: "glab 1.0" };
    if (cmd === "glab" && args[0] === "auth") return { code: 0, stdout: "logged in" };
    // No git remotes here at all: the point is that it is never asked.
    return { code: 1, stdout: "" };
  };

  const ready = await gitlabForProject("gitlab.cego.dk/cego/x", "/not/a/repo", run);

  expect(ready.ok).toBe(true);
  expect(calls).toEqual([
    ["glab", "--version"],
    ["glab", "auth", "status", "--hostname", "gitlab.cego.dk"],
  ]);
});

test("not logged in to that host says so, and no project falls back to the checkout", async () => {
  const run = async (cmd: string, args: string[]) => {
    if (cmd === "glab" && args[0] === "--version") return { code: 0, stdout: "glab 1.0" };
    if (cmd === "glab" && args[0] === "auth") return { code: 1, stdout: "" };
    return { code: 1, stdout: "" };
  };

  expect((await gitlabForProject("gitlab.cego.dk/cego/x", "/x", run)).reason).toBe(
    "glab is not logged in to gitlab.cego.dk",
  );
  // A target with no project can only be judged by the directory, as before.
  expect((await gitlabForProject(null, "/x", run)).reason).toBe("this repo has no remote");
});
