import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import {
  classifyGivenTarget,
  reviewedTargets,
  targetKind,
  classifyTarget,
  classifyWorkSource,
  confirmLine,
  inferInput,
  inferInputs,
  inputValues,
  resolveCandidates,
  targetCandidates,
  workSourceCandidates,
} from "../src/inputs";
import { Run, RunStore, type RunRecord, type RunStatus } from "../src/run";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";

let rig: Rig;
let bin: FakeBin;

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const mkdir = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }));
const writeFile = (path: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      bin = yield* FakeBin.make(join(rig.root, "bin"));
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const ctx = () => ({ cwd: rig.projectDir });

test("diff-target prefers the open merge request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo '{"iid": 42, "state": "opened", "title": "t"}'`);
      yield* bin.add("git", `echo should-not-be-used; exit 1`);

      expect(yield* inferInput("target", "diff-target", ctx())).toMatchObject({
        value: "mr:42",
        source: "open merge request !42",
        needsAsking: false,
      });
    }),
  ));

test("diff-target falls back to the branch diff when there is no open merge request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref") echo feature/add-picker ;;
      "symbolic-ref --short") echo origin/main ;;
      *) exit 1 ;;
    esac`,
      );

      expect(yield* inferInput("target", "diff-target", ctx())).toMatchObject({
        value: "branch:main...feature/add-picker",
        source: "feature/add-picker vs main",
      });
    }),
  ));

test("diff-target skips a merge request that is no longer open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo '{"iid": 7, "state": "merged"}'`);
      yield* bin.add(
        "git",
        `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref") echo feature/x ;;
      "symbolic-ref --short") echo origin/master ;;
      *) exit 1 ;;
    esac`,
      );

      expect(yield* inferInput("target", "diff-target", ctx())).toMatchObject({
        value: "branch:master...feature/x",
      });
    }),
  ));

test("diff-target ends at the working tree on the default branch", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref") echo main ;;
      "symbolic-ref --short") echo origin/main ;;
      *) exit 1 ;;
    esac`,
      );

      expect(yield* inferInput("target", "diff-target", ctx())).toMatchObject({
        value: "worktree",
        source: "working tree",
        needsAsking: false,
      });
    }),
  ));

test("diff-target finds the base by name when origin/HEAD is missing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$*" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref HEAD") echo topic ;;
      "symbolic-ref --short refs/remotes/origin/HEAD") exit 1 ;;
      "rev-parse --verify --quiet main") exit 1 ;;
      "rev-parse --verify --quiet master") echo abc123 ;;
      *) exit 1 ;;
    esac`,
      );

      expect(yield* inferInput("target", "diff-target", ctx())).toMatchObject({
        value: "branch:master...topic",
      });
    }),
  ));

test("no glab and no git leaves nothing to infer, so the human types it", () =>
  runEffect(
    Effect.gen(function* () {
      // Also the non-repo case: a directory that is not a checkout has no branch and
      // no working tree to review, so the menu is one entry — Type it….
      expect(yield* inferInput("target", "diff-target", { cwd: rig.projectDir })).toMatchObject({
        value: "",
        source: "ask",
        needsAsking: true,
        candidates: [],
      });
    }),
  ));

test("ticket comes from the branch name and is optional", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo feature/ABC-123-add-picker`);
      expect(yield* inferInput("ticket", "ticket", ctx())).toMatchObject({
        value: "ABC-123",
        source: "branch feature/ABC-123-add-picker",
        needsAsking: false,
      });

      yield* bin.add("git", `echo add-picker`);
      expect(yield* inferInput("ticket", "ticket", ctx())).toMatchObject({
        value: "",
        source: "none",
        needsAsking: false,
      });
    }),
  ));

test("goal is always asked and a flag always defaults to false", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* inferInput("goal", "goal", ctx())).toMatchObject({
        needsAsking: true,
        question: "What is the goal?",
      });
      expect(yield* inferInput("post", "flag", ctx())).toMatchObject({
        value: "false",
        source: "default",
        needsAsking: false,
      });
    }),
  ));

test("the confirm line shows every input with where it came from", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);

      const resolutions = yield* inferInputs({ target: "diff-target", post: "flag" }, ctx());

      expect(confirmLine("review", resolutions)).toBe(
        "review: target=worktree [working tree]  post=false [default]",
      );
      // A mutating run's branch is decided the same way its Inputs are, and is the
      // one thing the line did not say.
      expect(
        confirmLine("implement", resolutions, { name: "wide-scope", source: "from target" }),
      ).toContain("branch=wide-scope [from target]");
    }),
  ));

test("plan-dir takes the newest finished run with a SPEC in this repo, else asks", () =>
  runEffect(
    Effect.gen(function* () {
      const ctxWithState = () => ({ cwd: rig.projectDir, stateDir: rig.stateDir });

      expect(yield* inferInput("plan", "plan-dir", ctxWithState())).toMatchObject({
        needsAsking: true,
        value: "",
      });

      const make = (slug: string, cwd: string, status: RunStatus, spec: boolean, created: string) =>
        makePlanRun(slug, cwd, created, status, spec);

      yield* make("other-repo", "/somewhere/else", "done", true, "2026-08-27T12:00:00.000Z");
      yield* make("unfinished", rig.projectDir, "blocked", true, "2026-08-27T11:00:00.000Z");
      yield* make("no-spec", rig.projectDir, "done", false, "2026-08-27T10:00:00.000Z");
      const older = yield* make(
        "older-goal",
        rig.projectDir,
        "done",
        true,
        "2026-08-27T08:00:00.000Z",
      );
      const newest = yield* make(
        "newest-goal",
        rig.projectDir,
        "done",
        true,
        "2026-08-27T09:00:00.000Z",
      );

      expect(yield* inferInput("plan", "plan-dir", ctxWithState())).toMatchObject({
        value: join(newest.dir, "plan"),
        source: `plan run ${newest.id}`,
        label: "newest-goal",
        needsAsking: false,
      });
      expect(older.record.slug).toBe("plan-older-goal");
    }),
  ));

test("a work-source with exactly one candidate is inferred, kind and all", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo add-picker`);
      const plan = yield* makePlanRun("newest-goal", rig.projectDir, "2026-08-27T09:00:00.000Z");

      const resolved = yield* inferInput("plan", "work-source", withState());

      expect(resolved).toMatchObject({
        value: join(plan.dir, "plan"),
        kind: "plan-dir",
        source: `plan run ${plan.id}`,
        label: "newest-goal",
        needsAsking: false,
      });
      expect(resolved.candidates).toBeUndefined();
      expect(confirmLine("implement", [resolved])).toContain(`[plan-dir · plan run ${plan.id}]`);
    }),
  ));

test("a Linear id in the branch is the one candidate when nothing has been planned", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo feature/ENG-42-add-picker`);

      expect(yield* inferInput("plan", "work-source", withState())).toMatchObject({
        value: "ENG-42",
        kind: "linear",
        source: "branch feature/ENG-42-add-picker",
        needsAsking: false,
      });
    }),
  ));

test("a work-source with no candidate has to be asked for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo add-picker`);

      const resolved = yield* inferInput("plan", "work-source", withState());

      expect(resolved).toMatchObject({ value: "", needsAsking: true });
      expect(resolved.candidates).toEqual([]);
    }),
  ));

test("a work-source with several candidates offers all of them, newest plans first", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo feature/ENG-42-add-picker`);
      yield* makePlanRun("oldest", rig.projectDir, "2026-08-27T06:00:00.000Z");
      yield* makePlanRun("fourth", rig.projectDir, "2026-08-27T07:00:00.000Z");
      yield* makePlanRun("third", rig.projectDir, "2026-08-27T08:00:00.000Z");
      yield* makePlanRun("second", rig.projectDir, "2026-08-27T09:00:00.000Z");
      yield* makePlanRun("first", rig.projectDir, "2026-08-27T10:00:00.000Z");

      const resolved = yield* inferInput("plan", "work-source", withState());

      expect(resolved.needsAsking).toBe(true);
      // Three newest plans at most, so an old run cannot bury the branch's ticket.
      expect(resolved.candidates?.map((c) => [c.kind, c.label ?? c.value])).toEqual([
        ["plan-dir", "first"],
        ["plan-dir", "second"],
        ["plan-dir", "third"],
        ["linear", "ENG-42"],
      ]);
    }),
  ));

test("candidates come back empty rather than throwing without a state dir", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `exit 1`);

      expect(yield* workSourceCandidates({ cwd: rig.projectDir })).toEqual([]);
    }),
  ));

test("what the human types is classified as a plan dir, a Linear issue or free text", () =>
  runEffect(
    Effect.gen(function* () {
      const spec = join(rig.projectDir, "plan");
      yield* mkdir(spec);
      yield* writeFile(join(spec, "SPEC.md"), "# spec\n");

      expect(yield* classifyWorkSource("ENG-42")).toMatchObject({
        kind: "linear",
        value: "ENG-42",
      });
      expect(yield* classifyWorkSource(" eng-42 ")).toMatchObject({
        kind: "linear",
        value: "ENG-42",
      });
      expect(
        yield* classifyWorkSource("https://linear.app/cego/issue/FRO-149/prmpt-modal-skal-rettes"),
      ).toMatchObject({ kind: "linear", value: "FRO-149" });
      expect(yield* classifyWorkSource(spec)).toMatchObject({ kind: "plan-dir", value: spec });
      expect(yield* classifyWorkSource("make the picker remember the last workflow")).toMatchObject(
        {
          kind: "text",
          value: "make the picker remember the last workflow",
          label: "make-the-picker-remember",
        },
      );
      // A path without a SPEC is not a plan dir, so it stays what it looks like: prose.
      expect(yield* classifyWorkSource(join(rig.projectDir, "nope"))).toMatchObject({
        kind: "text",
      });
    }),
  ));

test("the menu resolves a work-source to a candidate", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo feature/ENG-42-add-picker`);
      const plan = yield* makePlanRun("newest-goal", rig.projectDir, "2026-08-27T09:00:00.000Z");
      const resolved = yield* inferInput("plan", "work-source", withState());

      const asked: string[] = [];
      const ok = yield* resolveCandidates(resolved, {
        menu: (items, opts) => {
          asked.push(opts.header);
          return Effect.succeed(items[0]!);
        },
        ask: () => Effect.succeed(null),
      });

      expect(ok).toBe(true);
      expect(asked[0]).toContain("What should be built?");
      expect(resolved).toMatchObject({
        value: join(plan.dir, "plan"),
        kind: "plan-dir",
        source: `plan run ${plan.id}`,
        needsAsking: false,
      });
    }),
  ));

test("the menu always offers Type it…, and classifies what comes back", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo add-picker`);
      const resolved = yield* inferInput("plan", "work-source", withState());

      const titles: string[] = [];
      const ok = yield* resolveCandidates(resolved, {
        menu: (items) => {
          titles.push(...items.map((i) => i.title));
          return Effect.succeed(items.find((i) => i.id === "type")!);
        },
        ask: () => Effect.succeed("https://linear.app/cego/issue/FRO-149/prmpt-modal"),
      });

      expect(ok).toBe(true);
      expect(titles).toEqual(["Type it…"]);
      expect(resolved).toMatchObject({ value: "FRO-149", kind: "linear", source: "typed" });
    }),
  ));

test("free text typed into the menu is kept as the work source", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo add-picker`);
      const resolved = yield* inferInput("plan", "work-source", withState());

      yield* resolveCandidates(resolved, {
        menu: (items) => Effect.succeed(items.find((i) => i.id === "type")!),
        ask: () => Effect.succeed("teach the picker to remember the last workflow"),
      });

      expect(resolved).toMatchObject({
        value: "teach the picker to remember the last workflow",
        kind: "text",
        source: "typed",
      });
    }),
  ));

test("escaping the menu or the question leaves the work-source unresolved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo add-picker`);

      const escaped = yield* inferInput("plan", "work-source", withState());
      expect(
        yield* resolveCandidates(escaped, {
          menu: () => Effect.succeed(null),
          ask: () => Effect.succeed("x"),
        }),
      ).toBe(false);
      expect(escaped.value).toBe("");

      const blank = yield* inferInput("plan", "work-source", withState());
      expect(
        yield* resolveCandidates(blank, {
          menu: (items) => Effect.succeed(items.find((i) => i.id === "type")!),
          ask: () => Effect.succeed("   "),
        }),
      ).toBe(false);
      expect(blank.value).toBe("");
    }),
  ));

test("prompts see the resolved kind alongside the value", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", `echo feature/ENG-42-add-picker`);

      const resolutions = yield* inferInputs({ plan: "work-source", post: "flag" }, withState());

      expect(inputValues(resolutions)).toEqual({
        plan: "ENG-42",
        plan_kind: "linear",
        post: "false",
      });
    }),
  ));

function withState() {
  return { cwd: rig.projectDir, stateDir: rig.stateDir };
}

/**
 * A finished `plan` Run on disk. It is written as a whole record rather than the few
 * fields this suite reads, because RunStore decodes `run.json` and a partial file is
 * a broken Run, not an old one.
 */
function makePlanRun(
  slug: string,
  cwd: string,
  created: string,
  status: RunStatus = "done",
  spec = true,
  extra: Partial<RunRecord> = {},
) {
  return Effect.gen(function* () {
    const id = slug;
    const dir = join(rig.stateDir, "runs", id);
    const record: RunRecord = {
      id,
      seq: 1,
      slug: `plan-${slug}`,
      named_after: slug,
      workflow: "plan",
      worktree: null,
      decisions: {},
      previous_review: null,
      definition: null,
      approved_verifications: [],
      outcome: null,
      evidence_gaps: [],
      obstacle: null,
      halt: null,
      blocking_seen: null,
      unreviewed: null,
      notified: [],
      fixed: 0,
      unpushed: null,
      cwd,
      session: null,
      workspace: null,
      task: null,
      workspace_label: null,
      workspace_worktree: null,
      activated_cwd: null,
      created_at: created,
      finished_at: status === "done" ? created : null,
      status,
      iteration: 1,
      max_iterations: 1,
      inputs: {},
      input_sources: {},
      steps: [],
      parent: null,
      children: [],
      choices: [],
      awaiting: null,
      fanout: null,
      handoffs: [],
      disputed: [],
      deferred: [],
      outstanding: [],
      target_label: null,
      synthesis: null,
      mr_url: null,
      linear_issues: [],
      helle: null,
      held: null,
      summary: null,
      ...extra,
    };
    yield* mkdir(dir);
    // Saved the way a Driver saves, so the fixture cannot drift from the real shape.
    yield* new Run(dir, record).save();
    if (spec) {
      yield* mkdir(join(dir, "plan"));
      yield* writeFile(join(dir, "plan", "SPEC.md"), "# spec\n");
    }
    return { id, dir, record };
  });
}

// --- 10: the human chooses the review target ------------------------------

/** git that answers the three questions diff-target asks, with a dirty tree. */
function gitOn(branch: string, base = "origin/main", porcelain = " M src/x.ts") {
  return `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref") echo ${branch} ;;
      "symbolic-ref --short") echo ${base} ;;
      "status --porcelain") echo "${porcelain}" ;;
      *) exit 1 ;;
    esac`;
}

test("diff-target offers the MR, the branch and the working tree, inference first", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo '{"iid": 42, "state": "opened", "title": "t"}'`);
      yield* bin.add("git", gitOn("add-picker"));

      const resolved = yield* inferInput("target", "diff-target", ctx());

      // The head of the list is what inference alone would have picked, so Enter keeps it.
      expect(resolved.value).toBe("mr:42");
      expect(resolved.kind).toBe("mr");
      expect(resolved.candidates?.map((c) => [c.kind, c.value])).toEqual([
        ["mr", "mr:42"],
        ["branch", "branch:main...add-picker"],
        ["worktree", "worktree"],
      ]);
    }),
  ));

test("with no MR for this branch, my own open MRs are offered instead", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add(
        "glab",
        `case "$2" in
      view) exit 1 ;;
      list) case "$3" in
        --assignee) echo '[{"iid": 7, "title": "mine to review"}]' ;;
        --author) echo '[{"iid": 7, "title": "mine to review"}, {"iid": 9, "title": "also mine"}]' ;;
      esac ;;
    esac`,
      );
      yield* bin.add("git", gitOn("add-picker"));

      const resolved = yield* inferInput("target", "diff-target", ctx());

      // Deduplicated across assignee and author, and never ahead of the branch itself.
      expect(resolved.candidates?.map((c) => [c.kind, c.value])).toEqual([
        ["mr", "mr:7"],
        ["mr", "mr:9"],
        ["branch", "branch:main...add-picker"],
        ["worktree", "worktree"],
      ]);
      expect(resolved.value).toBe("mr:7");
    }),
  ));

test("a clean tree on the default branch still offers the working tree", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", gitOn("main", "origin/main", ""));

      const resolved = yield* inferInput("target", "diff-target", ctx());

      expect(resolved.candidates?.map((c) => c.kind)).toEqual(["worktree"]);
      expect(resolved.value).toBe("worktree");
    }),
  ));

test("what the human types is classified as an MR, a range or a branch", () => {
  // A bare iid means one in the project the directory belongs to, and carries it.
  expect(classifyTarget("42", "main", "gitlab.example.com/g/p")).toMatchObject({
    kind: "mr",
    value: "mr:gitlab.example.com/g/p!42",
    label: "!42",
  });
  // With no project to resolve against it stays the shape it always was.
  expect(classifyTarget("!42", "main")).toMatchObject({ kind: "mr", value: "mr:42", label: "!42" });
  // A URL names its own project, whatever directory it was pasted in.
  expect(
    classifyTarget(
      "https://gitlab.cego.dk/cego/herdr-plugin/-/merge_requests/128",
      "main",
      "other/g/p",
    ),
  ).toMatchObject({ kind: "mr", value: "mr:gitlab.cego.dk/cego/herdr-plugin!128", label: "!128" });
  // Subgroups are part of the path.
  expect(
    classifyTarget("https://gitlab.cego.dk/cego/sub/deep/-/merge_requests/9", "main"),
  ).toMatchObject({ value: "mr:gitlab.cego.dk/cego/sub/deep!9", label: "!9" });
  expect(classifyTarget("main...add-picker", "main")).toMatchObject({
    kind: "branch",
    value: "branch:main...add-picker",
  });
  expect(classifyTarget("worktree", "main")).toMatchObject({ kind: "worktree", value: "worktree" });
  // A bare ref means that ref against the default base, which is what a branch target is.
  expect(classifyTarget("add-picker", "main")).toMatchObject({
    kind: "branch",
    value: "branch:main...add-picker",
  });
  expect(classifyTarget("   ", "main")).toBeNull();
});

test("a diff-target given on the command line is normalised, not just shaped", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("git", gitOn("add-picker"));

      // A URL used to fall through to `worktree`, which left `{{target_repo}}` empty.
      const url = yield* classifyGivenTarget(
        "https://gitlab.cego.dk/cego/collie/-/merge_requests/2",
        ctx(),
      );
      expect(url).toMatchObject({ kind: "mr", value: "mr:gitlab.cego.dk/cego/collie!2" });

      expect(yield* classifyGivenTarget("worktree", ctx())).toMatchObject({ kind: "worktree" });
      // An already-normalised target passes through rather than being nested.
      expect(yield* classifyGivenTarget("branch:main...x", ctx())).toMatchObject({
        kind: "branch",
        value: "branch:main...x",
      });
      expect(yield* classifyGivenTarget("mr:12", ctx())).toMatchObject({
        kind: "mr",
        value: "mr:12",
      });
      // Free-form still gets the menu's classification.
      expect(yield* classifyGivenTarget("add-picker", ctx())).toMatchObject({
        kind: "branch",
        value: "branch:main...add-picker",
      });
    }),
  ));

test("the target menu always shows, and Type it… classifies what comes back", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", gitOn("add-picker"));
      const resolved = yield* inferInput("target", "diff-target", ctx());

      const titles: string[] = [];
      const ok = yield* resolveCandidates(resolved, {
        menu: (items, opts) => {
          titles.push(...items.map((i) => i.title));
          expect(opts.header).toContain("Review what?");
          return Effect.succeed(items.find((i) => i.id === "type")!);
        },
        ask: () => Effect.succeed("!128"),
      });

      expect(ok).toBe(true);
      expect(titles).toEqual(["add-picker", "working tree", "Type it…"]);
      expect(resolved).toMatchObject({ value: "mr:128", kind: "mr", source: "typed" });
    }),
  ));

test("picking the top of the target menu reproduces plain inference", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", gitOn("add-picker"));
      const resolved = yield* inferInput("target", "diff-target", ctx());
      const inferredValue = resolved.value;

      const ok = yield* resolveCandidates(resolved, {
        menu: (items) => Effect.succeed(items[0]!),
        ask: () => Effect.succeed(null),
      });

      expect(ok).toBe(true);
      expect(resolved.value).toBe(inferredValue);
      expect(resolved.value).toBe("branch:main...add-picker");
    }),
  ));

test("escaping the target menu leaves the run unstarted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", gitOn("add-picker"));
      const resolved = yield* inferInput("target", "diff-target", ctx());

      expect(
        yield* resolveCandidates(resolved, {
          menu: () => Effect.succeed(null),
          ask: () => Effect.succeed("x"),
        }),
      ).toBe(false);
    }),
  ));

test("targetCandidates offers nothing outside a checkout, and does not throw", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `exit 1`);

      // No checkout means no branch and no working tree; the menu is Type it… alone.
      expect(yield* targetCandidates(ctx())).toEqual([]);
    }),
  ));

test("an MR candidate carries the project its checkout pushes to", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo '{"iid": 42, "state": "opened", "title": "t"}'`);
      yield* bin.add(
        "git",
        `case "$*" in
      "rev-parse --git-dir") echo .git ;;
      "remote get-url origin") echo git@gitlab.cego.dk:cego/herdr-plugin.git ;;
      *) exit 1 ;;
    esac`,
      );

      const [mr] = yield* targetCandidates(ctx());
      expect(mr).toMatchObject({
        kind: "mr",
        value: "mr:gitlab.cego.dk/cego/herdr-plugin!42",
        label: "!42",
      });
      // And the label a tab would show is still just the iid.
      expect(mr!.label).toBe("!42");
    }),
  ));

test("the targets this repo has already reviewed are offered without pasting them", () =>
  runEffect(
    Effect.gen(function* () {
      const reviewed = (slug: string, target: string, created: string, cwd = rig.projectDir) =>
        makePlanRun(slug, cwd, created, "done", false, {
          workflow: "review",
          slug: `review-${slug}`,
          inputs: { target, target_kind: targetKind(target) },
          target_label: null,
          synthesis: "steps/synthesize/synthesized.json",
        });
      yield* reviewed("old", "mr:gitlab/x!7", "2026-08-01T10:00:00Z");
      yield* reviewed("new", "branch:main...feature", "2026-08-30T10:00:00Z");
      // Same target twice keeps the newest, and another repo's runs never appear.
      yield* reviewed("again", "mr:gitlab/x!7", "2026-08-31T10:00:00Z");
      yield* reviewed("elsewhere", "mr:other!1", "2026-08-31T11:00:00Z", "/somewhere/else");

      const remembered = yield* reviewedTargets(rig.stateDir, rig.projectDir, 5);

      expect(remembered.map((c) => [c.value, c.kind])).toEqual([
        ["mr:gitlab/x!7", "mr"],
        ["branch:main...feature", "branch"],
      ]);
      expect(remembered[0]!.source).toContain("reviewed");

      // And they come after what inference offers, never in front of it.
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", gitOn("add-picker"));
      const candidates = yield* targetCandidates({ cwd: rig.projectDir, stateDir: rig.stateDir });
      const values = candidates.map((c) => c.value);
      expect(values.indexOf("mr:gitlab/x!7")).toBeGreaterThan(values.indexOf("worktree"));
      // Already offered by inference, so not offered twice.
      expect(values.filter((v) => v === "branch:main...feature")).toHaveLength(1);
    }),
  ));

test("the newest finished review of this target is the one a re-review is given", () =>
  runEffect(
    Effect.gen(function* () {
      const reviewed = (
        slug: string,
        created: string,
        status: RunStatus,
        synthesis: string | null,
      ) =>
        makePlanRun(slug, rig.projectDir, created, status, false, {
          workflow: "review",
          slug: `review-${slug}`,
          inputs: { target: "mr:gitlab/x!7", target_kind: "mr" },
          synthesis,
        });
      yield* reviewed("first", "2026-08-01T10:00:00Z", "done", "s.json");
      yield* reviewed("second", "2026-08-20T10:00:00Z", "done", "s.json");
      // Unfinished, and finished-but-never-synthesised, are not reviews to compare to.
      yield* reviewed("running", "2026-08-29T10:00:00Z", "running", "s.json");
      yield* reviewed("empty", "2026-08-30T10:00:00Z", "done", null);
      yield* reviewed("current", "2026-08-31T10:00:00Z", "done", "s.json");

      const store = new RunStore(rig.stateDir);
      const found = yield* store.previousReview(rig.projectDir, "mr:gitlab/x!7", "current");
      expect(found?.id).toBe("second");
      // A run never finds itself, and a target nobody reviewed has nothing.
      expect(yield* store.previousReview(rig.projectDir, "worktree", "current")).toBeNull();
    }),
  ));
