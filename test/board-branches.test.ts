import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schedule } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { buildBoard } from "../src/board";
import { Branches, branchKey } from "../src/branches";
import { appendCard, buildCard } from "../src/cards";
import { readEnv } from "../src/env";
import { shell } from "../src/mr";
import type { RunFacts } from "../src/runs";
import { gitSync } from "../src/side-jobs";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const NOW = epochMs("2026-10-30T10:00:00Z");
const AT = "2026-10-30T09:30:00Z";

/** A Run that finished on `feature` at `abc`, whose pushed branch a card would compare. */
const finishedOnFeature = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-branches-" });
  const run = yield* madeRun(dir, {
    state: "succeeded",
    branch: "feature",
    cwd: "/project",
    created: "2026-10-30T09:00:00Z",
    finished: AT,
  });
  yield* appendCard(
    run.dir,
    buildCard({
      run: run.id,
      kind: "final",
      step: "finish",
      iteration: 1,
      at: AT,
      intentVersion: 1,
      revision: { branch: "feature", head_sha: "abc", fingerprint: "f1", dirty: false },
      changes: { files: [], commits: [] },
      requested: { goal: null, constraints: [] },
      verifications: [],
      claims: [],
      missing: [],
      inspect: [],
      links: {},
      drift: [],
      deliveries: [],
      narrative: null,
      aligned: "unverified",
      crossRun: "none",
      significance: {
        readiness: "claimed",
        mrTouched: false,
        pendingChoice: false,
        driftUnresolved: false,
        pendingProposal: false,
        correctionUnacknowledged: false,
        blockingDrift: false,
        correctionSent: false,
        intentChanged: false,
        ended: null,
      },
    }),
  );
  return { env: readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" }), run };
});

/** A board build whose every process start is recorded and refused. */
const drawn = (env: ReturnType<typeof readEnv>, run: RunFacts) =>
  Effect.gen(function* () {
    const started: string[] = [];
    const views = yield* buildBoard({
      env,
      runs: [run],
      registered: [],
      now: NOW,
      offers: () => Effect.succeed([]),
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          started.push(command._tag === "StandardCommand" ? command.command : "pipeline");
          return Effect.die(new Error("a board build must not start a process"));
        }),
      ),
    );
    return { views, started };
  });

test("a build with no synced row for a branch runs no git, shows no movement and asks Git sync for it", () =>
  runEffect(
    Effect.gen(function* () {
      const { env, run } = yield* finishedOnFeature;
      const { views, started } = yield* drawn(env, run);
      expect(started).toEqual([]);
      expect(views[0]?.drift).toBeNull();
      const wanted = yield* Branches.use((branches) => branches.wanted);
      expect(Arr.map(wanted, (one) => branchKey(one.cwd, one.branch))).toContain(
        branchKey("/project", "feature"),
      );
    }),
  ));

test("a card whose synced row records the branch moving says so", () =>
  runEffect(
    Effect.gen(function* () {
      const { env, run } = yield* finishedOnFeature;
      const said = "Pushed branch moved past the finished record.";
      yield* Branches.use((branches) =>
        branches.put(
          new Map([
            [
              branchKey("/project", "feature"),
              { head: "def", project: null, movement: { finished: "abc", said } },
            ],
          ]),
        ),
      );
      const { views, started } = yield* drawn(env, run);
      expect(started).toEqual([]);
      expect(views[0]?.drift).toBe(said);
    }),
  ));

test("Git sync reads a branch a build asked for on its next round", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-git-sync-" });
      for (const args of [
        ["init", "-q", "-b", "feature"],
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "one",
        ],
      ])
        expect((yield* shell("git", args, dir)).code).toBe(0);
      const head = Str.trim((yield* shell("git", ["rev-parse", "HEAD"], dir)).stdout);
      const branches = yield* Branches;
      yield* branches.want({ cwd: dir, dir: `${dir}/run`, branch: "feature", state: "running" });
      yield* Effect.forkScoped(gitSync(Effect.succeed({ runs: [], views: [] })));
      const row = yield* branches.all.pipe(
        Effect.map((rows) => rows.get(branchKey(dir, "feature"))),
        Effect.filterOrFail((found) => found !== undefined),
        Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
      );
      expect(row?.head).toBe(head);
    }),
  ));
