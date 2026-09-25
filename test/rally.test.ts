// A review/fix rally a module wrote, and what it is allowed to believe.
//
// The loop is TypeScript: a `for` over rounds, `splitDisputed` for what is still the
// implementer's, `settleRound` for where the round goes and `settleFinalFix` for whether
// the last fix stands. They are the engine's own functions — a declared loop and a written
// one converge, stand on a dispute and run out of rounds in the same place, or one of them
// is wrong.
//
// The agents are herdr's through the real dispatcher, answering by writing the file the
// prompt names. What is being proved beyond the paths is the one thing an Output cannot
// buy: a check it says it ran is a claim, and only the verification journal — bound to the
// tree the command ran on — turns it into proof.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { VerifySpecSchema } from "../src/verify-spec";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { agentsLayer, type AgentHost } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { evidenceDir, foundationLayer, loadEntry } from "../src/engine";
import { fixtures } from "./support/host";
import { collect } from "../src/verify";
import { Store } from "../src/store";

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      // A real repository, because what binds a verification is the tree it ran on and
      // a directory git knows nothing about has no tree to move.
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
      ]) {
        Bun.spawnSync(["git", ...args], { cwd: rig.projectDir });
      }
      yield* fs.writeFileString(`${rig.projectDir}/thing.ts`, "export const one = 1;\n");
      Bun.spawnSync(["git", "add", "-A"], { cwd: rig.projectDir });
      Bun.spawnSync(["git", "commit", "-qm", "first"], { cwd: rig.projectDir });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "bypass",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
});

/** The module as an author saved it, loaded the way a host loads one. */
const rally = (runId: string, rounds: number) =>
  Effect.gen(function* () {
    const entry = yield* loadEntry(`${fixtures}/rally.workflow.ts`);
    const made = entry.make(`rally@${runId}`);
    const run = Effect.gen(function* () {
      const payload = {
        runId,
        input: { target: "the diff", cwd: rig.projectDir, rounds },
      };
      return yield* made.workflow.execute(payload).pipe(Effect.result);
    });
    return yield* run.pipe(Effect.provide(made.layer));
  }).pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(foundationLayer({ dir, userDir: rig.userDir })),
    Effect.scoped,
    Effect.orDie,
  );

const asApproved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)));

/** This suite starts no children; the service is here because a registration takes one. */
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
      // One agent, one prompt: nothing reviewed again and nothing was asked to fix.
      expect((yield* rig.calls()).filter((call) => (call.argv ?? [])[1] === "prompt")).toHaveLength(
        1,
      );
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
      // No file, no line, no detail — a reviewer who has none of those has still said
      // something, and a shape that refused it would throw the review away.
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [{ severity: "minor", title: "a passing remark" }] },
      ]);
      const result = yield* rally("r-bare", 2);
      // Minor is the one severity that does not drive a round, so the rally is over and
      // what was said is carried rather than dropped.
      expect(said(result)).toBe("clean after 1 round(s), 1 non-blocking left");
    }),
  ));

test("a blocking finding the implementer disputed is the human's call, not another round", () =>
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
        // The reviewer raises it again with no answer to the reason given.
        { verdict: "findings", findings: [blocker("empty list")] },
      ]);
      const result = yield* rally("r-disputed", 3);
      expect(said(result)).toContain("dispute_unresolved");
      expect(said(result)).toContain("stand unanswered");
    }),
  ));

test("the same blocking findings twice running is not progress, and the rally says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        { verdict: "clean", fixed: [], checks: [] },
        { verdict: "findings", findings: [blocker("empty list")] },
      ]);
      const result = yield* rally("r-stuck", 4);
      expect(said(result)).toContain("no_progress");
      expect(said(result)).toContain("raised the same 1 blocking finding(s)");
    }),
  ));

test("the last fix's checks are read from the journal, not from what it said about them", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "findings", findings: [blocker("empty list")] },
        {
          verdict: "clean",
          fixed: [{ title: "empty list", file: "src/thing.ts" }],
          checks: [{ name: "unit" }],
        },
      ]);
      // Nothing was ever run under that name, so the fix's word for it buys nothing.
      const claimed = yield* rally("r-claimed", 1);
      expect(said(claimed)).toContain("fix_unverified");
      expect(said(claimed)).toContain(`check "unit" has no verification record`);
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

test("a verification that passed before the tree moved is not proof of the tree it is on", () =>
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
      // The change the fix made is the thing that makes the earlier pass history.
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
      expect(said(result)).toContain("fix_unverified");
      expect(said(result)).toContain(`check "unit" last passed on an earlier tree`);
    }),
  ));

test("a command nobody approved is refused, whatever a workflow asks the host for", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.projectDir}/sub`, { recursive: true });
      yield* fs.makeDirectory(evidenceDir(dir, "r-perm"), { recursive: true });
      yield* fs.writeFileString(
        `${evidenceDir(dir, "r-perm")}/approved.json`,
        asApproved([
          { name: "unit", executable: "true", argv: [], cwd: "." },
          { name: "nested", executable: "true", argv: [], cwd: "sub" },
        ]),
      );
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
      // Where the grant said, not where the workflow happened to be standing.
      expect(asked.nested._tag === "Success" && asked.nested.success.cwd).toBe(
        `${rig.projectDir}/sub`,
      );
      expect(asked.refused._tag === "Failure" && asked.refused.failure.reason).toContain(
        "is not among this Run's approved verifications",
      );
      expect(asked.elsewhere._tag === "Failure" && asked.elsewhere.failure.reason).toContain(
        "is not inside run r-perm",
      );
    }),
  ));
