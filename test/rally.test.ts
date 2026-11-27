import { Herdr } from "../src/herdr";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer } from "effect";
import { updateApproved } from "../src/verify-spec";
import { Rig } from "./support/recorder";
import { exec } from "./support/command";
import { runEffect as runShared } from "./support/effect";
import { overHost } from "./support/records";
import { agentsLayer } from "../src/agents";
import type { AgentHost } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { evidenceDir, foundationLayer, loadEntry } from "../src/engine";
import { fixtures } from "./support/host";
import { collect, readVerifications } from "../src/verify";
import type { Verification } from "../src/verify";
import { Store } from "../src/store";
import { RunRecords } from "../src/run-records";

let rig: Rig;
let dir: string;
const runEffect = <A, E>(effect: Parameters<typeof runShared<A, E>>[0]) =>
  runShared(effect.pipe(overHost(() => dir)));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startCore();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      // WARNING: a real repository, since a verification binds to the tree it ran on.
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
      ]) {
        yield* exec(["git", ...args], { cwd: rig.projectDir });
      }
      yield* fs.writeFileString(`${rig.projectDir}/thing.ts`, "export const one = 1;\n");
      yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
      yield* exec(["git", "commit", "-qm", "first"], { cwd: rig.projectDir });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const hostOf: () => AgentHost = () => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new Herdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
});

const rally = (runId: string, rounds: number, answers: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const entry = yield* loadEntry(`${fixtures}/rally.workflow.ts`);
    const made = entry.make(`rally@${runId}`);
    const run = Effect.gen(function* () {
      const payload = {
        runId,
        input: { target: "the diff", cwd: rig.projectDir, rounds, answers: [...answers] },
      };
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
      return yield* made.workflow.execute(payload).pipe(Effect.result);
    });
    return yield* run.pipe(Effect.provide(made.layer));
  }).pipe(
    Effect.provide(
      agentsLayer(hostOf()).pipe(
        Layer.provideMerge(
          Layer.succeed(Children)(
            Children.of({
              start: nothing,
              result: nothing,
            }),
          ),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
            userDir: rig.userDir,
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const nothing = () => Effect.die("no children in this suite");

const said = (result: { readonly _tag: string; readonly success?: unknown }) =>
  result._tag === "Success" ? String(result.success) : "";

const blocker = (title: string) => ({
  severity: "blocker",
  title,
  file: "src/thing.ts",
  detail: "it goes wrong when the list is empty",
});

test("a rally that reviews clean stops there, with no fix and no second review", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }]);
      const result = yield* rally("r-clean", 3);
      expect(said(result)).toBe("clean after 1 round(s), 0 non-blocking left");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.send")).toHaveLength(1);
    }),
  ));

test("findings drive one fix, and the review after it is what ends the rally", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean", fixed: [{ title: "empty list", file: "src/thing.ts" }], checks: [] },
        { verdict: "clean" },
      ]);
      const result = yield* rally("r-fixed", 3);
      expect(said(result)).toBe("clean after 2 round(s), 0 non-blocking left");
    }),
  ));

test("a finding that says only what it is and how bad is still a finding", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [{ severity: "minor", title: "a passing remark" }] },
      ]);
      const result = yield* rally("r-bare", 2);
      expect(said(result)).toBe("clean after 1 round(s), 1 non-blocking left");
    }),
  ));

test("a blocking finding the implementer disputed asks the dispute Choice instead of ending the rally", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          disputed: [blocker("empty list")],
          fixed: [],
          checks: [],
        },
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean" },
      ]);
      const waived = yield* rally("r-disputed", 3, ["Waive it"]);
      expect(said(waived)).toContain("dispute-1: Waive it | Send it back | Stop → Waive it");
      expect(said(waived)).toContain("waived empty list");
      expect(said(waived)).toContain("clean after 3 round(s)");
    }),
  ));

test("a disputed blocker is asked about while the review also raised a live one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          disputed: [blocker("empty list")],
          fixed: [],
          checks: [],
        },
        {
          verdict: "findings",
          findings: [blocker("empty list"), blocker("wrong order")],
        },
        {
          verdict: "clean",
          fixed: [{ title: "wrong order", file: "src/thing.ts" }],
          checks: [],
        },
        { verdict: "clean" },
      ]);
      const waived = yield* rally("r-disputed-live", 3, ["Waive it"]);
      expect(said(waived)).toContain("dispute-1: Waive it | Send it back | Stop → Waive it");
      expect(said(waived)).toContain("waived empty list");
      expect(said(waived)).toContain("clean after 3 round(s)");
    }),
  ));

test("waiving one dispute still hands the blocker nobody answered back to the fixer", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runId = "r-waive-live";
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list"), blocker("wrong order")] },
        { verdict: "clean", disputed: [blocker("empty list")], fixed: [], checks: [] },
        { verdict: "findings", findings: [blocker("empty list"), blocker("wrong order")] },
        { verdict: "clean", fixed: [{ title: "wrong order", file: "src/thing.ts" }], checks: [] },
        { verdict: "clean" },
      ]);
      const waived = yield* rally(runId, 4, ["Waive it"]);
      expect(said(waived)).toContain("dispute-1: Waive it | Send it back | Stop → Waive it");
      const fix = yield* fs.readFileString(`${dir}/agents/${runId}/fix-2.prompt.md`);
      expect(fix).toContain("wrong order");
      expect(fix).not.toContain("empty list");
    }),
  ));

test("sending one dispute back still hands the blocker nobody answered back to the fixer", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runId = "r-sendback-live";
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list"), blocker("wrong order")] },
        { verdict: "clean", disputed: [blocker("empty list")], fixed: [], checks: [] },
        { verdict: "findings", findings: [blocker("empty list"), blocker("wrong order")] },
        {
          verdict: "clean",
          fixed: [
            { title: "empty list", file: "src/thing.ts" },
            { title: "wrong order", file: "src/thing.ts" },
          ],
          checks: [],
        },
        { verdict: "clean" },
      ]);
      const sent = yield* rally(runId, 4, ["Send it back"]);
      expect(said(sent)).toContain("dispute-1: Waive it | Send it back | Stop → Send it back");
      const fix = yield* fs.readFileString(`${dir}/agents/${runId}/fix-2-back-1.prompt.md`);
      expect(fix).toContain("empty list");
      expect(fix).toMatch(/Raised again[\s\S]*wrong order/);
    }),
  ));

test("Stop on the dispute Choice ends the rally naming the dispute", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          disputed: [blocker("empty list")],
          fixed: [],
          checks: [],
        },
        { verdict: "findings", findings: [blocker("empty list")] },
      ]);
      const stopped = yield* rally("r-disputed-stop", 3, ["Stop"]);
      expect(said(stopped)).toContain("dispute-1: Waive it | Send it back | Stop → Stop");
      expect(said(stopped)).toContain("stopped:");
      expect(said(stopped)).toContain("empty list");
    }),
  ));

test("a blocking set that comes back once goes to the fixer, and the next time it is no progress", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean", fixed: [], checks: [] },
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean", fixed: [], checks: [] },
        { verdict: "findings", findings: [blocker("empty list")] },
      ]);
      const result = yield* rally("r-stuck", 4, ["Stop"]);
      expect(said(result)).toContain("no-progress-1: Send it back | Stop → Stop");
      expect(said(result)).toContain("review 3 raised the same 1 blocking finding(s) as review 2");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.send")).toHaveLength(5);
    }),
  ));

test("a final review that repeats the review before it hands its blockers back in the last fix, with no review after it", () =>
  runEffect(
    Effect.gen(function* () {
      const runId = "r-last-again";
      yield* collect(evidenceDir(dir, runId), {
        run: runId,
        name: "unit",
        executable: "true",
        argv: [],
        cwd: rig.projectDir,
        by: "agent",
      }).pipe(Effect.orDie);
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean", fixed: [{ title: "empty list", file: "src/thing.ts" }], checks: [] },
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          fixed: [{ title: "empty list", file: "src/thing.ts" }],
          checks: [{ name: "unit" }],
        },
      ]);
      const result = yield* rally(runId, 2);
      expect(said(result)).toContain("exhausted after 2 round(s)");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.send")).toHaveLength(4);
    }),
  ));

test("the last fix's checks are read from the journal, so an unproved fix goes back once and then asks", () =>
  runEffect(
    Effect.gen(function* () {
      const unproved = {
        verdict: "clean",
        fixed: [{ title: "empty list", file: "src/thing.ts" }],
        checks: [{ name: "unit" }],
      };
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        unproved,
        unproved,
      ]);
      const claimed = yield* rally("r-claimed", 1, ["Stop"]);
      expect(said(claimed)).toContain(`fix-2: handed back`);
      expect(said(claimed)).toContain(`fix-unverified-1: Send it back | Stop → Stop`);
      expect(said(claimed)).toContain(`check "unit" has no verification record`);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.send")).toHaveLength(3);
    }),
  ));

test("a check that passed on this tree is what lets the last fix stand", () =>
  runEffect(
    Effect.gen(function* () {
      const runId = "r-proved";
      yield* collect(evidenceDir(dir, runId), {
        run: runId,
        name: "unit",
        executable: "true",
        argv: [],
        cwd: rig.projectDir,
        by: "agent",
      }).pipe(Effect.orDie);
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          fixed: [{ title: "empty list", file: "src/thing.ts" }],
          checks: [{ name: "unit" }],
        },
      ]);
      const result = yield* rally(runId, 1);
      expect(said(result)).toContain("exhausted after 1 round(s)");
      expect(said(result)).toContain("implementer-reported, not re-reviewed");
    }),
  ));

test("a verification that passed before the tree moved is left to the gate, not counted as proof of the tree it is on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runId = "r-stale";
      yield* collect(evidenceDir(dir, runId), {
        run: runId,
        name: "unit",
        executable: "true",
        argv: [],
        cwd: rig.projectDir,
        by: "agent",
      }).pipe(Effect.orDie);
      yield* fs.writeFileString(`${rig.projectDir}/thing.ts`, "export const moved = true;\n");
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          fixed: [{ title: "empty list", file: "src/thing.ts" }],
          checks: [{ name: "unit" }],
        },
      ]);
      const result = yield* rally(runId, 1);
      expect(said(result)).toContain("exhausted after 1 round(s)");
      expect(said(result)).toContain(
        "0 check(s) verified on this tree, 1 left to the gate on the final tree (unit)",
      );
    }),
  ));

test("a command nobody approved is refused, whatever a workflow asks the host for", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.projectDir}/sub`, { recursive: true });
      yield* fs.makeDirectory(evidenceDir(dir, "r-perm"), { recursive: true });
      yield* updateApproved(evidenceDir(dir, "r-perm"), () => [
        { name: "unit", executable: "true", argv: [], cwd: "." },
        { name: "nested", executable: "true", argv: [], cwd: "sub" },
      ]);
      const asked = yield* Effect.gen(function* () {
        yield* (yield* Store).admit({
          request: "req-perm",
          run: "r-perm",
          workflow: "proof",
          project: rig.projectDir,
          input: {},
          provenance: {},
          options: {},
          generation: "proof@1",
          execution: "execution-r-perm",
          task: null,
          parent: null,
        });
        const host = yield* Host;
        const verify = (name: string, cwd = rig.projectDir) =>
          host.verify({ runId: "r-perm", name, cwd }).pipe(Effect.result);
        return {
          allowed: yield* verify("unit"),
          nested: yield* verify("nested"),
          refused: yield* verify("rm-rf"),
          elsewhere: yield* verify("unit", rig.root),
        };
      }).pipe(
        Effect.provide(foundationLayer({ dir, userDir: rig.userDir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(asked.allowed._tag).toBe("Success");
      expect(asked.nested._tag === "Success" && asked.nested.success.cwd).toBe(
        `${rig.projectDir}/sub`,
      );
      expect(asked.refused._tag === "Failure" && asked.refused.failure.reason).toContain(
        "is not among this Run's checks",
      );
      expect(asked.elsewhere._tag === "Failure" && asked.elsewhere.failure.reason).toContain(
        "is not inside run r-perm",
      );
    }),
  ));

const deltaRally = (runId: string, moves: boolean, upstream = false) =>
  Effect.gen(function* () {
    const base = Str.trim(
      (yield* exec(["git", "rev-parse", "HEAD"], { cwd: rig.projectDir })).stdout,
    );
    const entry = yield* loadEntry(`${fixtures}/delta-rally.workflow.ts`);
    const made = entry.make(`delta-rally@${runId}`);
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; a failure fails the test.
    yield* made.workflow
      .execute({ runId, input: { cwd: rig.projectDir, base, moves, upstream } })
      .pipe(Effect.provide(made.layer), Effect.orDie);
    const fs = yield* FileSystem.FileSystem;
    const prompt = (operation: string) =>
      fs.readFileString(`${dir}/agents/${runId}/${operation}.prompt.md`);
    return {
      base,
      first: yield* prompt("review-1"),
      second: yield* prompt("review-2-1"),
      final: yield* prompt("review-5-1"),
    };
  }).pipe(
    Effect.provide(
      agentsLayer(hostOf()).pipe(
        Layer.provideMerge(
          Layer.succeed(Children)(Children.of({ start: nothing, result: nothing })),
        ),
        Layer.provideMerge(foundationLayer({ dir, userDir: rig.userDir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const startedWithDelta = (runId: string) =>
  RunRecords.use((records) => records.put(runId, "features.json", `{"review_delta":true}`));

const DELTA = "Previous round's head:";

const twoRounds = () =>
  rig.queueOutputs([
    {
      verdict: "findings",
      summary: "two blockers",
      findings: [
        blocker("empty list"),
        blocker("null input"),
        { severity: "minor", title: "naming" },
      ],
    },
    {
      verdict: "clean",
      fixed: [{ title: "empty list", file: "src/thing.ts" }],
      disputed: [{ ...blocker("null input"), reason: "the caller never passes null" }],
      checks: [],
    },
    { verdict: "clean", summary: "settled" },
    { verdict: "clean", summary: "nothing blocking is left" },
    { verdict: "clean", summary: "the whole change" },
  ]);

test("a round-2 reviewer is told the round-1 head, what changed since it and what is still open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* startedWithDelta("r-delta");
      yield* twoRounds();
      const ran = yield* deltaRally("r-delta", true);
      const delta = Str.split(ran.second, DELTA)[1] ?? "";
      expect(ran.second).toContain(`${DELTA} ${ran.base}`);
      expect(delta).toContain(`git log -p --no-merges ${ran.base}..`);
      expect(delta).toContain("fix round 1");
      expect(delta).toContain("fixed-1.ts");
      expect(delta).toContain("[minor] naming");
      expect(delta).toContain("null input");
      expect(delta).not.toContain("empty list");
    }),
  ));

test("a round-2 reviewer is not pointed at what the default branch brought in between rounds", () =>
  runEffect(
    Effect.gen(function* () {
      yield* startedWithDelta("r-upstream");
      yield* twoRounds();
      const ran = yield* deltaRally("r-upstream", true, true);
      const delta = Str.split(ran.second, DELTA)[1] ?? "";
      expect(delta).toContain("fix round 1");
      expect(delta).toContain("fixed-1.ts");
      expect(delta).not.toContain("upstream moved");
      expect(delta).not.toContain("upstream.ts");
      expect(delta).not.toContain("Merge branch");
    }),
  ));

test("a round whose head did not move says so to its reviewer", () =>
  runEffect(
    Effect.gen(function* () {
      yield* startedWithDelta("r-unmoved");
      yield* twoRounds();
      const ran = yield* deltaRally("r-unmoved", false);
      expect(ran.second).toContain(`${DELTA} ${ran.base}`);
      expect(ran.second).toContain("The head has not moved since that round");
    }),
  ));

test("round 1 and the final review of the integrated tree read the whole change against its base, with no delta", () =>
  runEffect(
    Effect.gen(function* () {
      yield* startedWithDelta("r-whole");
      yield* twoRounds();
      const ran = yield* deltaRally("r-whole", true);
      for (const whole of [ran.first, ran.final]) {
        expect(whole).not.toContain(DELTA);
        expect(whole).toContain(`${ran.base}...HEAD`);
      }
    }),
  ));

const ledgerRally = (runId: string) =>
  Effect.gen(function* () {
    const base = Str.trim(
      (yield* exec(["git", "rev-parse", "HEAD"], { cwd: rig.projectDir })).stdout,
    );
    const entry = yield* loadEntry(`${fixtures}/ledger-rally.workflow.ts`);
    const made = entry.make(`ledger-rally@${runId}`);
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
    const result = yield* made.workflow
      .execute({ runId, input: { cwd: rig.projectDir, base } })
      .pipe(Effect.provide(made.layer), Effect.result);
    const fs = yield* FileSystem.FileSystem;
    return {
      result,
      second: yield* fs
        .readFileString(`${dir}/agents/${runId}/review-2-1.prompt.md`)
        .pipe(Effect.orElseSucceed(() => "")),
    };
  }).pipe(
    Effect.provide(
      agentsLayer(hostOf()).pipe(
        Layer.provideMerge(
          Layer.succeed(Children)(Children.of({ start: nothing, result: nothing })),
        ),
        Layer.provideMerge(foundationLayer({ dir, userDir: rig.userDir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const fixedEmptyList = {
  verdict: "clean",
  fixed: [{ title: "empty list", file: "src/thing.ts" }],
  checks: [],
};

test("an implement ticket's first review gives its finding the Run's first id, and the next round keeps that id with its new status", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", summary: "a blocker", findings: [blocker("empty list")] },
        fixedEmptyList,
        {
          verdict: "clean",
          summary: "fixed",
          findings: [{ ...blocker("empty list"), status: "fixed" }],
        },
      ]);
      const ran = yield* ledgerRally("r-ledger");
      expect(ran.second).toContain('"id": "r-ledger-F1"');
      expect(ran.second).toContain('"status": "open"');
      expect(said(ran.result)).toBe('[{"id":"r-ledger-F1","status":"fixed","title":"empty list"}]');
    }),
  ));

test("a later round's review that leaves out an earlier finding fails the Run, naming the finding whose status it must return", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", summary: "a blocker", findings: [blocker("empty list")] },
        fixedEmptyList,
        { verdict: "clean", summary: "nothing left" },
      ]);
      const ran = yield* ledgerRally("r-omit");
      expect(ran.result._tag === "Failure" && String(ran.result.failure)).toContain(
        "review omitted earlier finding r-omit-F1; return its status",
      );
    }),
  ));

const staticRally = <A>(
  runId: string,
  fixes: boolean,
  after: (ran: {
    readonly said: string;
    readonly asked: (operation: string) => Effect.Effect<boolean>;
    readonly prompt: (operation: string) => Effect.Effect<string>;
    readonly records: () => Effect.Effect<ReadonlyArray<Verification>, never, RunRecords>;
    readonly gate: () => Effect.Effect<Verification>;
  }) => Effect.Effect<A, never, RunRecords>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* (yield* Store).admit({
      request: `req-${runId}`,
      run: runId,
      workflow: "static-rally",
      project: rig.projectDir,
      input: {},
      provenance: {},
      options: {},
      generation: "static-rally@1",
      execution: `execution-${runId}`,
      task: null,
      parent: null,
    });
    yield* fs.makeDirectory(evidenceDir(dir, runId), { recursive: true });
    yield* updateApproved(evidenceDir(dir, runId), () => [
      {
        name: "static",
        executable: "test",
        argv: ["-f", "lint-ok"],
        cwd: ".",
        before_review: true,
      },
    ]);
    yield* RunRecords.use((records) =>
      records.put(runId, "features.json", `{"before_review":true}`),
    );
    const entry = yield* loadEntry(`${fixtures}/static-rally.workflow.ts`);
    const made = entry.make(`static-rally@${runId}`);
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
    const result = yield* made.workflow
      .execute({ runId, input: { cwd: rig.projectDir, fixes } })
      .pipe(Effect.provide(made.layer), Effect.result);
    const host = yield* Host;
    const agentFile = (operation: string) => `${dir}/agents/${runId}/${operation}.prompt.md`;
    return yield* after({
      said: said(result),
      asked: (operation) => fs.exists(agentFile(operation)).pipe(Effect.orDie),
      prompt: (operation) => fs.readFileString(agentFile(operation)).pipe(Effect.orDie),
      records: () => readVerifications(evidenceDir(dir, runId)).pipe(Effect.orDie),
      gate: () =>
        host
          .verify({ runId, name: "static", cwd: rig.projectDir, pass: "gate" })
          .pipe(Effect.orDie),
    });
  }).pipe(
    Effect.provide(
      agentsLayer(hostOf()).pipe(
        Layer.provideMerge(
          Layer.succeed(Children)(Children.of({ start: nothing, result: nothing })),
        ),
        Layer.provideMerge(foundationLayer({ dir, userDir: rig.userDir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

// WARNING: a fix that changed nothing also reads as a clean review.
const NOT_FIXED = {
  verdict: "clean",
  summary: "nothing changed",
  findings: [],
  fixed: [],
  checks: [],
};

test("a check marked to run before review that fails on the builder's tree goes back to the builder by name, and no reviewer starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([NOT_FIXED, NOT_FIXED, NOT_FIXED, NOT_FIXED]);
      yield* staticRally("r-static-fails", false, (ran) =>
        Effect.gen(function* () {
          const [failed] = yield* ran.records();
          expect(ran.said).toContain("before_review_failed");
          expect(ran.said).toContain(`"static"`);
          const fix = yield* ran.prompt("before-review-1-fix-1");
          expect(fix).toContain(`check "static" failed before review`);
          expect(fix).toContain(`verification:${failed!.id}`);
          expect(yield* ran.asked("review-1")).toBe(false);
        }),
      );
    }),
  ));

test("a check marked to run before review that passes opens the round, and the gate on the unmoved tree takes its record", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${rig.projectDir}/lint-ok`, "already\n");
      yield* rig.queueOutputs([NOT_FIXED]);
      yield* staticRally("r-static-passes", false, (ran) =>
        Effect.gen(function* () {
          expect(ran.said).toBe("settled");
          expect(yield* ran.asked("review-1")).toBe(true);
          const [passed, ...others] = yield* ran.records();
          expect([passed?.result, others]).toEqual(["pass", []]);
          expect((yield* ran.gate()).id).toBe(passed!.id);
          expect(yield* ran.records()).toHaveLength(1);
        }),
      );
    }),
  ));
