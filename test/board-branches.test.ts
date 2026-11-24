import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schedule } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { boardLines, buildBoard } from "../src/board";
import { Branches, branchKey, readBranch } from "../src/branches";
import { appendCard, buildCard } from "../src/cards";
import { readEnv } from "../src/env";
import { shell } from "../src/mr";
import type { RunFacts } from "../src/runs";
import type { TaskView } from "../src/board-model";
import { gitSync } from "../src/side-jobs";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const NOW = epochMs("2026-10-30T10:00:00Z");
const AT = "2026-10-30T09:30:00Z";

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
  yield* writeFinal(run.dir, run.id, "abc");
  return { env: readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" }), run };
});

const writeFinal = (dir: string, id: string, head: string) =>
  appendCard(
    dir,
    buildCard({
      run: id,
      kind: "final",
      step: "finish",
      iteration: 1,
      at: AT,
      intentVersion: 1,
      revision: { branch: "feature", head_sha: head, fingerprint: "f1", dirty: false },
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

const drawn = (env: ReturnType<typeof readEnv>, run: RunFacts) =>
  Effect.gen(function* () {
    const started: Array<string> = [];
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
      expect(views[0]?.moved ?? null).toBeNull();
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
              { head: "def", project: null, movements: [{ finished: "abc", said }] },
            ],
          ]),
        ),
      );
      const { views, started } = yield* drawn(env, run);
      expect(started).toEqual([]);
      expect(views[0]?.moved).toBe(said);
      expect(views[0]?.drift).toBeNull();
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
      ]) {
        expect((yield* shell("git", args, dir)).code).toBe(0);
      }
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

test("Git sync reads every Run that ended on a branch, not only the last of them it saw", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-git-sync-two-" });
      const repo = `${root}/repo`;
      const origin = `${root}/origin.git`;
      const git = (...args: Array<string>) => shell("git", args, repo);
      yield* fs.makeDirectory(repo);
      expect((yield* shell("git", ["init", "-q", "--bare", origin], root)).code).toBe(0);
      expect((yield* git("init", "-q", "-b", "feature")).code).toBe(0);
      expect((yield* git("remote", "add", "origin", origin)).code).toBe(0);
      const heads: Array<string> = [];
      for (const message of ["one", "two"]) {
        expect(
          (yield* git(
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            message,
          )).code,
        ).toBe(0);
        heads.push(Str.trim((yield* git("rev-parse", "HEAD")).stdout));
        expect((yield* git("push", "-qu", "origin", "HEAD")).code).toBe(0);
      }
      const [older, later] = [
        yield* madeRun(`${root}/older`, {
          id: "older",
          state: "succeeded",
          branch: "feature",
          cwd: repo,
          created: "2026-10-30T09:00:00Z",
          finished: AT,
        }),
        yield* madeRun(`${root}/later`, {
          id: "later",
          state: "succeeded",
          branch: "feature",
          cwd: repo,
          created: "2026-10-30T09:10:00Z",
          finished: AT,
        }),
      ];
      yield* writeFinal(older.dir, older.id, heads[0]!);
      yield* writeFinal(later.dir, later.id, heads[1]!);
      const views = yield* buildBoard({
        env: readEnv({ COLLIE_STATE_DIR: root, COLLIE_CWD: repo }),
        runs: [older, later],
        registered: [],
        now: NOW,
        offers: () => Effect.succeed([]),
      });
      yield* Effect.forkScoped(gitSync(Effect.succeed({ runs: [older, later], views })));
      const row = yield* Branches.use((branches) => branches.all).pipe(
        Effect.map((rows) => rows.get(branchKey(repo, "feature"))),
        Effect.filterOrFail(
          (found) => Arr.length(found?.movements ?? []) >= 2,
          () => "both Runs' lines were read",
        ),
        Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
      );
      expect(Arr.map(row?.movements ?? [], (one) => one.finished)).toEqual(heads);
      expect(Arr.findFirst(row?.movements ?? [], (one) => one.finished === heads[0])).toMatchObject(
        {
          value: { said: expect.stringContaining("moved past") },
        },
      );
      expect(Arr.findFirst(row?.movements ?? [], (one) => one.finished === heads[1])).toMatchObject(
        {
          value: { said: null },
        },
      );
    }),
  ));

test("a card reads the line about the Run it shows, not another Run's on the same branch", () =>
  runEffect(
    Effect.gen(function* () {
      const { env, run } = yield* finishedOnFeature;
      yield* Branches.use((branches) =>
        branches.put(
          new Map([
            [
              branchKey("/project", "feature"),
              {
                head: "def",
                project: null,
                movements: [
                  { finished: "abc", said: "this Run's line" },
                  { finished: "older", said: "an earlier Run's line" },
                ],
              },
            ],
          ]),
        ),
      );
      const { views, started } = yield* drawn(env, run);
      expect(started).toEqual([]);
      expect(views[0]?.moved).toBe("this Run's line");
    }),
  ));

test("a row that has not read the Run's own head shows no line and asks Git sync for it", () =>
  runEffect(
    Effect.gen(function* () {
      const { env, run } = yield* finishedOnFeature;
      yield* Branches.use((branches) =>
        branches.put(
          new Map([
            [
              branchKey("/project", "feature"),
              {
                head: "def",
                project: null,
                movements: [{ finished: "older", said: "an earlier Run's line" }],
              },
            ],
          ]),
        ),
      );
      const { views } = yield* drawn(env, run);
      expect(views[0]?.moved ?? null).toBeNull();
      const wanted = yield* Branches.use((branches) => branches.wanted);
      expect(Arr.map(wanted, (one) => branchKey(one.cwd, one.branch))).toContain(
        branchKey("/project", "feature"),
      );
    }),
  ));

test("a head its recorded commit is not in the checkout says the history could not be compared, not that it diverged", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-branch-unchecked-" });
      const repo = `${root}/repo`;
      const origin = `${root}/origin.git`;
      const git = (cwd: string, ...args: Array<string>) => shell("git", args, cwd);
      yield* fs.makeDirectory(repo);
      expect((yield* git(root, "init", "-q", "--bare", origin)).code).toBe(0);
      expect((yield* git(repo, "init", "-q", "-b", "feature")).code).toBe(0);
      expect((yield* git(repo, "remote", "add", "origin", origin)).code).toBe(0);
      for (const message of ["one", "two"]) {
        expect(
          (yield* git(
            repo,
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            message,
          )).code,
        ).toBe(0);
        expect((yield* git(repo, "push", "-qu", "origin", "HEAD")).code).toBe(0);
      }
      const head = Str.trim((yield* git(repo, "rev-parse", "HEAD")).stdout);
      const absent = "0123456789abcdef0123456789abcdef01234567";
      yield* writeFinal(`${root}/run`, "r1", absent);
      const row = yield* readBranch(
        [{ cwd: repo, dir: `${root}/run`, branch: "feature", state: "failed" }],
        [{ finished: absent, said: "earlier" }],
      );
      const said = row.movements[0]?.said ?? "";
      expect(said).toContain("could not be compared");
      expect(said).not.toContain("diverged");
      expect(row.head).toBe(head);
    }),
  ));

test("a finished Run's card shows its follow-up beside the line that moved, without opening a menu", () =>
  runEffect(
    Effect.gen(function* () {
      const { env, run } = yield* finishedOnFeature;
      yield* Branches.use((branches) =>
        branches.put(
          new Map([
            [
              branchKey("/project", "feature"),
              { head: "def", project: null, movements: [{ finished: "abc", said: "moved on" }] },
            ],
          ]),
        ),
      );
      const { views } = yield* drawn(env, run);
      const shown: Array<TaskView> = [
        { ...views[0]!, offers: [{ id: "recover", title: "Recover — Review", run: run.id }] },
      ];
      expect(Arr.join(boardLines(shown), "\n")).toContain("moved on\n    ↪ Recover — Review");
    }),
  ));
