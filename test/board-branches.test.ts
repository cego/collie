import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Data, Effect, FileSystem, Ref, Schedule, pipe } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { boardLines, buildBoard } from "../src/board";
import { Branches, branchKey, readBranch } from "../src/branches";
import { appendCard, buildCard } from "../src/cards";
import { readEnv } from "../src/env";
import { shell } from "../src/mr";
import type { RunFacts, RunState } from "../src/runs";
import type { Branch } from "../src/branches";
import type { TaskView } from "../src/board-model";
import { gitSync } from "../src/side-jobs";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const until = <A, R>(read: () => Effect.Effect<A, never, R>, wanted: (value: A) => boolean) =>
  Effect.suspend(read).pipe(
    Effect.filterOrFail(wanted, () => new NotYet()),
    Effect.retry({ times: 400, schedule: Schedule.spaced("25 millis") }),
  );

class NotYet extends Data.TaggedError("NotYet") {}

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
              { head: "def", project: null, movements: [{ run: run.id, finished: "abc", said }] },
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
      yield* branches.want({
        id: "r1",
        cwd: dir,
        dir: `${dir}/run`,
        branch: "feature",
        state: "running",
      });
      yield* Effect.forkScoped(gitSync(Effect.succeed({ runs: [], views: [] })));
      const row = yield* branches.all.pipe(
        Effect.map((rows) => rows.get(branchKey(dir, "feature"))),
        Effect.filterOrFail((found) => found !== undefined),
        Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
      );
      expect(row?.head).toBe(head);
    }),
  ));

test("a failed and a succeeded Run at the same head each read their own outcome", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-shared-head-" });
      const made = (id: string, state: RunState) =>
        Effect.gen(function* () {
          const run = yield* madeRun(root, {
            id,
            state,
            branch: "feature",
            cwd: "/project",
            created: "2026-10-30T09:00:00Z",
            finished: AT,
          });
          yield* writeFinal(run.dir, run.id, "abc");
          return run;
        });
      const failed = yield* made("r-failed", "failed");
      const succeeded = yield* made("r-succeeded", "succeeded");
      const moved = "Pushed branch moved past abc: 1 commit since, now def.";
      const stale = `${moved} The failed record is stale.`;
      const earlier = `${moved} The succeeded record describes the earlier head.`;
      yield* Branches.use((branches) =>
        branches.put(
          new Map([
            [
              branchKey("/project", "feature"),
              {
                head: "def",
                project: null,
                movements: [
                  { run: failed.id, finished: "abc", said: stale },
                  { run: succeeded.id, finished: "abc", said: earlier },
                ],
              },
            ],
          ]),
        ),
      );
      const views = yield* buildBoard({
        env: readEnv({ COLLIE_STATE_DIR: root, COLLIE_CWD: "/project" }),
        runs: [failed, succeeded],
        registered: [],
        now: NOW,
        offers: () => Effect.succeed([]),
      });
      expect(Arr.map(views, (one) => one.moved)).toEqual([stale, earlier]);
    }),
  ));

test("a sync keeps a line for every finished head a branch holds, however many there are", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-branch-many-" });
      const repo = `${root}/repo`;
      const origin = `${root}/origin.git`;
      yield* fs.makeDirectory(repo);
      expect((yield* shell("git", ["init", "-q", "--bare", origin], root)).code).toBe(0);
      const git = (...args: Array<string>) => shell("git", args, repo);
      expect((yield* git("init", "-q", "-b", "feature")).code).toBe(0);
      expect((yield* git("remote", "add", "origin", origin)).code).toBe(0);
      const heads: Array<string> = [];
      for (const message of Arr.range(1, 10)) {
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
            `one-${message}`,
          )).code,
        ).toBe(0);
        heads.push(Str.trim((yield* git("rev-parse", "HEAD")).stdout));
      }
      const runs = yield* Effect.forEach(heads, (head, index) =>
        Effect.gen(function* () {
          const made = yield* madeRun(`${root}/run-${index}`, {
            id: `r-many-${index}`,
            state: "succeeded",
            branch: "feature",
            cwd: repo,
            created: "2026-10-30T09:00:00Z",
            finished: AT,
          });
          yield* writeFinal(made.dir, made.id, head);
          return made;
        }),
      );
      const row = yield* readBranch(runs);
      expect(Arr.map(row.movements, (one) => one.run)).toEqual(Arr.map(runs, (one) => one.id));
    }),
  ));

test("an incremental sync re-reads every Run on a branch a changed card put back in view", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-git-sync-incremental-" });
      const repo = `${root}/repo`;
      const origin = `${root}/origin.git`;
      yield* fs.makeDirectory(repo);
      expect((yield* shell("git", ["init", "-q", "--bare", origin], root)).code).toBe(0);
      const git = (...args: Array<string>) => shell("git", args, repo);
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
      const made = (id: string, head: string) =>
        Effect.gen(function* () {
          const run = yield* madeRun(`${root}/${id}`, {
            id,
            state: "succeeded",
            branch: "feature",
            cwd: repo,
            created: "2026-10-30T09:00:00Z",
            finished: AT,
          });
          yield* writeFinal(run.dir, run.id, head);
          return run;
        });
      const older = yield* made("older", heads[0]!);
      const later = yield* made("later", heads[1]!);
      const env = readEnv({ COLLIE_STATE_DIR: root, COLLIE_CWD: repo });
      const views = yield* buildBoard({
        env,
        runs: [older, later],
        registered: [],
        now: NOW,
        offers: () => Effect.succeed([]),
      });
      const card = (id: string, runId: string, seq: number) => ({
        ...views[0]!,
        id,
        runs: [runId],
        revision: { epoch: "e", seq },
      });
      const phase = yield* Ref.make(1);
      yield* Effect.forkScoped(
        gitSync(
          Ref.get(phase).pipe(
            Effect.map((seq) => ({
              runs: [older, later],
              views: [card("card-older", older.id, 1), card("card-later", later.id, seq)],
            })),
          ),
        ),
      );
      const rows = Branches.use((branches) => branches.all);
      const lines = (rows: ReadonlyMap<string, Branch>) =>
        Arr.map(rows.get(branchKey(repo, "feature"))?.movements ?? [], (one) => one.said ?? "");
      yield* until(
        () => rows,
        (all) => Arr.length(lines(all)) === 2,
      );
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
          "three",
        )).code,
      ).toBe(0);
      expect((yield* git("push", "-qu", "origin", "HEAD")).code).toBe(0);
      const pushed = Str.trim((yield* git("rev-parse", "HEAD")).stdout);
      yield* Ref.set(phase, 2);
      yield* until(
        () => rows,
        (all) =>
          Arr.length(lines(all)) === 2 &&
          Arr.every(lines(all), (line) => pipe(line, Str.includes(pushed))),
      );
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
      expect(Arr.map(row?.movements ?? [], (one) => one.run)).toEqual(["older", "later"]);
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
                  { run: run.id, finished: "abc", said: "this Run's line" },
                  { run: "someone-else", finished: "older", said: "an earlier Run's line" },
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
                movements: [
                  { run: "someone-else", finished: "older", said: "an earlier Run's line" },
                ],
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
      const row = yield* readBranch([
        { id: "r1", cwd: repo, dir: `${root}/run`, branch: "feature", state: "failed" },
      ]);
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
              {
                head: "def",
                project: null,
                movements: [{ run: "r1", finished: "abc", said: "moved on" }],
              },
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
