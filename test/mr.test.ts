import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitlabReadiness, linearIssues, mrFacts, resolveAssignee, templateFile, MR_TEMPLATE } from "../src/mr";
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
