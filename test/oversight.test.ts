// What a human reads a Run's progress from while nobody is watching its panes: the cards
// the host writes as the work reaches its moments, and the toast when one is worth it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { Agents, agentsLayer } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { foundationLayer, loadEntry, runDir, type Herd } from "../src/engine";
import {
  Oversight,
  checkDrift,
  standForElection,
  writeCard,
  type Correcting,
  type Watched,
} from "../src/oversight";
import { readCards } from "../src/cards";
import { currentReports, electionsPath, readDrift, readElections } from "../src/drift";
import { proposalsPath, read as readProposals } from "../src/proposals";
import { herdOf } from "../src/steering";
import { readVerifications } from "../src/verify";
import { VerifySpecSchema } from "../src/verify-spec";
import { seedIntent, writeIntent, type Authority, type Constraint } from "../src/intent";
import type { Store } from "../src/store";
import { fixtures } from "./support/host";

let rig: Rig;
let dir: string;
let toasts: string[];

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      toasts = [];
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const nothing = () => Effect.die("no children here");

/** One host's lifetime, working for `herd` where one is named and for none otherwise. */
const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Oversight
    | Store
    | FileSystem.FileSystem
    | Path.Path
  >,
  herd?: Herd,
) => {
  const toast = (title: string, body: string, sound: string) =>
    Effect.sync(() => toasts.push(`${sound}|${title}|${body}`));
  return run.pipe(
    Effect.provide(
      agentsLayer({
        dir,
        env: rig.pluginEnv(),
        herdr: new FakeHerdr(rig.pluginEnv()),
        harness: "claude",
        model: "opus",
        permissions: "bypass",
        compactAtTokens: 0,
      }),
    ),
    Effect.provide(Layer.succeed(Children)(Children.of({ start: nothing, result: nothing }))),
    Effect.provide(
      herd === undefined ? foundationLayer({ dir, toast }) : foundationLayer({ dir, toast, herd }),
    ),
    Effect.scoped,
    Effect.orDie,
  );
};

const cardsOf = (runId: string) => readCards(runDir(dir, runId)).pipe(Effect.orDie);

const executed = (
  entry: string,
  runId: string,
  input: Readonly<Record<string, Schema.Json>>,
  herd?: Herd,
) =>
  session(
    Effect.gen(function* () {
      const described = yield* loadEntry(`${fixtures}/${entry}`).pipe(Effect.orDie);
      const made = described.make(`${described.id}@${runId}`);
      return yield* made.workflow
        .execute({ runId, input })
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
    herd,
  );

test("a Run that ends leaves the card that closes it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* executed("hello.workflow.ts", "r1", { name: "you" });
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => `${card.kind}:${card.step}`)).toEqual(["final:finish"]);
      expect(cards[0]!.aligned).toBe("unverified");
    }),
  ));

test("a card a human could go and try says so, and a routine one does not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The host's own directory is where a Run nobody placed works: a change there is
      // something to look at.
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          yield* oversight.card("r1", { kind: "slice", step: "build", claims: [] });
          yield* fs.writeFileString(`${dir}/thing.ts`, "export const one = 1;\n");
          yield* oversight.card("r1", { kind: "slice", step: "build", claims: ["built it"] });
        }),
      );
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => `${card.readiness}/${card.significance}`)).toEqual([
        "claimed/routine",
        "inspect-ready/try-it",
      ]);
      expect(toasts).toEqual([
        "done|host · r1 has a slice you can try (inspect-ready)|inspect-ready",
      ]);
    }),
  ));

test("a ticket an agent says it finished is carded once, with its own words as claims", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const progress = `${runDir(dir, "r1")}/steering/progress`;
      yield* fs.makeDirectory(progress, { recursive: true });
      yield* fs.writeFileString(
        `${progress}/01-parse.json`,
        `{"ticket":"01-parse.md","status":"done","claims":["parses the file"],"at":"2026-09-25T00:00:00Z"}`,
      );
      yield* fs.writeFileString(
        `${progress}/02-print.json`,
        `{"ticket":"02-print.md","status":"started","claims":[],"at":"2026-09-25T00:01:00Z"}`,
      );
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          yield* oversight.checkpoints("r1", "build");
          yield* oversight.checkpoints("r1", "build");
        }),
      );
      // A second host looks again and finds nothing new.
      yield* session(Oversight.pipe(Effect.flatMap((one) => one.checkpoints("r1", "build"))));
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => card.claims.map((claim) => claim.text))).toEqual([
        ["parses the file"],
      ]);
      expect(cards[0]!.step).toBe("build");
    }),
  ));

/** A Run with an Intent holding these constraints, and nothing else about it written yet. */
const intended = (
  runId: string,
  constraints: ReadonlyArray<Constraint>,
  authority: Partial<Authority> = {},
) =>
  Effect.gen(function* () {
    const at = runDir(dir, runId);
    yield* (yield* FileSystem.FileSystem).makeDirectory(at, { recursive: true });
    const seeded = seedIntent(runId, { constraints });
    yield* writeIntent(at, { ...seeded, authority: { ...seeded.authority, ...authority } });
  });

/**
 * The host's own directory as a repository with one commit: where a Run nobody placed
 * works. The host's records are kept there too, so git is told to look only at the work.
 */
const repository = () =>
  Effect.gen(function* () {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["commit", "-q", "--allow-empty", "-m", "first"],
    ])
      Bun.spawnSync(["git", ...args], { cwd: dir });
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${dir}/.git/info/exclude`,
      "/*\n!/notes.txt\n!/src/\n",
    );
  });

test("a rule the work breaks is reported where it was collected, and cleared once the work comes back", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* intended("r1", [
        {
          id: "src-only",
          kind: "rule",
          text: "only src changes",
          severity: "block",
          source: "human",
          since: 1,
          rule: { kind: "protected_paths", globs: ["src/**"] },
        },
      ]);
      yield* fs.writeFileString(`${dir}/notes.txt`, "somewhere it should not be\n");
      const checked = Oversight.pipe(
        Effect.flatMap((one) => one.drift("r1", "build collected", "none")),
      );
      yield* session(checked);
      const found = currentReports(yield* readDrift(runDir(dir, "r1")));
      expect(found.map((one) => `${one.constraint}:${one.resolution}`)).toEqual(["src-only:open"]);
      expect(found[0]!.evidence.map((ref) => ref.path)).toContain("notes.txt");

      // The same tree again is the same finding, not a second one.
      yield* session(checked);
      expect(currentReports(yield* readDrift(runDir(dir, "r1")))).toHaveLength(1);

      yield* fs.remove(`${dir}/notes.txt`);
      yield* session(checked);
      expect(
        currentReports(yield* readDrift(runDir(dir, "r1"))).map((one) => one.resolution),
      ).toEqual(["verified"]);
    }),
  ));

test("a judgement no Herd can be charged for is recorded as skipped, and the card says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* intended("r1", [
        {
          id: "small",
          kind: "semantic",
          text: "keep it small",
          severity: "warn",
          source: "human",
          since: 1,
        },
      ]);
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          yield* oversight.drift("r1", "boundary before build", "boundary");
          yield* oversight.card("r1", { kind: "slice", step: "build", claims: [] });
        }),
      );
      const lines = yield* readDrift(runDir(dir, "r1"));
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : line.kind))).toEqual([
        "there is no Herd to charge a judgement to",
      ]);
      const [card] = yield* cardsOf("r1");
      expect(card!.missing).toContain(
        "a judgement was skipped: there is no Herd to charge a judgement to",
      );
      expect(card!.aligned).toBe("unverified");
    }),
  ));

const SRC_ONLY: Constraint = {
  id: "src-only",
  kind: "rule",
  text: "only src changes",
  severity: "block",
  source: "human",
  since: 1,
  rule: { kind: "protected_paths", globs: ["src/**"] },
};

/** The Run as the host would describe it, working in the host's own directory. */
const watchedAt = (runId: string, held = false): Watched => ({
  runId,
  stateDir: dir,
  runDir: runDir(dir, runId),
  evidenceDir: `${dir}/evidence/${runId}`,
  agentsDir: `${dir}/agents/${runId}`,
  cwd: dir,
  worktree: null,
  mr: null,
  asking: false,
  held,
  socketPath: null,
  family: [runId],
  dirOf: (id) => runDir(dir, id),
});

/** An agent to correct, whose sender records what it was handed. */
const recipient = (sent: string[]): Correcting => ({
  agent: { agent: "r1-build", harness: "claude", terminalId: "term-1" },
  send: (correction) => Effect.sync(() => sent.push(correction.text)).pipe(Effect.as(true)),
});

test("drift the Intent lets Collie correct goes to the agent, and is submitted, never verified", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* intended("r1", [SRC_ONLY], { auto_correct: true, exclusive_steering: true });
      yield* fs.writeFileString(`${dir}/notes.txt`, "somewhere it should not be\n");
      const sent: string[] = [];
      const done = yield* checkDrift(
        watchedAt("r1"),
        "build collected",
        "none",
        null,
        recipient(sent),
      );
      expect(done).toEqual({ sent: ["src-only"], escalated: [] });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("constraint src-only: only src changes");
      expect(sent[0]).toContain("notes.txt");
      const [report] = currentReports(yield* readDrift(runDir(dir, "r1")));
      expect(report!.resolution).toBe("correction_submitted");
      expect(report!.correction).toBe("r1-correction-src-only-1");
    }),
  ));

test("a held Run is not corrected, and one whose bound is spent is given up on and said so", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* fs.writeFileString(`${dir}/notes.txt`, "somewhere it should not be\n");
      const sent: string[] = [];

      yield* intended("r1", [SRC_ONLY], { auto_correct: true, exclusive_steering: true });
      const held = yield* checkDrift(
        watchedAt("r1", true),
        "build collected",
        "none",
        null,
        recipient(sent),
      );
      expect(held).toEqual({ sent: [], escalated: [] });

      // Without the human saying nobody else is steering, a harness that cannot tell
      // Collie's submissions from theirs is not corrected at all.
      yield* intended("r2", [SRC_ONLY], { auto_correct: true });
      expect(
        yield* checkDrift(watchedAt("r2"), "build collected", "none", null, recipient(sent)),
      ).toEqual({ sent: [], escalated: [] });

      yield* intended("r3", [SRC_ONLY], {
        auto_correct: true,
        exclusive_steering: true,
        max_corrections_per_constraint: 0,
      });
      const spent = yield* checkDrift(
        watchedAt("r3"),
        "build collected",
        "none",
        null,
        recipient(sent),
      );
      expect(spent).toEqual({ sent: [], escalated: ["src-only"] });
      expect(currentReports(yield* readDrift(runDir(dir, "r3")))[0]!.resolution).toBe("escalated");
      expect(sent).toEqual([]);
    }),
  ));

test("a finishing Run runs what it was granted, and offers what is still blocking as a follow-up", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* fs.writeFileString(`${dir}/notes.txt`, "somewhere it should not be\n");
      const tests = { name: "tests", executable: "true", argv: [], cwd: "." };
      yield* intended(
        "r1",
        [
          SRC_ONLY,
          {
            id: "tested",
            kind: "rule",
            text: "the tests pass",
            severity: "block",
            source: "human",
            since: 1,
            rule: { kind: "command_exit", name: "tests", expect: 0 },
          },
        ],
        { run_verification: [tests] },
      );
      // What the Run may verify, as the host froze it when it was admitted.
      yield* fs.makeDirectory(`${dir}/evidence/r1`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/evidence/r1/approved.json`,
        Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)))([tests]),
      );
      const herd = { socketPath: `${rig.root}/herd.sock`, pluginRoot: rig.root };

      yield* executed("hello.workflow.ts", "r1", { name: "you" }, herd);

      expect((yield* readVerifications(`${dir}/evidence/r1`)).map((one) => one.name)).toEqual([
        "tests",
      ]);
      const open = currentReports(yield* readDrift(runDir(dir, "r1")));
      expect(open.map((one) => `${one.constraint}:${one.resolution}`)).toEqual(["src-only:open"]);
      const key = yield* herdOf(herd.socketPath);
      const proposed = yield* readProposals(yield* proposalsPath(dir, key!));
      expect(
        proposed.map((one) => (one.kind === "proposal" ? one.interpretation : one.kind)),
      ).toEqual(["r1 finished with 1 blocking constraint(s) still open"]);
      expect(toasts.filter((one) => one.includes("waiting for your yes or no"))).toHaveLength(1);
      const [card] = yield* cardsOf("r1");
      expect(card!.significance).toBe("decision");
      // What the host saw is the Run's own log, the one its record shows.
      const log = yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`);
      expect(log).toContain("verification tests: pass (exit 0)");
      expect(log).toContain("aligned: false");
    }),
  ));

test("a Run with relatives stands for the cross-run check, and one leaving unanswered leaves it owed", () =>
  runEffect(
    Effect.gen(function* () {
      const socketPath = `${rig.root}/herd.sock`;
      const key = yield* herdOf(socketPath);
      const elections = yield* electionsPath(dir, key!);
      const said = () =>
        readElections(elections).pipe(
          Effect.map((lines) =>
            lines.map((line) =>
              line.kind === "pending" || line.kind === "evaluated"
                ? `${line.kind}:${line.runs.join(",")}`
                : `${line.kind}:${line.run}`,
            ),
          ),
        );
      const parent = { ...watchedAt("r1"), socketPath, family: ["r1", "r2"] };

      // Nobody can judge it here, and a boundary is not the moment to say it is owed.
      yield* standForElection(parent, "boundary before build", false, null);
      expect(yield* said()).toEqual(["candidate:r1"]);

      yield* standForElection(parent, "finish", true, null);
      expect(yield* said()).toEqual(["candidate:r1", "candidate:r1", "pending:r1,r2"]);

      // Owed, so any Run stands — once — even one with no relatives of its own.
      const stranger = { ...watchedAt("r3"), socketPath, family: ["r3"] };
      yield* standForElection(stranger, "boundary before build", false, null);
      yield* standForElection(stranger, "boundary before test", false, null);
      expect((yield* said()).slice(3)).toEqual(["candidate:r3"]);

      // And the relative's card says a check about it is still owed.
      const card = yield* writeCard(
        { ...watchedAt("r2"), socketPath, family: ["r1", "r2"] },
        { kind: "final", step: "finish", claims: [] },
      );
      expect(card.cross_run).toBe("pending");
    }),
  ));
