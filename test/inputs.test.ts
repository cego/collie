import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyWorkSource,
  confirmLine,
  inferInput,
  inferInputs,
  inputValues,
  resolveWorkSource,
  workSourceCandidates,
} from "../src/inputs";
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

test("a work-source with exactly one candidate is inferred, kind and all", async () => {
  bin.add("git", `echo add-picker`);
  const store = new RunStore(rig.stateDir);
  const plan = makePlanRun(store, "newest-goal", rig.projectDir, "2026-08-27T09:00:00.000Z");

  const resolved = await inferInput("plan", "work-source", withState());

  expect(resolved).toMatchObject({
    value: join(plan.dir, "plan"),
    kind: "plan-dir",
    source: `plan run ${plan.id}`,
    label: "newest-goal",
    needsAsking: false,
  });
  expect(resolved.candidates).toBeUndefined();
  expect(confirmLine("implement", [resolved])).toContain(`[plan-dir · plan run ${plan.id}]`);
});

test("a Linear id in the branch is the one candidate when nothing has been planned", async () => {
  bin.add("git", `echo feature/ENG-42-add-picker`);

  expect(await inferInput("plan", "work-source", withState())).toMatchObject({
    value: "ENG-42",
    kind: "linear",
    source: "branch feature/ENG-42-add-picker",
    needsAsking: false,
  });
});

test("a work-source with no candidate has to be asked for", async () => {
  bin.add("git", `echo add-picker`);

  const resolved = await inferInput("plan", "work-source", withState());

  expect(resolved).toMatchObject({ value: "", needsAsking: true });
  expect(resolved.candidates).toEqual([]);
});

test("a work-source with several candidates offers all of them, newest plans first", async () => {
  bin.add("git", `echo feature/ENG-42-add-picker`);
  const store = new RunStore(rig.stateDir);
  makePlanRun(store, "oldest", rig.projectDir, "2026-08-27T06:00:00.000Z");
  makePlanRun(store, "fourth", rig.projectDir, "2026-08-27T07:00:00.000Z");
  makePlanRun(store, "third", rig.projectDir, "2026-08-27T08:00:00.000Z");
  makePlanRun(store, "second", rig.projectDir, "2026-08-27T09:00:00.000Z");
  makePlanRun(store, "first", rig.projectDir, "2026-08-27T10:00:00.000Z");

  const resolved = await inferInput("plan", "work-source", withState());

  expect(resolved.needsAsking).toBe(true);
  // Three newest plans at most, so an old run cannot bury the branch's ticket.
  expect(resolved.candidates?.map((c) => [c.kind, c.label ?? c.value])).toEqual([
    ["plan-dir", "first"],
    ["plan-dir", "second"],
    ["plan-dir", "third"],
    ["linear", "ENG-42"],
  ]);
});

test("candidates come back empty rather than throwing without a state dir", async () => {
  bin.add("git", `exit 1`);

  expect(await workSourceCandidates({ cwd: rig.projectDir })).toEqual([]);
});

test("what the human types is classified as a plan dir, a Linear issue or free text", () => {
  const spec = join(rig.projectDir, "plan");
  mkdirSync(spec, { recursive: true });
  writeFileSync(join(spec, "SPEC.md"), "# spec\n");

  expect(classifyWorkSource("ENG-42")).toMatchObject({ kind: "linear", value: "ENG-42" });
  expect(classifyWorkSource(" eng-42 ")).toMatchObject({ kind: "linear", value: "ENG-42" });
  expect(
    classifyWorkSource("https://linear.app/cego/issue/FRO-149/prmpt-modal-skal-rettes"),
  ).toMatchObject({ kind: "linear", value: "FRO-149" });
  expect(classifyWorkSource(spec)).toMatchObject({ kind: "plan-dir", value: spec });
  expect(classifyWorkSource("make the picker remember the last workflow")).toMatchObject({
    kind: "text",
    value: "make the picker remember the last workflow",
    label: "make-the-picker-remember",
  });
  // A path without a SPEC is not a plan dir, so it stays what it looks like: prose.
  expect(classifyWorkSource(join(rig.projectDir, "nope"))).toMatchObject({ kind: "text" });
});

test("the menu resolves a work-source to a candidate", async () => {
  bin.add("git", `echo feature/ENG-42-add-picker`);
  const store = new RunStore(rig.stateDir);
  const plan = makePlanRun(store, "newest-goal", rig.projectDir, "2026-08-27T09:00:00.000Z");
  const resolved = await inferInput("plan", "work-source", withState());

  const asked: string[] = [];
  const ok = await resolveWorkSource(resolved, {
    menu: async (items, opts) => {
      asked.push(opts.header);
      return items[0]!;
    },
    ask: async () => null,
  });

  expect(ok).toBe(true);
  expect(asked[0]).toContain("What should be built?");
  expect(resolved).toMatchObject({
    value: join(plan.dir, "plan"),
    kind: "plan-dir",
    source: `plan run ${plan.id}`,
    needsAsking: false,
  });
});

test("the menu always offers Type it…, and classifies what comes back", async () => {
  bin.add("git", `echo add-picker`);
  const resolved = await inferInput("plan", "work-source", withState());

  const titles: string[] = [];
  const ok = await resolveWorkSource(resolved, {
    menu: async (items) => {
      titles.push(...items.map((i) => i.title));
      return items.find((i) => i.id === "type")!;
    },
    ask: async () => "https://linear.app/cego/issue/FRO-149/prmpt-modal",
  });

  expect(ok).toBe(true);
  expect(titles).toEqual(["Type it…"]);
  expect(resolved).toMatchObject({ value: "FRO-149", kind: "linear", source: "typed" });
});

test("free text typed into the menu is kept as the work source", async () => {
  bin.add("git", `echo add-picker`);
  const resolved = await inferInput("plan", "work-source", withState());

  await resolveWorkSource(resolved, {
    menu: async (items) => items.find((i) => i.id === "type")!,
    ask: async () => "teach the picker to remember the last workflow",
  });

  expect(resolved).toMatchObject({
    value: "teach the picker to remember the last workflow",
    kind: "text",
    source: "typed",
  });
});

test("escaping the menu or the question leaves the work-source unresolved", async () => {
  bin.add("git", `echo add-picker`);

  const escaped = await inferInput("plan", "work-source", withState());
  expect(await resolveWorkSource(escaped, { menu: async () => null, ask: async () => "x" })).toBe(false);
  expect(escaped.value).toBe("");

  const blank = await inferInput("plan", "work-source", withState());
  expect(
    await resolveWorkSource(blank, {
      menu: async (items) => items.find((i) => i.id === "type")!,
      ask: async () => "   ",
    }),
  ).toBe(false);
  expect(blank.value).toBe("");
});

test("prompts see the resolved kind alongside the value", async () => {
  bin.add("git", `echo feature/ENG-42-add-picker`);

  const resolutions = await inferInputs({ plan: "work-source", post: "flag" }, withState());

  expect(inputValues(resolutions)).toEqual({ plan: "ENG-42", plan_kind: "linear", post: "false" });
});

function withState() {
  return { cwd: rig.projectDir, stateDir: rig.stateDir };
}

function makePlanRun(store: RunStore, slug: string, cwd: string, created: string) {
  const run = store.create({
    workflow: "plan",
    cwd,
    inputs: { goal: slug },
    inputSources: { goal: "asked" },
    stepIds: ["grill"],
    maxIterations: 5,
    primaryInput: slug,
  });
  run.record.status = "done";
  run.record.created_at = created;
  run.save();
  mkdirSync(join(run.dir, "plan"), { recursive: true });
  writeFileSync(join(run.dir, "plan", "SPEC.md"), "# spec\n");
  return run;
}
