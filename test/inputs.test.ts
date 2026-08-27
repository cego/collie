import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirmLine, inferInput, inferInputs } from "../src/inputs";
import { RunStore } from "../src/run";
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

test("plan-dir takes the newest finished run with a SPEC in this repo, else asks", async () => {
  const store = new RunStore(rig.stateDir);
  const ctxWithState = () => ({ cwd: rig.projectDir, stateDir: rig.stateDir });

  expect(await inferInput("plan", "plan-dir", ctxWithState())).toMatchObject({
    needsAsking: true,
    value: "",
  });

  const make = (slug: string, cwd: string, status: string, spec: boolean, created: string) => {
    const run = store.create({
      workflow: "plan",
      cwd,
      inputs: { goal: slug },
      inputSources: { goal: "asked" },
      stepIds: ["grill"],
      maxIterations: 5,
      primaryInput: slug,
    });
    run.record.status = status as "done";
    run.record.created_at = created;
    run.save();
    if (spec) {
      mkdirSync(join(run.dir, "plan"), { recursive: true });
      writeFileSync(join(run.dir, "plan", "SPEC.md"), "# spec\n");
    }
    return run;
  };

  make("other-repo", "/somewhere/else", "done", true, "2026-08-27T12:00:00.000Z");
  make("unfinished", rig.projectDir, "blocked", true, "2026-08-27T11:00:00.000Z");
  make("no-spec", rig.projectDir, "done", false, "2026-08-27T10:00:00.000Z");
  const older = make("older-goal", rig.projectDir, "done", true, "2026-08-27T08:00:00.000Z");
  const newest = make("newest-goal", rig.projectDir, "done", true, "2026-08-27T09:00:00.000Z");

  expect(await inferInput("plan", "plan-dir", ctxWithState())).toMatchObject({
    value: join(newest.dir, "plan"),
    source: `plan run ${newest.id}`,
    label: "newest-goal",
    needsAsking: false,
  });
  expect(older.record.slug).toBe("plan-older-goal");
});

test("issue takes a Linear id from the branch, else asks for the id or URL", async () => {
  bin.add("git", `echo feature/ENG-42-add-picker`);
  expect(await inferInput("goal", "issue", ctx())).toMatchObject({
    value: "ENG-42",
    source: "branch feature/ENG-42-add-picker",
    needsAsking: false,
  });

  bin.add("git", `echo master`);
  expect(await inferInput("goal", "issue", ctx())).toMatchObject({
    value: "",
    needsAsking: true,
    question: "Which Linear issue? (id or URL)",
  });
});
