// What a rule check must never do is pass on an absence. Everything here is a way of
// having no evidence — no verification ran, no Output was written, no merge request
// exists — and the check saying so rather than saying nothing is wrong.

import { Effect, FileSystem, Path, Schema } from "effect";
import { expect, test } from "bun:test";
import {
  MAX_FILES,
  MAX_LINES_PER_FILE,
  alignment,
  appendDrift,
  checkRules,
  driftSaid,
  evaluatedFor,
  judge,
  currentReports,
  evidenceFor,
  fileReport,
  findingKey,
  flattenOutput,
  looksSecret,
  matchesGlob,
  newReports,
  openReports,
  readDrift,
  recordSkipped,
  splitDiff,
  supersededBy,
  type RuleFacts,
} from "../src/drift";
import { seedIntent, type Constraint, type Intent } from "../src/intent";
import { EvaluatorUnavailable, type DriftReport } from "../src/evaluator";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { readBudget } from "../src/steering";

const facts = (over: Partial<RuleFacts> = {}): RuleFacts => ({
  changedFiles: ["src/a.ts"],
  branch: "feat/picker",
  mrTarget: { project: "acme/app", iid: "42" },
  outputs: {},
  verifications: {},
  ...over,
});

function intentWith(rule: Constraint["rule"], severity: Constraint["severity"] = "block"): Intent {
  return seedIntent("r1", {
    constraints: [{ id: "c1", kind: "rule", text: "the rule", severity, source: "human", rule }],
  });
}

test("a glob matches the way a human writing one would expect", () => {
  expect(matchesGlob("src/**", "src/a/b.ts")).toBe(true);
  expect(matchesGlob("src/**", "src/a.ts")).toBe(true);
  expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
  // One star does not cross a directory: that is what two are for.
  expect(matchesGlob("src/*.ts", "src/a/b.ts")).toBe(false);
  expect(matchesGlob("src/**", "test/a.ts")).toBe(false);
  expect(matchesGlob("*.md", "README.md")).toBe(true);
});

test("protected paths report the files that were outside them, not that some were inside", () => {
  const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
  expect(checkRules(intent, facts(), "t")).toEqual([]);

  const [report] = checkRules(
    intent,
    facts({ changedFiles: ["src/a.ts", "docs/using.md", ".gitlab-ci.yml"] }),
    "t",
  );
  expect(report?.kind).toBe("rule");
  expect(report?.severity).toBe("block");
  expect(report?.evidence.map((ref) => ref.path)).toEqual(["docs/using.md", ".gitlab-ci.yml"]);
});

test("protected paths say when their list of files was cut, and the line says so too", () => {
  const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
  const outside = Array.from({ length: MAX_FILES + 5 }, (_, at) => `docs/${at}.md`);
  const [cut] = checkRules(intent, facts({ changedFiles: outside }), "t");
  expect(cut?.evidence).toHaveLength(MAX_FILES);
  expect(cut?.evidence_truncated).toBe(true);
  expect(driftSaid(cut!, "boundary before build")).toEndWith("(evidence truncated)");

  const [whole] = checkRules(intent, facts({ changedFiles: outside.slice(0, 2) }), "t");
  expect(whole?.evidence_truncated).toBe(false);
  expect(driftSaid(whole!, "boundary before build")).toBe(
    `drift at boundary before build: ${whole!.constraint} (block) — docs/0.md, docs/1.md`,
  );
});

test("a branch and a merge request are checked against what is recorded", () => {
  expect(checkRules(intentWith({ kind: "branch_is", name: "feat/picker" }), facts(), "t")).toEqual(
    [],
  );
  expect(
    checkRules(intentWith({ kind: "branch_is", name: "main" }), facts(), "t")[0]?.evidence[0]
      ?.excerpt,
  ).toContain("not main");

  const target = { kind: "mr_target" as const, project: "acme/app", iid: "42" };
  expect(checkRules(intentWith(target), facts(), "t")).toEqual([]);
  // No merge request at all is a breach, not a pass: there is nothing that targets it.
  expect(
    checkRules(intentWith(target), facts({ mrTarget: null }), "t")[0]?.evidence[0]?.excerpt,
  ).toContain("no merge request");
  expect(
    checkRules(intentWith({ ...target, iid: "9" }), facts(), "t")[0]?.evidence[0]?.excerpt,
  ).toContain("not !9");
});

test("an Output field is compared as the human wrote it", () => {
  const rule = {
    kind: "output_field" as const,
    step: "build",
    path: "verdict",
    op: "eq" as const,
    value: "clean",
  };
  const outputs = { build: flattenOutput(`{"verdict":"clean","tests":{"ran":"all"}}`) };
  expect(checkRules(intentWith(rule), facts({ outputs }), "t")).toEqual([]);
  expect(
    checkRules(intentWith({ ...rule, value: "findings" }), facts({ outputs }), "t")[0]?.evidence[0]
      ?.excerpt,
  ).toContain('"clean"');
  // Nested fields are addressable, which is what the dotted path is for.
  expect(
    checkRules(intentWith({ ...rule, path: "tests.ran", value: "all" }), facts({ outputs }), "t"),
  ).toEqual([]);
  // A step that wrote nothing has not passed.
  expect(
    checkRules(intentWith(rule), facts({ outputs: {} }), "t")[0]?.evidence[0]?.excerpt,
  ).toContain("no Output recorded");
});

test("a verification nobody ran is a breach, because it is not a pass", () => {
  const rule = { kind: "command_exit" as const, name: "tests", expect: 0 };
  expect(
    checkRules(intentWith(rule), facts({ verifications: { tests: { exit: 0, ref: "v1" } } }), "t"),
  ).toEqual([]);
  expect(
    checkRules(
      intentWith(rule),
      facts({ verifications: { tests: { exit: 1, ref: "v1" } } }),
      "t",
    )[0]?.evidence[0]?.excerpt,
  ).toContain("exited 1");
  // The one that matters: no verification of that name at all.
  const [missing] = checkRules(intentWith(rule), facts(), "t");
  expect(missing?.evidence[0]?.excerpt).toBe("no verification of that name");
});

test("a semantic constraint is never checked by a rule check", () => {
  const intent = seedIntent("r1", {
    constraints: [
      { id: "c1", kind: "semantic", text: "keep it readable", severity: "warn", source: "human" },
    ],
  });
  expect(checkRules(intent, facts({ changedFiles: ["anything"] }), "t")).toEqual([]);
});

test("a diff is split per file, capped, and secret files are named rather than quoted", () => {
  const body = (lines: number) => Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@",
    body(MAX_LINES_PER_FILE + 50),
    "diff --git a/.env b/.env",
    "@@",
    "+SECRET=hunter2",
    "diff --git a/src/b.ts b/src/b.ts",
    "@@",
    "+one line",
  ].join("\n");

  const blocks = splitDiff(diff);
  expect(blocks.map((b) => b.path)).toEqual(["src/a.ts", ".env", "src/b.ts"]);
  expect(blocks[0]?.truncated).toBe(true);
  expect(blocks[0]?.diff.split("\n")).toHaveLength(MAX_LINES_PER_FILE);
  // The name is the evidence; the contents are not something to hand a model.
  expect(blocks[1]?.diff).toBe("<redacted>");
  expect(blocks[1]?.diff).not.toContain("hunter2");
  expect(blocks[2]?.truncated).toBe(false);

  expect(looksSecret(".env.local")).toBe(true);
  expect(looksSecret("src/deploy.pem")).toBe(true);
  expect(looksSecret("src/tokens.ts")).toBe(true);
  expect(looksSecret("src/engine.ts")).toBe(false);
});

test("the same finding in the same place is not a second finding", () => {
  const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
  const found = checkRules(intent, facts({ changedFiles: ["docs/using.md"] }), "t");
  expect(found).toHaveLength(1);

  // Checked again against the same diff: nothing new to say.
  expect(newReports(found, found)).toEqual([]);
  // A different file is a different finding.
  const other = checkRules(intent, facts({ changedFiles: ["README.md"] }), "t");
  expect(newReports(other, found)).toHaveLength(1);
  expect(findingKey("c1", found[0]!.evidence)).not.toBe(findingKey("c1", other[0]!.evidence));

  // And a report that has been settled stops suppressing new ones.
  const settled = found.map((report) => ({ ...report, resolution: "verified" as const }));
  expect(newReports(found, settled)).toHaveLength(1);
});

test("a finding still there after the Intent moves is the same report, at the new version", () => {
  const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
  const onFile = checkRules(intent, facts({ changedFiles: ["docs/using.md"] }), "t").map(
    (report) => ({ ...report, resolution: "correction_submitted" as const }),
  );
  const moved = { ...intent, version: 2 };
  const again = checkRules(moved, facts({ changedFiles: ["docs/using.md"] }), "t2");

  const refiled = newReports(again, onFile);
  expect(refiled.map((r) => [r.id, r.intent_version, r.resolution])).toEqual([
    [onFile[0]!.id, 2, "correction_submitted"],
  ]);
  expect(openReports([...onFile, ...refiled]).map((r) => r.intent_version)).toEqual([2]);
  expect(newReports(again, [...onFile, ...refiled])).toEqual([]);
});

test("a moved report says what the new version found, under the id and state on file", () => {
  const warn = intentWith({ kind: "protected_paths", globs: ["src/**"] }, "warn");
  const onFile = checkRules(warn, facts({ changedFiles: ["docs/using.md"] }), "t").map(
    (report) => ({ ...report, resolution: "correction_submitted" as const, correction: "del-1" }),
  );
  const raised = { ...intentWith({ kind: "protected_paths", globs: ["src/**"] }), version: 2 };
  const again = checkRules(raised, facts({ changedFiles: ["docs/using.md"] }), "t2").map(
    (report) => ({ ...report, id: "model-chose-this" }),
  );

  const [moved] = newReports(again, onFile);
  expect(moved).toEqual({
    ...again[0]!,
    id: onFile[0]!.id,
    resolution: "correction_submitted",
    correction: "del-1",
  });
  expect(moved!.severity).toBe("block");
});

test("a finding filed again after the Intent moves is still one open report", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-refile-" });
      const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
      const [onFile] = checkRules(intent, facts({ changedFiles: ["docs/using.md"] }), "t");
      yield* appendDrift(dir, onFile!);
      expect(yield* fileReport(dir, { ...onFile!, id: "cross-run-id", intent_version: 2 })).toBe(
        true,
      );
      expect(yield* fileReport(dir, { ...onFile!, id: "cross-run-id", intent_version: 2 })).toBe(
        false,
      );
      const open = openReports(yield* readDrift(dir));
      expect(open.map((r) => [r.id, r.intent_version])).toEqual([[onFile!.id, 2]]);
    }),
  ));

test("an amended Intent supersedes what it moved past, and nothing else", () => {
  const intent = seedIntent("r1", {
    constraints: [
      { id: "c1", kind: "rule", text: "stay inside src/", severity: "block", source: "human" },
    ],
  });
  const at = { ...intent, version: 3 };
  const open = (over: Partial<DriftReport>): DriftReport => ({
    id: "d1",
    at: "t",
    run: "r1",
    intent_version: 3,
    constraint: "c1",
    kind: "rule",
    severity: "block",
    evidence: [],
    evidence_truncated: false,
    resolution: "open",
    ...over,
  });

  // Current version, constraint still there: nothing has moved past it.
  expect(supersededBy([open({})], at)).toEqual([]);
  // Judged against an older Intent.
  expect(supersededBy([open({ intent_version: 2 })], at).map((r) => r.id)).toEqual(["d1"]);
  // The constraint itself was removed, so the report is about something nobody asks for.
  expect(supersededBy([open({ constraint: "gone" })], at).map((r) => r.id)).toEqual(["d1"]);
});

test("the journal is append-only, so the newest line is the state", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-drift-" });
      const intent = intentWith({ kind: "protected_paths", globs: ["src/**"] });
      const [report] = checkRules(intent, facts({ changedFiles: ["docs/using.md"] }), "t");

      yield* appendDrift(dir, report!);
      expect(openReports(yield* readDrift(dir))).toHaveLength(1);

      yield* appendDrift(dir, { ...report!, resolution: "verified" });
      expect(openReports(yield* readDrift(dir))).toHaveLength(0);
      // Both lines are still there: what Collie thought and when survives being wrong.
      expect(yield* readDrift(dir)).toHaveLength(2);
      expect(currentReports(yield* readDrift(dir))[0]?.resolution).toBe("verified");

      // A judgement nobody could make is recorded, so a card can say why it says nothing.
      yield* recordSkipped(dir, "r1", "budget_exhausted");
      const lines = yield* readDrift(dir);
      expect(lines.at(-1)).toMatchObject({ kind: "skipped", reason: "budget_exhausted" });
      expect(currentReports(lines)).toHaveLength(1);
    }),
  ));

test("evidence is the actual diff, from the actual tree", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "hw-drift-repo-" });
      const git = (args: string[]) => exec(["git", ...args], { cwd: repo });
      yield* git(["init", "-q"]);
      yield* git(["config", "user.email", "t@example.com"]);
      yield* git(["config", "user.name", "t"]);
      yield* fs.writeFileString(path.join(repo, "a.ts"), "one\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "first"]);
      const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(path.join(repo, "a.ts"), "two\n");

      const evidence = yield* evidenceFor(repo, [], base);
      expect(evidence.blocks.map((b) => b.path)).toEqual(["a.ts"]);
      expect(evidence.blocks[0]?.diff).toContain("+two");
      expect(evidence.truncated).toBe(false);
      expect(MAX_FILES).toBeGreaterThan(0);
    }),
  ));

// --- The judgement -------------------------------------------------------------------

/** The evaluator, as a `claude` on PATH that prints whatever the test put in `reply`. */
const fakeEvaluator = Effect.fn("test.fakeEvaluator")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = path.join(dir, "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  const replyFile = path.join(dir, "reply.json");
  yield* fs.writeFileString(
    path.join(bin, "claude"),
    `#!/bin/sh\ncat > ${path.join(dir, "pack.txt")}\ncat ${replyFile}\n`,
  );
  yield* fs.chmod(path.join(bin, "claude"), 0o755);
  const before = Bun.env.PATH ?? "";
  Bun.env.PATH = `${bin}:${before}`;
  return {
    reply: (text: string) => fs.writeFileString(replyFile, text),
    pack: fs.readFileString(path.join(dir, "pack.txt")),
    restore: () => {
      Bun.env.PATH = before;
    },
  };
});

/** The evaluator's own envelope, encoded the way every boundary here encodes JSON. */
const envelope = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const FLAGS = [
  "--print",
  "--output-format",
  "--json-schema",
  "--tools",
  "--restricted",
  "--strict-mcp-config",
  "--setting-sources",
  "--no-session-persistence",
  "--max-budget-usd",
  "--append-system-prompt-file",
].join(" ");

/** A checkout with one commit, which is what a judgement reads its diff from. */
const checkout = Effect.fn("DriftTest.checkout")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    ],
  ])
    yield* exec(["git", ...args], { cwd: dir });
  return dir;
});

/** Commits `files` on top of the checkout's first commit, and returns that first commit. */
const committed = Effect.fn("DriftTest.committed")(function* (
  dir: string,
  files: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const git = (args: string[]) =>
    exec(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir });
  const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
  for (const [name, text] of Object.entries(files))
    yield* fs.writeFileString(`${dir}/${name}`, text);
  yield* git(["add", ...Object.keys(files)]);
  yield* git(["commit", "-qm", "work"]);
  return base;
});

const judgementDeps = (dir: string, help = FLAGS) => ({
  evaluator: {
    help: Effect.succeed(help),
    systemPromptFile: `${dir}/steward.md`,
    limits: { maxSeconds: 5, maxOutputBytes: 262_144, model: "sonnet", effort: "low" },
  },
  budgetFile: `${dir}/budget.jsonl`,
  limits: { maxSeconds: 5, maxOutputBytes: 262_144, model: "sonnet", effort: "low" },
  newId: Effect.succeed("call-1"),
  log: () => Effect.void,
});

const semanticIntent = (over: Partial<Intent> = {}): Intent => ({
  ...seedIntent("r1", { goal: "add a picker" }),
  constraints: [
    {
      id: "no-new-deps",
      kind: "semantic",
      text: "do not add a dependency",
      severity: "block",
      source: "human",
      since: 1,
    },
  ],
  ...over,
});

test("nothing to judge is never a judgement that happened", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      // A goal alone: only a semantic constraint can be reported against, so a call would
      // buy nothing but its own cost.
      const bare = seedIntent("r1", { goal: "ship it" });
      const out = yield* judge(judgementDeps(dir), bare, {
        runDir: dir,
        worktree: dir,
        base: "HEAD",
        at: "t0",
      });
      expect(out.judged).toEqual({ semantic: false, truncated: false });
      expect(out.reports).toEqual([]);
    }),
  ));

test("a judgement with no evaluator is skipped, and skipped is not passed", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const out = yield* judge(judgementDeps(dir, "--print"), semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "t0",
      });
      expect(out.judged.semantic).toBe(false);

      // Recorded, so `alignment` says `unverified` with the reason rather than `true`.
      const lines = yield* readDrift(dir);
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : ""))).toEqual([
        expect.stringContaining("the evaluator is missing"),
      ]);
      expect(alignment(semanticIntent(), lines, out.judged).aligned).toBe("unverified");
    }),
  ));

test("a judgement whose evaluator cannot run is skipped saying why, not as missing its flags", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const deps = judgementDeps(dir);
      const reason = "claude --help exited 1: The current working directory was deleted";
      yield* judge(
        {
          ...deps,
          evaluator: { ...deps.evaluator, help: Effect.fail(new EvaluatorUnavailable({ reason })) },
        },
        semanticIntent(),
        { runDir: dir, worktree: dir, base, at: "t0" },
      );
      const lines = yield* readDrift(dir);
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : ""))).toEqual([
        `the evaluator is unavailable: ${reason}`,
      ]);
    }),
  ));

test("a judgement whose diff git cannot read is skipped in git's words, never judged on nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-judge-" });
      yield* judge(judgementDeps(dir), semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base: "HEAD",
        at: "t0",
      });
      const lines = yield* readDrift(dir);
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : ""))).toEqual([
        expect.stringContaining("the diff could not be read: git diff HEAD..HEAD"),
      ]);
    }),
  ));

/** A Run in `worktree` whose one Output is `build`, judged with a model that cites it. */
const judgedOnOutput = Effect.fn("DriftTest.judgedOnOutput")(function* (
  dir: string,
  worktree: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const agentsDir = `${dir}/agents`;
  yield* fs.makeDirectory(agentsDir, { recursive: true });
  yield* fs.writeFileString(`${agentsDir}/build.json`, `{"summary":"added left-pad"}`);
  const evaluator = yield* fakeEvaluator(dir);
  yield* evaluator.reply(
    envelope({
      result: {
        reports: [
          {
            id: "x",
            at: "t",
            run: "r1",
            intent_version: 1,
            constraint: "no-new-deps",
            kind: "semantic",
            severity: "block",
            evidence: [{ kind: "output", path: "build" }],
            evidence_truncated: false,
            resolution: "open",
          },
        ],
      },
    }),
  );
  const deps = judgementDeps(dir);
  const out = yield* judge(deps, semanticIntent(), {
    runDir: dir,
    worktree,
    agentsDir,
    base: "HEAD",
    at: "t0",
  });
  evaluator.restore();
  expect(yield* evaluator.pack).toContain(`--- output build\n{\n  "summary": "added left-pad"\n}`);
  expect(
    (yield* readBudget(deps.budgetFile)).filter((line) => line.kind === "reserve"),
  ).toHaveLength(1);
  expect(out.judged.semantic).toBe(true);
  expect(out.reports.map((report) => report.evidence)).toEqual([
    [{ kind: "output", path: "build" }],
  ]);
});

test("a Run with no checkout is judged on its Outputs, its missing diff an empty one", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-judge-" });
      yield* judgedOnOutput(dir, dir);
    }),
  ));

test("a Run whose only work is its Outputs is judged on them, not skipped as unchanged", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      yield* judgedOnOutput(dir, dir);
      const lines = yield* readDrift(dir);
      expect(lines.filter((line) => line.kind === "skipped")).toEqual([]);
    }),
  ));

const judgedWithNoCall = Effect.fn("DriftTest.judgedWithNoCall")(function* (
  dir: string,
  intent: Intent,
  base: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const evaluator = yield* fakeEvaluator(dir);
  yield* evaluator.reply(envelope({ result: { reports: [] } }));
  const deps = judgementDeps(dir);
  const out = yield* judge(deps, intent, { runDir: dir, worktree: dir, base, at: "t0" });
  evaluator.restore();
  expect(yield* fs.exists(`${dir}/pack.txt`)).toBe(false);
  expect((yield* readBudget(deps.budgetFile)).filter((line) => line.kind === "reserve")).toEqual(
    [],
  );
  return out;
});

test("a judgement with no change to cite is skipped without a call, and reads unverified", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const out = yield* judgedWithNoCall(dir, semanticIntent(), "HEAD");
      expect(out).toEqual({ judged: { semantic: false, truncated: false }, reports: [] });
      const lines = yield* readDrift(dir);
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : line.kind))).toEqual([
        "no change to judge",
      ]);
      expect(alignment(semanticIntent(), lines, out.judged)).toEqual({
        aligned: "unverified",
        why: "a judgement was skipped: no change to judge",
      });
    }),
  ));

test("a judgement of named paths the change did not touch is skipped without a call", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const docsOnly = semanticIntent({
        constraints: semanticIntent().constraints.map((constraint) => ({
          ...constraint,
          paths: ["docs"],
        })),
      });
      const out = yield* judgedWithNoCall(dir, docsOnly, base);
      expect(out.judged.semantic).toBe(false);
      const lines = yield* readDrift(dir);
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : line.kind))).toEqual([
        "no change to judge",
      ]);
    }),
  ));

test("what the model returns is filed against this Run, at this version, and nowhere else", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const evaluator = yield* fakeEvaluator(dir);
      // The model is asked which constraint and how bad. It does not get to say which
      // Run, which Intent version, when, or whether the thing is still open — a report
      // claiming another Run would be a Driver writing somebody else's journal.
      yield* evaluator.reply(
        envelope({
          result: {
            reports: [
              {
                id: "whatever-it-liked",
                at: "1999-01-01T00:00:00Z",
                run: "some-other-run",
                intent_version: 99,
                constraint: "no-new-deps",
                kind: "rule",
                severity: "warn",
                evidence: [
                  { kind: "diff", path: "a.ts" },
                  { kind: "diff", path: "/etc/passwd" },
                ],
                evidence_truncated: false,
                resolution: "verified",
              },
              // A constraint this Intent does not have: a model inventing a rule.
              {
                id: "made-up",
                at: "t",
                run: "r1",
                intent_version: 1,
                constraint: "not-a-constraint",
                kind: "semantic",
                severity: "block",
                evidence: [],
                evidence_truncated: false,
                resolution: "open",
              },
            ],
          },
        }),
      );

      const out = yield* judge(judgementDeps(dir), semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "2026-09-10T12:00:00Z",
      });
      evaluator.restore();

      expect(out.judged).toEqual({ semantic: true, truncated: false });
      expect(out.reports).toHaveLength(1);
      const report = out.reports[0]!;
      expect(report.run).toBe("r1");
      expect(report.intent_version).toBe(1);
      expect(report.at).toBe("2026-09-10T12:00:00Z");
      expect(report.kind).toBe("semantic");
      expect(report.resolution).toBe("open");
      // A ref outside the Run is dropped rather than rendered for a human to chase.
      expect(report.evidence).toEqual([{ kind: "diff", path: "a.ts" }]);
    }),
  ));

const PLAN_NARROWS_GOAL =
  "A constraint read from the plan narrows the goal it was cut from: the goal is what was asked, not work done, and it is never evidence of drift.";

test("a Run's own judgement is told its plan's constraints narrow the goal, which is never evidence", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const evaluator = yield* fakeEvaluator(dir);
      yield* evaluator.reply(envelope({ result: { reports: [] } }));
      yield* judge(judgementDeps(dir), semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "t0",
      });
      evaluator.restore();
      const pack = yield* evaluator.pack;
      expect(pack).toContain(PLAN_NARROWS_GOAL);
      expect(pack).toContain("A report must cite the work it was shown.");
    }),
  ));

test("a Run's own report is filed only when it cites a file whose diff the pack showed", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const evaluator = yield* fakeEvaluator(dir);
      const reported = (evidence: ReadonlyArray<object>) => ({
        id: "x",
        at: "t",
        run: "r1",
        intent_version: 1,
        constraint: "no-new-deps",
        kind: "semantic",
        severity: "warn",
        evidence,
        evidence_truncated: false,
        resolution: "open",
      });
      yield* evaluator.reply(
        envelope({
          result: {
            reports: [
              reported([{ kind: "plan", path: `${dir}/plan/SPEC.md`, excerpt: "add a picker" }]),
              reported([{ kind: "diff", path: "b.ts" }]),
              reported([{ kind: "diff", path: `${dir}/a.ts`, line: 1 }]),
            ],
          },
        }),
      );
      const out = yield* judge(judgementDeps(dir), semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "t0",
      });
      evaluator.restore();
      // Only the one citing the change, and its file as the pack named it.
      expect(out.reports.map((report) => report.evidence)).toEqual([
        [{ kind: "diff", path: "a.ts", line: 1 }],
      ]);
    }),
  ));

test("every judgement is made and recorded; none is refused over how many came before", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* checkout("hw-judge-");
      const base = yield* committed(dir, { "a.ts": "export const a = 1;\n" });
      const evaluator = yield* fakeEvaluator(dir);
      yield* evaluator.reply(envelope({ result: { reports: [] }, total_cost_usd: 0.02 }));

      // Usage is data, not a quota: the second judgement is made like the first, and both
      // are in the record with what they cost.
      const deps = judgementDeps(dir, FLAGS);
      const first = yield* judge(deps, semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "t1",
      });
      expect(first.judged.semantic).toBe(true);
      const again = yield* judge({ ...deps, newId: Effect.succeed("call-2") }, semanticIntent(), {
        runDir: dir,
        worktree: dir,
        base,
        at: "t2",
      });
      evaluator.restore();
      expect(again.judged.semantic).toBe(true);
      const lines = yield* readBudget(deps.budgetFile);
      expect(lines.map((line) => `${line.kind} ${line.id}`)).toEqual([
        "reserve call-1",
        "settle call-1",
        "reserve call-2",
        "settle call-2",
      ]);
      expect(lines.flatMap((line) => (line.kind === "settle" ? [line.usd] : []))).toEqual([
        0.02, 0.02,
      ]);
      expect((yield* readDrift(dir)).some((line) => line.kind === "skipped")).toBe(false);
    }),
  ));

test("a card says a cross-run check happened, and stops saying so when it goes stale", () => {
  const at = "2026-09-10T12:00:00Z";
  // `none` means "there was nothing to check". A Judgement that was made has to be
  // distinguishable from one that never was, or the final card is silent about it.
  expect(evaluatedFor([], "r1")).toBe(false);
  expect(evaluatedFor([{ kind: "evaluated", at, by: "r1", runs: ["r1", "r2"] }], "r1")).toBe(true);
  // About the other side of the relationship, not this one.
  expect(evaluatedFor([{ kind: "evaluated", at, by: "r2", runs: ["r2"] }], "r1")).toBe(false);
  // Something moved after the answer, so the answer is behind.
  expect(
    evaluatedFor(
      [
        { kind: "evaluated", at, by: "r1", runs: ["r1"] },
        { kind: "dirty", at: "2026-09-10T12:01:00Z", by: "boundary", run: "r2" },
      ],
      "r1",
    ),
  ).toBe(false);
});
