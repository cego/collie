// What a human reads a Run's progress from while nobody is watching its panes: the cards
// the host writes as the work reaches its moments, and the toast when one is worth it.

import type { ChildProcessSpawner } from "effect/process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Agents, agentsLayer } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { foundationLayer, loadEntry, runDir, type Herd } from "../src/engine";
import {
  Oversight,
  checkDrift,
  familyOf,
  ruleFacts,
  standForElection,
  writeCard,
  type Correcting,
  type Watched,
} from "../src/oversight";
import { readCards } from "../src/cards";
import {
  MAX_FILES,
  alignment,
  NOT_JUDGED,
  currentReports,
  electionsPath,
  evidenceFor,
  findingKey,
  readDrift,
  readElections,
  type JudgementDeps,
} from "../src/drift";
import { proposalsPath, read as readProposals } from "../src/proposals";
import { budgetPath, herdOf } from "../src/steering";
import { serverSocket } from "../src/home";
import { readVerifications } from "../src/verify";
import { VerifySpecSchema } from "../src/verify-spec";
import {
  amend,
  readIntent,
  seedIntent,
  writeIntent,
  type Authority,
  type Constraint,
} from "../src/intent";
import { Store } from "../src/store";
import { recordReply } from "../src/replies";
import { fixtures } from "./support/host";
import { loggedGit } from "./support/bin";

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
    | ChildProcessSpawner.ChildProcessSpawner
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
        permissions: "auto",
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
      yield* exec(["git", "init", "-q"], { cwd: dir });
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

test("a Run whose own plan moved its Intent still has a slice to try", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* exec(["git", "init", "-q"], { cwd: dir });
      yield* intended("r1", []);
      yield* fs.makeDirectory(`${runDir(dir, "r1")}/plan`, { recursive: true });
      yield* fs.writeFileString(
        `${runDir(dir, "r1")}/plan/SPEC.md`,
        "## Done when\n\n- it works\n",
      );
      yield* checkDrift(watchedAt("r1", false, dir), "build collected", "none", null, null);
      yield* session(
        Effect.gen(function* () {
          yield* fs.writeFileString(`${dir}/thing.ts`, "export const one = 1;\n");
          yield* (yield* Oversight).card("r1", {
            kind: "slice",
            step: "build",
            claims: ["built it"],
          });
        }),
      );
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => `${card.readiness}/${card.significance}`)).toEqual([
        "inspect-ready/try-it",
      ]);
    }),
  ));

test("a Run whose Intent a human moved says so on its card", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* exec(["git", "init", "-q"], { cwd: dir });
      yield* intended("r1", []);
      const intent = (yield* readIntent(runDir(dir, "r1")))!;
      yield* writeIntent(
        runDir(dir, "r1"),
        amend(intent, { kind: "set-goal", goal: "ship it" }, "human:req-1", "t"),
      );
      yield* session(
        Effect.gen(function* () {
          yield* fs.writeFileString(`${dir}/thing.ts`, "export const one = 1;\n");
          yield* (yield* Oversight).card("r1", {
            kind: "slice",
            step: "build",
            claims: ["built it"],
          });
        }),
      );
      const cards = yield* cardsOf("r1");
      expect(cards.map((card) => card.significance)).toEqual(["consequential"]);
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
      yield* exec(["git", ...args], { cwd: dir });
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${dir}/.git/info/exclude`,
      "/*\n!/notes.txt\n!/src/\n",
    );
  });

/** A tracked edit left uncommitted: the base falls back to `HEAD`, so a commit would hide it. */
const edited = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/src`, { recursive: true });
    yield* fs.writeFileString(`${dir}/src/work.ts`, "export const work = 1;\n");
    yield* exec(["git", "add", "src/work.ts"], { cwd: dir });
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

test("a rule check git cannot answer is skipped in git's words, and clears nothing", () =>
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

      yield* fs.remove(`${dir}/.git`, { recursive: true });
      yield* session(checked);
      expect(
        currentReports(yield* readDrift(runDir(dir, "r1"))).map((one) => one.resolution),
      ).toEqual(["open"]);
      const log = yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`);
      expect(log).toContain("rule check skipped at build collected: git diff");
      expect(log).toContain("Not a git repository");
    }),
  ));

test("a rule check git cannot answer leaves the Run unverified, never aligned", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* intended("r1", [SRC_ONLY]);
      yield* session(
        Oversight.pipe(Effect.flatMap((one) => one.drift("r1", "build collected", "none"))),
      );
      const lines = yield* readDrift(runDir(dir, "r1"));
      expect(lines.map((line) => (line.kind === "skipped" ? line.reason : ""))).toEqual([
        expect.stringContaining("rule check skipped at build collected: git diff"),
      ]);
      const intent = yield* readIntent(runDir(dir, "r1"));
      expect(alignment(intent, lines, NOT_JUDGED).aligned).toBe("unverified");
      expect(yield* fs.exists(`${dir}/.git`)).toBe(false);
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

const SMALL: Constraint = {
  id: "small",
  kind: "semantic",
  text: "keep it small",
  severity: "warn",
  source: "human",
  since: 1,
};

/** `claude` on PATH as the evaluator: it takes every flag a judgement needs, and finds nothing. */
const evaluatorOnPath = Effect.suspend(() =>
  evaluatorAnswering(`cat > /dev/null\necho '{"result":{"reports":[]}}'`),
);

const EVALUATOR_FLAGS = [
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

const evaluatorAnswering = Effect.fnUntraced(function* (answer: string) {
  const fs = yield* FileSystem.FileSystem;
  const bin = `${rig.root}/evaluator-bin-${Bun.hash(answer)}`;
  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.writeFileString(
    `${bin}/claude`,
    `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "${EVALUATOR_FLAGS}"; exit 0; fi\n${answer}\n`,
  );
  yield* fs.chmod(`${bin}/claude`, 0o755);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = Bun.env.PATH ?? "";
      Bun.env.PATH = `${bin}:${before}`;
      return before;
    }),
    (before) =>
      Effect.sync(() => {
        Bun.env.PATH = before;
      }),
  );
});

const boundaryThenCard = Effect.gen(function* () {
  const oversight = yield* Oversight;
  yield* oversight.drift("r1", "boundary before build", "boundary");
  yield* oversight.card("r1", { kind: "slice", step: "build", claims: [] });
});

test("a host whose environment names no socket finds its Herd in herdr's status, and judges", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      yield* edited();
      yield* intended("r1", [SMALL]);
      yield* evaluatorOnPath;
      const socketPath = `${rig.root}/herd.sock`;
      const env = rig.pluginEnv({ HERDR_SOCKET_PATH: "", FAKE_HERDR_STATUS_SOCKET: socketPath });
      expect(env.socketPath).toBeNull();

      yield* session(boundaryThenCard, {
        socketPath: env.socketPath,
        pluginRoot: rig.root,
        locate: serverSocket(new FakeHerdr(env)),
      });

      expect(yield* readDrift(runDir(dir, "r1"))).toEqual([]);
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${runDir(dir, "r1")}/log.txt`,
      );
      expect(log).toContain("judged 1 semantic constraint(s)");
      const key = yield* herdOf(socketPath);
      expect(yield* (yield* FileSystem.FileSystem).exists(yield* budgetPath(dir, key!))).toBe(true);
      const [card] = yield* cardsOf("r1");
      expect(card!.aligned).toBe("true");
    }),
  ));

test("a judgement skipped at every boundary for one reason is one line on the card", () =>
  runEffect(
    Effect.gen(function* () {
      yield* intended("r1", [SMALL]);
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          for (const step of ["build", "review", "final"])
            yield* oversight.drift("r1", `boundary before ${step}`, "boundary");
          yield* oversight.card("r1", { kind: "slice", step: "final", claims: [] });
        }),
      );
      expect(yield* readDrift(runDir(dir, "r1"))).toHaveLength(3);
      const [card] = yield* cardsOf("r1");
      expect(card!.missing).toEqual([
        "a judgement was skipped: there is no Herd to charge a judgement to",
      ]);
    }),
  ));

test("a judgement made after one was skipped leaves the Run aligned, not unverified", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      yield* edited();
      yield* intended("r1", [SMALL]);
      yield* session(boundaryThenCard);
      expect((yield* cardsOf("r1")).at(-1)!.aligned).toBe("unverified");

      yield* evaluatorOnPath;
      yield* session(boundaryThenCard, {
        socketPath: `${rig.root}/herd.sock`,
        pluginRoot: rig.root,
      });

      const card = (yield* cardsOf("r1")).at(-1)!;
      expect(card.aligned).toBe("true");
      expect(card.missing).toEqual([]);
    }),
  ));

test("a judgement that fails after one that answered leaves only its own failure on the card", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      yield* edited();
      yield* intended("r1", [SMALL]);
      yield* session(boundaryThenCard);
      const herd = { socketPath: `${rig.root}/herd.sock`, pluginRoot: rig.root };
      yield* evaluatorOnPath;
      yield* session(boundaryThenCard, herd);
      yield* evaluatorAnswering("exit 1");
      yield* session(boundaryThenCard, herd);

      const card = (yield* cardsOf("r1")).at(-1)!;
      expect(card.aligned).toBe("unverified");
      expect(card.missing).toHaveLength(1);
      expect(card.missing[0]).toStartWith("a judgement was skipped: the judgement did not answer");
    }),
  ));

test("a boundary with no change is skipped, and one after an edit leaves the Run aligned", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      yield* intended("r1", [SMALL]);
      yield* evaluatorOnPath;
      const herd = { socketPath: `${rig.root}/herd.sock`, pluginRoot: rig.root };
      yield* session(boundaryThenCard, herd);
      const before = (yield* cardsOf("r1")).at(-1)!;
      expect(before.aligned).toBe("unverified");
      expect(before.missing).toEqual(["a judgement was skipped: no change to judge"]);

      yield* edited();
      yield* session(boundaryThenCard, herd);
      const after = (yield* cardsOf("r1")).at(-1)!;
      expect(after.aligned).toBe("true");
      expect(after.missing).toEqual([]);
    }),
  ));

test("a Run that finishes with nothing changed logs that it is unverified, and why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      yield* intended("r1", [SMALL]);
      yield* evaluatorOnPath;
      yield* executed(
        "hello.workflow.ts",
        "r1",
        { name: "you" },
        { socketPath: `${rig.root}/herd.sock`, pluginRoot: rig.root },
      );
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${runDir(dir, "r1")}/log.txt`,
      );
      expect(log).toContain("aligned: unverified — a judgement was skipped: no change to judge");
    }),
  ));

test("a rule check skipped is not answered by a judgement made after it", () => {
  const intent = seedIntent("r1", { constraints: [SRC_ONLY, SMALL] });
  const skipped = (reason: string, check?: "rule") => ({
    kind: "skipped" as const,
    at: "2026-01-01T00:00:00.000Z",
    run: "r1",
    reason,
    ...(check && { check }),
  });
  const judged = { semantic: true, truncated: false, at: "2026-01-02T00:00:00.000Z" };
  expect(alignment(intent, [skipped("there is no Herd to charge a judgement to")], judged)).toEqual(
    { aligned: "true", why: "every constraint was checked and none is open" },
  );
  expect(
    alignment(intent, [skipped("rule check skipped at build: git diff", "rule")], judged).aligned,
  ).toBe("unverified");
});

test.each([
  ["a goal", "ship it"],
  ["no goal", undefined],
])("an Intent with %s and no constraint is unverified, since nothing was judged", (_, goal) => {
  expect(alignment(seedIntent("r1", { constraints: [], goal }), [], NOT_JUDGED)).toEqual({
    aligned: "unverified",
    why: "nothing was judged",
  });
});

test("rules that passed and semantic constraints judged with nothing open are aligned", () => {
  const intent = seedIntent("r1", { constraints: [SRC_ONLY, SMALL] });
  const judged = { semantic: true, truncated: false, at: "2026-01-02T00:00:00.000Z" };
  expect(alignment(intent, [], judged).aligned).toBe("true");
});

/** A Run with this Intent finishing under a Herd, and how many judgements it asked for. */
const judgementsAtFinish = (intent: { constraints: Constraint[]; goal: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* repository();
    yield* edited();
    const at = runDir(dir, "r1");
    yield* fs.makeDirectory(at, { recursive: true });
    yield* writeIntent(at, seedIntent("r1", intent));
    const calls = `${rig.root}/judgements`;
    yield* evaluatorAnswering(
      `echo asked >> ${calls}\ncat > /dev/null\necho '{"result":{"reports":[]}}'`,
    );
    yield* session(Oversight.pipe(Effect.flatMap((one) => one.drift("r1", "finish", "finish"))), {
      socketPath: `${rig.root}/herd.sock`,
      pluginRoot: rig.root,
    });
    const asked = yield* fs.readFileString(calls).pipe(Effect.orElseSucceed(() => ""));
    return asked.split("\n").filter((line) => line === "asked").length;
  });

test("a Run that finishes with a goal and no semantic constraint asks for no judgement", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* judgementsAtFinish({ constraints: [], goal: "ship it" })).toBe(0);
    }),
  ));

test("a Run that finishes with a semantic constraint asks for its one judgement", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* judgementsAtFinish({ constraints: [SMALL], goal: "ship it" })).toBe(1);
    }),
  ));

test("a branch past the cap is judged once, at the finish, and each boundary says so", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* fs.makeDirectory(`${dir}/src`, { recursive: true });
      const files: string[] = [];
      for (let n = 0; n <= MAX_FILES; n += 1) {
        files.push(`src/f${n}.ts`);
        yield* fs.writeFileString(`${dir}/src/f${n}.ts`, `${n}\n`);
      }
      yield* exec(["git", "add", ...files], { cwd: dir });
      yield* intended("r1", [SMALL]);
      const calls = `${rig.root}/judgements`;
      yield* evaluatorAnswering(
        `echo asked >> ${calls}\ncat > /dev/null\necho '{"result":{"reports":[]}}'`,
      );
      yield* session(
        Effect.gen(function* () {
          const oversight = yield* Oversight;
          for (const where of ["build-1", "build-2", "build-3"])
            yield* oversight.drift("r1", where, "boundary");
          yield* oversight.drift("r1", "finish", "finish");
        }),
        { socketPath: `${rig.root}/herd.sock`, pluginRoot: rig.root },
      );
      const asked = yield* fs.readFileString(calls).pipe(Effect.orElseSucceed(() => ""));
      expect(asked.split("\n").filter((line) => line === "asked")).toHaveLength(1);
      const log = yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`);
      expect(log).toContain("not judged at build-2: evidence past the cap; judged at the finish");
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
const watchedAt = (runId: string, held = false, worktree: string | null = null): Watched => ({
  runId,
  stateDir: dir,
  runDir: runDir(dir, runId),
  evidenceDir: `${dir}/evidence/${runId}`,
  agentsDir: `${dir}/agents/${runId}`,
  cwd: dir,
  worktree,
  mr: null,
  asking: false,
  held,
  herd: null,
  family: [runId],
  dirOf: (id) => runDir(dir, id),
  cwdOf: () => Effect.succeed(dir),
});

/** An agent to correct, whose sender records what it was handed. */
const recipient = (sent: string[]): Correcting => ({
  agent: { agent: "r1-build", harness: "claude", terminalId: "term-1" },
  send: (correction) => Effect.sync(() => sent.push(correction.text)).pipe(Effect.as(true)),
});

test.each([
  ["merge request", "https://gitlab.example.com/acme/app/-/merge_requests/42", "acme/app", "42"],
  ["pull request", "https://github.com/acme/app/pull/30", "acme/app", "30"],
])("a Run's %s is the drift rules' target", (_, url, project, iid) =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      const facts = yield* ruleFacts({ ...watchedAt("r1"), mr: url });
      expect(facts.mrTarget).toEqual({ project, iid });
    }),
  ),
);

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

test("a Run's own SPEC reaches its Intent at the next drift check", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* intended("r1", []);
      const before = yield* readIntent(runDir(dir, "r1"));
      yield* fs.makeDirectory(`${runDir(dir, "r1")}/plan`, { recursive: true });
      yield* fs.writeFileString(
        `${runDir(dir, "r1")}/plan/SPEC.md`,
        "# Spec\n\n## Out of scope\n\n- Rewriting the scheduler\n",
      );
      yield* checkDrift(watchedAt("r1", false, dir), "build collected", "none", null, null);
      const after = yield* readIntent(runDir(dir, "r1"));
      expect(after!.constraints).toHaveLength(1);
      expect(after!.constraints[0]!.source).toBe("plan");
      expect(after!.constraints[0]!.provenance?.file).toBe("plan/SPEC.md");
      expect(after!.authority).toEqual(before!.authority);
    }),
  ));

test("a Run with no worktree of its own is not bounded by the SPEC it writes for another", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* intended("r1", []);
      yield* fs.makeDirectory(`${runDir(dir, "r1")}/plan`, { recursive: true });
      yield* fs.writeFileString(
        `${runDir(dir, "r1")}/plan/SPEC.md`,
        "## Done when\n\n- it works\n",
      );
      yield* checkDrift(watchedAt("r1"), "spec collected", "none", null, null);
      expect((yield* readIntent(runDir(dir, "r1")))!.version).toBe(1);
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

test("a host that finds its Herd while a Run finishes offers that Run's blocking drift", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      yield* fs.writeFileString(`${dir}/notes.txt`, "somewhere it should not be\n");
      const herdr = `${rig.root}/herdr-started`;
      const started = { name: "herdr", executable: "touch", argv: [herdr], cwd: "." };
      yield* intended(
        "r1",
        [
          SRC_ONLY,
          {
            id: "herdr-up",
            kind: "rule",
            text: "herdr is started",
            severity: "warn",
            source: "human",
            since: 1,
            rule: { kind: "command_exit", name: "herdr", expect: 0 },
          },
        ],
        { run_verification: [started] },
      );
      yield* fs.makeDirectory(`${dir}/evidence/r1`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/evidence/r1/approved.json`,
        Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)))([started]),
      );
      const socketPath = `${rig.root}/herd.sock`;
      // A minute passes at each ask that finds no Herd, so the host asks again, and never
      // while a check runs on the clock that bounds it.
      const clock = yield* TestClock.make();
      yield* clock.setTime(yield* Clock.currentTimeMillis);
      const locate = fs.exists(herdr).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((up) =>
          up ? Effect.succeed(socketPath) : Effect.as(clock.adjust("1 minute"), null),
        ),
      );

      yield* executed(
        "hello.workflow.ts",
        "r1",
        { name: "you" },
        { socketPath: null, pluginRoot: rig.root, locate },
      ).pipe(Effect.provideService(Clock.Clock, clock));

      const key = yield* herdOf(socketPath);
      const proposed = yield* readProposals(yield* proposalsPath(dir, key!));
      expect(
        proposed.map((one) => (one.kind === "proposal" ? one.interpretation : one.kind)),
      ).toEqual(["r1 finished with 1 blocking constraint(s) still open"]);
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
      const parent = { ...watchedAt("r1"), herd: key, family: ["r1", "r2"] };
      // Work to judge, so a check is owed for it.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${dir}/agents/r2`, { recursive: true });
      yield* fs.writeFileString(`${dir}/agents/r2/build.json`, '{"verdict":"clean"}');

      // Nobody can judge it here, and a boundary is not the moment to say it is owed.
      yield* standForElection(parent, "boundary before build", false, null);
      expect(yield* said()).toEqual(["candidate:r1"]);

      yield* standForElection(parent, "finish", true, null);
      expect(yield* said()).toEqual(["candidate:r1", "candidate:r1", "pending:r1,r2"]);

      // Owed, so any Run stands — once — even one with no relatives of its own.
      const stranger = { ...watchedAt("r3"), herd: key, family: ["r3"] };
      yield* standForElection(stranger, "boundary before build", false, null);
      yield* standForElection(stranger, "boundary before test", false, null);
      expect((yield* said()).slice(3)).toEqual(["candidate:r3"]);

      // And the relative's card says a check about it is still owed.
      const card = yield* writeCard(
        { ...watchedAt("r2"), herd: key, family: ["r1", "r2"] },
        { kind: "final", step: "finish", claims: [] },
      );
      expect(card.cross_run).toBe("pending");
    }),
  ));

// --- The cross-run judgement reads the work ------------------------------------------

test("a card reads its branch, head and dirtiness from the one status its fingerprint hashes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = `${rig.root}/carded`;
      yield* fs.makeDirectory(repo, { recursive: true });
      for (const args of [
        ["init", "-q", "-b", "feat/picker"],
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "x",
        ],
      ])
        yield* git(args, repo);
      yield* fs.writeFileString(`${repo}/new.txt`, "new\n");
      const starts = yield* loggedGit(`${rig.root}/bin`, `${rig.root}/git.log`);
      const card = yield* writeCard(
        { ...watchedAt("r1"), cwd: repo },
        { kind: "slice", step: "build", claims: [] },
      );
      expect(card.revision).toMatchObject({ branch: "feat/picker", dirty: true });
      expect(card.revision.head_sha).toHaveLength(40);
      expect(
        (yield* starts).filter((line) => /^(rev-parse|status --porcelain$)/.test(line)),
      ).toEqual([]);
      expect((yield* starts).filter((line) => line.startsWith("status"))).toHaveLength(1);

      yield* git(["checkout", "-q", "--detach"], repo);
      yield* fs.remove(`${repo}/new.txt`);
      const detached = yield* writeCard(
        { ...watchedAt("r1"), cwd: repo },
        { kind: "slice", step: "build", claims: [] },
      );
      expect(detached.revision).toMatchObject({ branch: "HEAD", dirty: false });
    }),
  ));

test("a card on a branch with no commit yet names no branch and no head", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = `${rig.root}/unborn`;
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* git(["init", "-q"], repo);
      const card = yield* writeCard(
        { ...watchedAt("r1"), cwd: repo },
        { kind: "slice", step: "build", claims: [] },
      );
      expect(card.revision).toMatchObject({ branch: null, head_sha: "", dirty: false });
    }),
  ));

const R1_ONLY: Constraint = { ...SMALL, id: "r1-only", text: "touch only the docs" };

const git = (args: string[], cwd = dir) => exec(["git", ...args], { cwd });

/** `files` committed on a branch of the host's repository, and a card of `runId` at it. */
const cardedWork = (runId: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* git(["checkout", "-q", "-b", `${runId}-work`]);
    yield* fs.makeDirectory(`${dir}/src`, { recursive: true });
    for (const [name, text] of Object.entries(files))
      yield* fs.writeFileString(`${dir}/${name}`, text);
    yield* git(["add", ...Object.keys(files)]);
    yield* git(["commit", "-qm", `${runId}'s work`]);
    yield* writeCard(watchedAt(runId), { kind: "slice", step: "build", claims: [] });
    yield* git(["checkout", "-q", "-"]);
  });

/** A repository of its own at `path`, one commit of `files` past its default branch. */
const repositoryAt = (path: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["commit", "-q", "--allow-empty", "-m", "first"],
      ["update-ref", "refs/remotes/origin/main", "HEAD"],
    ])
      yield* git(args, path);
    for (const [name, text] of Object.entries(files)) {
      yield* fs.makeDirectory(`${path}/${name.slice(0, name.lastIndexOf("/") + 1)}`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${path}/${name}`, text);
    }
    yield* git(["add", ...Object.keys(files)], path);
    yield* git(["commit", "-qm", "work"], path);
  });

/** A judge that keeps the pack it was given and answers with `reports`. */
const crossRunJudge = (reports: ReadonlyArray<object>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const reply = `${rig.root}/cross-run-reply.json`;
    yield* fs.writeFileString(
      reply,
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ result: { reports } }),
    );
    yield* evaluatorAnswering(`cat > ${rig.root}/pack.txt\ncat ${reply}`);
    const limits = { maxSeconds: 5, maxOutputBytes: 262_144, model: "sonnet", effort: "low" };
    const deps: JudgementDeps = {
      evaluator: {
        help: Effect.succeed(EVALUATOR_FLAGS),
        systemPromptFile: `${dir}/steward.md`,
        limits,
      },
      budgetFile: `${dir}/budget.jsonl`,
      limits,
      newId: Effect.succeed("call-1"),
      log: () => Effect.void,
    };
    return deps;
  });

const reportOn = (run: string, constraint: string, evidence: ReadonlyArray<object>) => ({
  id: "the-models-own",
  at: "t",
  run,
  intent_version: 9,
  constraint,
  kind: "rule",
  severity: "warn",
  evidence,
  evidence_truncated: false,
  resolution: "open",
});

/** What the pack says under one Run, up to the next. */
const under = (pack: string, runId: string) =>
  pack.split(/^(?=run: )/m).find((section) => section.startsWith(`run: ${runId}\n`)) ?? "";

/** `r1` judging `family`, each Run read in its entry of `checkouts`, else the host's directory. */
const judgedAcross = (
  family: ReadonlyArray<string>,
  deps: JudgementDeps,
  checkouts: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const key = (yield* herdOf(`${rig.root}/herd.sock`))!;
    yield* standForElection(
      {
        ...watchedAt("r1"),
        herd: key,
        family,
        cwdOf: (id) => Effect.succeed(checkouts[id] ?? dir),
      },
      "boundary",
      false,
      deps,
    );
    const fs = yield* FileSystem.FileSystem;
    return {
      pack: yield* fs.readFileString(`${rig.root}/pack.txt`),
      log: yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`),
    };
  });

test("the cross-run judge reads each related Run's work, and files only what cites it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository();
        yield* git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        yield* intended("r3", [SMALL]);
        yield* intended("r4", [SMALL]);
        yield* cardedWork("r2", {
          "src/a.ts": "export const a = 1;\n",
          "src/api-token.ts": "export const TOKEN = 'hunter2';\n",
        });
        yield* fs.makeDirectory(`${dir}/agents/r2`, { recursive: true });
        yield* fs.writeFileString(
          `${dir}/agents/r2/build.json`,
          '{"verdict":"clean","note":"a picker"}',
        );
        yield* fs.writeFileString(`${dir}/agents/r2/api-token.json`, '{"value":"s3cr3t"}');
        yield* fs.writeFileString(`${dir}/agents/r2/build.launch.json`, '{"argv":"LAUNCHED"}');
        yield* fs.writeFileString(`${dir}/agents/r2/build.mcp.json`, '{"servers":"MCP-CONFIG"}');
        yield* fs.makeDirectory(`${dir}/agents/r3`, { recursive: true });
        yield* fs.writeFileString(`${dir}/agents/r3/plan.json`, '{"verdict":"planned"}');
        // A card at a commit this repository does not have: a Run of another one.
        const elsewhere = `${rig.root}/elsewhere`;
        yield* repositoryAt(elsewhere, { "docs/r4.md": "r4's own\n" });
        yield* writeCard(
          { ...watchedAt("r4"), cwd: elsewhere },
          { kind: "slice", step: "build", claims: [] },
        );

        const cited = [{ kind: "diff" as const, path: "src/a.ts" }];
        const deps = yield* crossRunJudge([
          reportOn("r2", "small", cited),
          reportOn("r2", "small", [{ kind: "output", path: "build" }]),
          // Another Run's constraint.
          reportOn("r2", "r1-only", cited),
          // The goal, and a commit alone.
          reportOn("r2", "small", [{ kind: "plan", excerpt: "add a picker" }]),
          reportOn("r2", "small", [{ kind: "git", sha: "abc123" }]),
          // A file another Run changed.
          reportOn("r1", "r1-only", cited),
        ]);
        const { pack, log } = yield* judgedAcross(["r1", "r2", "r3", "r4"], deps, {
          r4: elsewhere,
        });

        expect(pack).toContain(
          "A constraint read from the plan narrows the goal it was cut from: the goal is what was asked, not work done, and it is never evidence of drift.",
        );
        const r2 = under(pack, "r2");
        expect(r2).toContain("--- src/a.ts");
        expect(r2).toContain("+export const a = 1;");
        expect(r2).toContain("--- src/api-token.ts\n<redacted>");
        expect(pack).not.toContain("hunter2");
        expect(r2).toContain("--- output api-token\n<redacted>");
        expect(pack).not.toContain("s3cr3t");
        expect(r2).toContain("--- output build");
        expect(r2).toContain('"verdict": "clean"');
        expect(pack).not.toContain("LAUNCHED");
        expect(pack).not.toContain("MCP-CONFIG");
        expect(r2.indexOf("constraint: small")).toBeLessThan(r2.indexOf("--- src/a.ts"));
        const r3 = under(pack, "r3");
        expect(r3).toContain("work: none yet (no card)");
        expect(r3).toContain("--- output plan");
        expect(under(pack, "r4")).toContain("--- docs/r4.md\n");
        expect(under(pack, "r4")).toContain("+r4's own");

        const filed = currentReports(yield* readDrift(runDir(dir, "r2")));
        expect(filed.map((report) => report.evidence)).toEqual([
          cited,
          [{ kind: "output", path: "build" }],
        ]);
        expect(filed[0]).toMatchObject({
          id: `d-${findingKey("small", cited)}`,
          kind: "semantic",
          run: "r2",
          intent_version: 1,
          evidence_truncated: false,
        });
        expect(currentReports(yield* readDrift(runDir(dir, "r1")))).toEqual([]);
        expect(log).toContain("2 report(s) filed");
        expect(log).toContain("r3: no card");
        expect(log).not.toContain("r4:");
      }),
    ),
  ));

test("a related Run in another repository is read in its own, wherever the judging Run works", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        const other = `${rig.root}/other`;
        yield* repositoryAt(other, { "src/b.ts": "export const b = 2;\n" });
        yield* writeCard(
          { ...watchedAt("r2"), cwd: other },
          { kind: "slice", step: "build", claims: [] },
        );
        const deps = yield* crossRunJudge([
          reportOn("r2", "small", [{ kind: "diff", path: `${other}/src/b.ts` }]),
        ]);
        const { pack } = yield* judgedAcross(["r1", "r2"], deps, { r2: other });

        expect(under(pack, "r2")).toContain("--- src/b.ts\n");
        expect(under(pack, "r2")).toContain("+export const b = 2;");
        expect(
          currentReports(yield* readDrift(runDir(dir, "r2"))).map((report) => report.evidence),
        ).toEqual([[{ kind: "diff", path: "src/b.ts" }]]);
      }),
    ),
  ));

test("a related Run whose own checkout lacks its commit is said to be unread, in git's words", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* repository();
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        const other = `${rig.root}/other`;
        yield* repositoryAt(other, { "src/b.ts": "export const b = 2;\n" });
        yield* writeCard(
          { ...watchedAt("r2"), cwd: other },
          { kind: "slice", step: "build", claims: [] },
        );
        // Something to judge, so the judge is asked.
        yield* fs.makeDirectory(`${dir}/agents/r1`, { recursive: true });
        yield* fs.writeFileString(`${dir}/agents/r1/plan.json`, '{"verdict":"planned"}');
        const deps = yield* crossRunJudge([]);
        const { pack, log } = yield* judgedAcross(["r1", "r2"], deps, { r2: dir });

        expect(under(pack, "r2")).toMatch(/diff: could not be read: \S/);
        expect(log).toMatch(/r2: diff could not be read: \S/);
      }),
    ),
  ));

test("when no related Run's work can be shown, the judge is not asked and nothing is owed", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        const deps = yield* crossRunJudge([]);
        const key = (yield* herdOf(`${rig.root}/herd.sock`))!;
        yield* standForElection(
          { ...watchedAt("r1"), herd: key, family: ["r1", "r2"] },
          "finish",
          true,
          deps,
        );

        expect(yield* fs.exists(`${rig.root}/pack.txt`)).toBe(false);
        expect(yield* fs.exists(`${dir}/budget.jsonl`)).toBe(false);
        const kinds = (yield* readElections(yield* electionsPath(dir, key))).map(
          (line) => line.kind,
        );
        expect(kinds).not.toContain("pending");
        expect(kinds).not.toContain("evaluated");
        expect(yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`)).toContain(
          "cross-run judgement not asked at ",
        );
      }),
    ),
  ));

test("a related Run's work cut to the cap is said to be, and so is what is filed against it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        yield* repository();
        yield* git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        const files: Record<string, string> = {};
        for (let n = 0; n <= MAX_FILES; n += 1)
          files[`src/f${String(n).padStart(2, "0")}.ts`] = `${n}\n`;
        yield* cardedWork("r2", files);
        const cited = [{ kind: "diff" as const, path: "src/f00.ts" }];
        const deps = yield* crossRunJudge([reportOn("r2", "small", cited)]);
        const { pack } = yield* judgedAcross(["r1", "r2"], deps);

        expect(under(pack, "r2")).toContain("TRUNCATED to the cap; judge only what is here");
        expect(under(pack, "r2")).not.toContain(`--- src/f${MAX_FILES}.ts`);
        expect(currentReports(yield* readDrift(runDir(dir, "r2")))).toMatchObject([
          { evidence: cited, evidence_truncated: true },
        ]);
      }),
    ),
  ));

const MR_223 = "https://gitlab.example.com/cego/support-backoffice/-/merge_requests/223";

/** `runId` admitted in a Task and a repository of its own, its goal `goal`, and the merge request it recorded. */
const admitted = (runId: string, goal: string | null, recorded: string | null) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* store.admit({
      request: `req-${runId}`,
      run: runId,
      workflow: "w",
      project: `${rig.root}/repo-${runId}`,
      input: {},
      provenance: {},
      options: {},
      generation: "g",
      execution: `exec-${runId}`,
      task: `task-${runId}`,
      parent: null,
    });
    const at = runDir(dir, runId);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(at, { recursive: true });
    yield* writeIntent(
      at,
      seedIntent(runId, { goal, constraints: [{ ...SMALL, id: `${runId}-c` }] }),
    );
    if (recorded !== null) yield* fs.writeFileString(`${at}/merge-request`, `${recorded}\n`);
  });

/** The family of each of `runIds`, as the host computes it from its rows. */
const familiesOf = (runIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* (yield* Store).runs;
    const families: Record<string, ReadonlyArray<string>> = {};
    for (const id of runIds)
      families[id] = [
        ...(yield* familyOf(
          rows,
          rows.find((row) => row.run === id)!,
          (one) => runDir(dir, one),
        )),
      ].sort();
    return families;
  });

test("Runs in other Tasks and repositories about one merge request are judged together, with the replies one posted there", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const families = yield* session(
          Effect.gen(function* () {
            yield* admitted("r1", "Answer the review on !223", MR_223);
            yield* admitted(
              "r2",
              `Move the backoffice work into core, as asked on ${MR_223}.`,
              null,
            );
            return yield* familiesOf(["r1", "r2"]);
          }),
        );
        expect(families).toEqual({ r1: ["r1", "r2"], r2: ["r1", "r2"] });

        yield* recordReply(runDir(dir, "r1"), {
          at: "2026-10-20T10:00:00Z",
          mr: MR_223,
          comment: `${MR_223}#note_1`,
          kind: "disputed",
          body: "Not changed: moving this into core is the human's call.\n\nPosted by Collie's Run r1 on vm-mk.",
        });
        const core = `${rig.root}/repo-r2`;
        yield* repositoryAt(core, { "src/core.ts": "export const moved = true;\n" });
        yield* writeCard(
          { ...watchedAt("r2"), cwd: core },
          { kind: "slice", step: "build", claims: [] },
        );
        const deps = yield* crossRunJudge([]);
        const { pack } = yield* judgedAcross(["r1", "r2"], deps, { r2: core });

        expect(under(pack, "r1")).toContain(
          `--- reply to ${MR_223}#note_1 (disputed)\nNot changed: moving this into core is the human's call.`,
        );
      }),
    ),
  ));

test("a Run about another merge request, or about none, is not judged with them", () =>
  runEffect(
    Effect.gen(function* () {
      const families = yield* session(
        Effect.gen(function* () {
          yield* admitted("r1", null, MR_223);
          yield* admitted("r2", `Fix ${MR_223}`, null);
          yield* admitted("r3", null, MR_223.replace("/223", "/224"));
          yield* admitted("r4", "Move the backoffice work into core", null);
          yield* admitted("r5", `Fix ${MR_223.replace("/223", "/224")}`, null);
          return yield* familiesOf(["r1", "r3", "r4", "r5"]);
        }),
      );
      expect(families).toEqual({
        r1: ["r1", "r2"],
        r3: ["r3", "r5"],
        r4: ["r4"],
        r5: ["r3", "r5"],
      });
    }),
  ));

test("the cross-run judge is told a Run contradicting what another posted on their merge request is drift", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        yield* intended("r1", [R1_ONLY]);
        yield* intended("r2", [SMALL]);
        yield* repository();
        yield* git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
        yield* cardedWork("r2", { "src/a.ts": "export const a = 1;\n" });
        const { pack } = yield* judgedAcross(["r1", "r2"], yield* crossRunJudge([]));

        expect(pack.replace(/\s+/g, " ")).toContain(
          "A Run whose goal or work contradicts what another Run replied on the merge request they are both about is drift: report it on that Run, citing its own work.",
        );
      }),
    ),
  ));

// --- Drift during an unfinished integration -------------------------------------------

/**
 * The host's repository left mid-merge: the Run changed `src/own.ts` and `src/shared.ts`,
 * the default branch changed `src/shared.ts` and `src/upstream.ts`, and `src/shared.ts`
 * conflicts. Returns where the Run left the default branch.
 */
const midMerge = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* repository();
    yield* fs.makeDirectory(`${dir}/src`, { recursive: true });
    const commitFiles = (files: Readonly<Record<string, string>>) =>
      Effect.gen(function* () {
        for (const [name, text] of Object.entries(files))
          yield* fs.writeFileString(`${dir}/${name}`, text);
        yield* git(["add", ...Object.keys(files)]);
        yield* git(["commit", "-qm", Object.keys(files).join(" ")]);
      });
    yield* git(["checkout", "-q", "-b", "trunk"]);
    yield* commitFiles({ "src/shared.ts": "one\n" });
    const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
    yield* git(["checkout", "-q", "-b", "work"]);
    yield* commitFiles({ "src/own.ts": "mine\n", "src/shared.ts": "ours\n" });
    yield* git(["checkout", "-q", "trunk"]);
    yield* commitFiles({ "src/shared.ts": "theirs\n", "src/upstream.ts": "incoming\n" });
    yield* git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    yield* git(["checkout", "-q", "work"]);
    yield* git(["merge", "--no-edit", "origin/main"]);
    expect((yield* git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode).toBe(0);
    return base;
  });

test("mid-merge, drift's evidence is the Run's side only, never the default branch's", () =>
  runEffect(
    Effect.gen(function* () {
      const base = yield* midMerge();
      const evidence = yield* evidenceFor(dir, [], base);
      expect(evidence.blocks.map((block) => block.path)).toEqual(["src/own.ts", "src/shared.ts"]);
      const facts = yield* ruleFacts(watchedAt("r1"));
      expect(facts.changedFiles).toContain("src/own.ts");
      expect(facts.changedFiles).toContain("src/shared.ts");
      expect(facts.changedFiles).not.toContain("src/upstream.ts");
    }),
  ));

test("with no merge under way, drift's evidence is what was committed and what is not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* repository();
      const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.makeDirectory(`${dir}/src`, { recursive: true });
      yield* fs.writeFileString(`${dir}/src/kept.ts`, "one\n");
      yield* git(["add", "src/kept.ts"]);
      yield* git(["commit", "-qm", "kept"]);
      yield* fs.writeFileString(`${dir}/src/kept.ts`, "two\n");
      yield* fs.writeFileString(`${dir}/notes.txt`, "new\n");

      const evidence = yield* evidenceFor(dir, [], base);
      expect(evidence.blocks.map((block) => block.path)).toEqual(["src/kept.ts", "src/kept.ts"]);
      expect(evidence.blocks[0]?.diff).toContain("+one");
      expect(evidence.blocks[1]?.diff).toContain("+two");
      expect((yield* ruleFacts(watchedAt("r1"))).changedFiles).toEqual([
        "src/kept.ts",
        "notes.txt",
      ]);
    }),
  ));

test("a boundary reached with an integration's conflicts open is not judged, and nothing is skipped", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* midMerge();
        yield* intended("r1", [SMALL]);
        const deps = yield* crossRunJudge([]);
        yield* checkDrift(watchedAt("r1"), "boundary before build", "boundary", deps, null);

        expect(yield* fs.exists(`${rig.root}/pack.txt`)).toBe(false);
        expect(yield* fs.readFileString(`${runDir(dir, "r1")}/log.txt`)).toContain(
          "drift not judged at boundary before build: an integration's conflicts are open",
        );
        expect(yield* readDrift(runDir(dir, "r1"))).toEqual([]);

        yield* fs.writeFileString(`${dir}/src/shared.ts`, "both\n");
        yield* git(["commit", "-qam", "integrated"]);
        yield* checkDrift(watchedAt("r1"), "finish", "finish", deps, null);
        expect(yield* fs.exists(`${rig.root}/pack.txt`)).toBe(true);
      }),
    ),
  ));
