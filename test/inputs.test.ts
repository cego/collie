import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirmLine, inferInput, inferInputs, newestPlan } from "../src/inputs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";

let rig: Rig;
let bin: FakeBin;

beforeEach(() => {
  rig = new Rig();
  bin = new FakeBin(join(rig.root, "bin"));
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const ctx = () => ({ cwd: rig.projectDir });

test("diff-target prefers the open merge request", async () => {
  bin.add("glab", `echo '{"iid": 42, "state": "opened", "title": "t"}'`);
  bin.add("git", `echo should-not-be-used; exit 1`);

  expect(await inferInput("target", "diff-target", ctx())).toMatchObject({
    value: "mr:42",
    source: "open merge request !42",
    needsAsking: false,
  });
});

test("diff-target falls back to the branch diff when there is no open merge request", async () => {
  bin.add("glab", `exit 1`);
  bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --abbrev-ref") echo feature/add-picker ;;
      "symbolic-ref --short") echo origin/main ;;
      *) exit 1 ;;
    esac`,
  );

  expect(await inferInput("target", "diff-target", ctx())).toMatchObject({
    value: "branch:main...feature/add-picker",
    source: "feature/add-picker vs main",
  });
});

test("diff-target skips a merge request that is no longer open", async () => {
  bin.add("glab", `echo '{"iid": 7, "state": "merged"}'`);
  bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --abbrev-ref") echo feature/x ;;
      "symbolic-ref --short") echo origin/master ;;
      *) exit 1 ;;
    esac`,
  );

  expect(await inferInput("target", "diff-target", ctx())).toMatchObject({
    value: "branch:master...feature/x",
  });
});

test("diff-target ends at the working tree on the default branch", async () => {
  bin.add("glab", `exit 1`);
  bin.add(
    "git",
    `case "$1 $2" in
      "rev-parse --abbrev-ref") echo main ;;
      "symbolic-ref --short") echo origin/main ;;
      *) exit 1 ;;
    esac`,
  );

  expect(await inferInput("target", "diff-target", ctx())).toMatchObject({
    value: "worktree",
    source: "working tree",
    needsAsking: false,
  });
});

test("diff-target finds the base by name when origin/HEAD is missing", async () => {
  bin.add("glab", `exit 1`);
  bin.add(
    "git",
    `case "$*" in
      "rev-parse --abbrev-ref HEAD") echo topic ;;
      "symbolic-ref --short refs/remotes/origin/HEAD") exit 1 ;;
      "rev-parse --verify --quiet main") exit 1 ;;
      "rev-parse --verify --quiet master") echo abc123 ;;
      *) exit 1 ;;
    esac`,
  );

  expect(await inferInput("target", "diff-target", ctx())).toMatchObject({
    value: "branch:master...topic",
  });
});

test("a missing glab or git does not throw", async () => {
  expect(await inferInput("target", "diff-target", { cwd: rig.projectDir })).toMatchObject({
    value: "worktree",
  });
});

test("plan-file takes the newest tasks/**/PLAN.md, else asks", async () => {
  expect(await inferInput("plan", "plan-file", ctx())).toMatchObject({
    needsAsking: true,
    question: "Path to the plan file (no tasks/**/PLAN.md found)",
  });

  mkdirSync(join(rig.projectDir, "tasks", "old"), { recursive: true });
  mkdirSync(join(rig.projectDir, "tasks", "new"), { recursive: true });
  writeFileSync(join(rig.projectDir, "tasks", "old", "PLAN.md"), "old");
  writeFileSync(join(rig.projectDir, "tasks", "new", "PLAN.md"), "new");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(rig.projectDir, "tasks", "old", "PLAN.md"), past, past);

  expect(newestPlan(rig.projectDir)).toBe("tasks/new/PLAN.md");
  expect(await inferInput("plan", "plan-file", ctx())).toMatchObject({
    value: "tasks/new/PLAN.md",
    source: "newest tasks/new/PLAN.md",
    needsAsking: false,
  });
});

test("ticket comes from the branch name and is optional", async () => {
  bin.add("git", `echo feature/ABC-123-add-picker`);
  expect(await inferInput("ticket", "ticket", ctx())).toMatchObject({
    value: "ABC-123",
    source: "branch feature/ABC-123-add-picker",
    needsAsking: false,
  });

  bin.add("git", `echo add-picker`);
  expect(await inferInput("ticket", "ticket", ctx())).toMatchObject({
    value: "",
    source: "none",
    needsAsking: false,
  });
});

test("goal is always asked and a flag always defaults to false", async () => {
  expect(await inferInput("goal", "goal", ctx())).toMatchObject({
    needsAsking: true,
    question: "What is the goal?",
  });
  expect(await inferInput("post", "flag", ctx())).toMatchObject({
    value: "false",
    source: "default",
    needsAsking: false,
  });
});

test("the confirm line shows every input with where it came from", async () => {
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);

  const resolutions = await inferInputs({ target: "diff-target", post: "flag" }, ctx());

  expect(confirmLine("review", resolutions)).toBe(
    "review: target=worktree [working tree]  post=false [default]",
  );
});
