// What the host does on its own, with no pane open: the merge watch, News and pruning.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { readAudit } from "../src/audit";
import { readDispositions } from "../src/disposition";
import { recordReply } from "../src/replies";
import { evidenceDir, runDir } from "../src/engine";
import { factsOfView } from "../src/runs";
import { readVerifications } from "../src/verify";
import { currentEnv, readEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { connect, frontDoor, socketOf } from "../src/host";
import { shareBoard } from "../src/board-stream";
import { sideJobs } from "../src/side-jobs";
import { newsPath, pending, read as readNews } from "../src/news";
import { herdOf } from "../src/steering";
import { writeTask } from "../src/task";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { fastForward } from "./support/effect";
import { forgeOnPath, runOnPath, serveForges } from "./support/forge";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

const MR = "mr:gitlab.example.com/mk/project!7";

/** A glab on `PATH`, served over HTTP too, that says the merge request has merged. */
const mergedForge = Effect.fn("sideJobs.mergedForge")(function* (dir: string) {
  const bin = yield* FakeBin.make(dir);
  const gitlab = yield* forgeOnPath(bin, "gitlab", {
    installed: true,
    loggedIn: ["gitlab.example.com"],
    login: "me",
    mrs: [{ project: "gitlab.example.com/mk/project", iid: "7", state: "merged", title: "Cards" }],
  });
  const COLLIE_FORGE_API = yield* serveForges(gitlab);
  yield* bin.restore();
  return { PATH: `${bin.dir}:/usr/bin:/bin`, COLLIE_FORGE_API };
});

const asSessions = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, socket_path: Schema.String })),
  ),
);

const runIdOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(envelope.data).pipe(
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

const until = <A, R>(read: Effect.Effect<A, never, R>, done: (a: A) => boolean) =>
  read.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("250 millis"), times: 120 }));

test(
  "with no pane open the host asks GitLab about a waiting merge request and records the merge",
  () =>
    proves(
      "collie-side-merges-",
      (world) =>
        Effect.gen(function* () {
          yield* writeTask(world.state, {
            id: "task-1",
            workspace: "w1",
            label: "project | Targeted",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.orDie);
          const forge = yield* mergedForge(`${world.home}/bin`);
          const started = yield* collie(
            world,
            ["run", "start", "targeted", "--task", "task-1", "--input", `target=${MR}`],
            forge,
          );
          expect(started.envelope.ok).toBe(true);
          const runId = yield* runIdOf(started.envelope);
          const recorded = yield* until(
            readDispositions(`${world.state}/runs/${runId}`).pipe(Effect.orElseSucceed(() => [])),
            (lines) => lines.length > 0,
          );
          yield* stopHost(world.state);
          expect(recorded.map((line) => [line.by, line.kind, line.ref])).toEqual([
            ["gitlab", "merged", "mk/project!7"],
          ]);
        }),
      ["targeted.workflow.ts"],
    ),
  120_000,
);

test(
  "a merge the host's watch reads stops what in its Task is still going, as the host and saying why",
  () =>
    proves(
      "collie-side-settle-",
      (world) =>
        Effect.gen(function* () {
          yield* writeTask(world.state, {
            id: "task-1",
            workspace: "w1",
            label: "project | Targeted",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.orDie);
          const forge = yield* mergedForge(`${world.home}/bin`);
          const started = yield* collie(
            world,
            ["run", "start", "targeted-parks", "--task", "task-1", "--input", `target=${MR}`],
            forge,
          );
          expect(started.envelope.ok).toBe(true);
          const runId = yield* runIdOf(started.envelope);
          const stops = yield* until(
            readAudit(`${world.state}/runs/${runId}`).pipe(
              Effect.map((lines) => lines.filter((line) => line.operation === "stop")),
              Effect.orElseSucceed(() => []),
            ),
            (lines) => lines.length > 0,
          );
          yield* stopHost(world.state);
          expect(stops.map((line) => [line.actor.origin, line.reason])).toEqual([
            ["host", "mk/project!7 merged"],
          ]);
        }),
      ["targeted-parks.workflow.ts"],
    ),
  120_000,
);

test(
  "a merge stops a Run of its Task without the child it started in another Task",
  () =>
    proves(
      "collie-side-settle-child-",
      (world) =>
        Effect.gen(function* () {
          yield* writeTask(world.state, {
            id: "task-1",
            workspace: "w1",
            label: "project | Targeted",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.orDie);
          const forge = yield* mergedForge(`${world.home}/bin`);
          const started = yield* collie(
            world,
            ["run", "start", "targeted-parent", "--task", "task-1", "--input", `target=${MR}`],
            forge,
          );
          expect(started.envelope.ok).toBe(true);
          const runId = yield* runIdOf(started.envelope);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          yield* until(
            client.run({ runId: `${runId}.aside` }).pipe(Effect.orElseSucceed(() => null)),
            (view) => view?.parked !== null && view?.parked !== undefined,
          );
          yield* until(
            readAudit(`${world.state}/runs/${runId}`).pipe(
              Effect.map((lines) => lines.some((line) => line.operation === "stop")),
              Effect.orElseSucceed(() => false),
            ),
            (stopped) => stopped,
          );
          const aside = yield* client.run({ runId: `${runId}.aside` }).pipe(Effect.orDie);
          yield* stopHost(world.state);
          expect(aside?.controls).toEqual([]);
        }),
      ["targeted-parent.workflow.ts", "targeted-parks.workflow.ts"],
    ),
  120_000,
);

test(
  "the host retires an answered question's News, and a finished Run's once its work is disposed",
  () =>
    proves(
      "collie-side-superseded-",
      (world) =>
        Effect.gen(function* () {
          const socket = `${world.home}/desk.sock`;
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "desk" })
            .pipe(Effect.orDie);
          const desk = {
            HERDR_SOCKET_PATH: socket,
            HERDR_WORKSPACE_ID: workspace.workspaceId,
            FAKE_HERDR_SESSIONS: asSessions([{ name: "desk", socket_path: socket }]),
          };
          const started = yield* collie(
            world,
            ["run", "start", "proof", "--here", "--input", "note=hi"],
            desk,
          );
          expect(started.envelope.ok).toBe(true);
          const runId = yield* runIdOf(started.envelope);
          const file = yield* newsPath(world.state, yield* herdOf(socket));
          // Another conversation's view, so nothing Native chat read can hide an item here.
          const keys = readNews(file).pipe(
            Effect.map((lines) => pending(lines, "flock@pc").items.map((item) => item.key)),
          );
          const asked = `${runId}:asking:decision`;
          const ended = `${runId}:ended:succeeded`;
          yield* until(keys, (now) => now.includes(asked));
          expect(
            (yield* collie(world, ["run", "answer", runId, "approve"], desk)).envelope.ok,
          ).toBe(true);
          const answered = yield* until(keys, (now) => !now.includes(asked) && now.includes(ended));
          expect(answered).toEqual([ended]);
          const disposed = yield* collie(
            world,
            ["run", "disposition", runId, "--as", "merged", "--ref", "mk/project!7"],
            desk,
          );
          expect(disposed.envelope.ok).toBe(true);
          const after = yield* until(keys, (now) => now.length === 0);
          // Two more rounds, so a retired cause said again would show.
          yield* Effect.sleep("11 seconds");
          const lines = yield* readNews(file);
          yield* stopHost(world.state);
          expect(after).toEqual([]);
          // Retired, and kept: the journal still says what was news and that it stopped being.
          expect(
            lines.flatMap((line) => (line.kind === "superseded" ? [line.key] : [])).sort(),
          ).toEqual([asked, ended].sort());
          expect(lines.filter((line) => line.kind === "item").map((line) => line.key)).toEqual([
            asked,
            ended,
          ]);
        }),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test(
  "the host writes a Run's News to its own Herd and to no other",
  () =>
    proves(
      "collie-side-news-",
      (world) =>
        Effect.gen(function* () {
          const first = `${world.home}/first.sock`;
          const second = `${world.home}/second.sock`;
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "builds" })
            .pipe(Effect.orDie);
          const started = yield* collie(
            world,
            ["run", "start", "plain", "--here", "--input", "note=hi"],
            {
              HERDR_SOCKET_PATH: second,
              HERDR_WORKSPACE_ID: workspace.workspaceId,
              FAKE_HERDR_SESSIONS: asSessions([
                { name: "desk", socket_path: first },
                { name: "builds", socket_path: second },
              ]),
            },
          );
          expect(started.envelope.ok).toBe(true);
          const herds = yield* Effect.scoped(
            Effect.gen(function* () {
              const door = yield* frontDoor(socketOf(world.state));
              const head = yield* Stream.runHead(door.board());
              return head._tag === "Some" && head.value._tag === "Snapshot" ? head.value.herds : [];
            }),
          ).pipe(Effect.orDie);
          const newsOf = (name: string) =>
            newsPath(world.state, herds.find((herd) => herd.name === name)!.id).pipe(
              Effect.flatMap(readNews),
            );
          const builds = yield* until(newsOf("builds"), (lines) => lines.length > 0);
          const desk = yield* newsOf("desk");
          yield* stopHost(world.state);
          expect(builds.map((line) => line.kind === "item" && line.run)).toEqual([
            yield* runIdOf(started.envelope),
          ]);
          expect(desk).toEqual([]);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test("News and the merge watch read the host's latest board, and list no Runs of their own", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-side-shared-" });
      const env = readEnv({
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_SOCKET_PATH: `${stateDir}/none.sock`,
        COLLIE_CWD: stateDir,
      });
      let listings = 0;
      let reads = 0;
      const { boards } = yield* shareBoard({
        build: Effect.sync(() => {
          listings++;
          return { runs: [], views: [] };
        }),
        changed: Stream.never,
      });
      const board = Stream.runHead(boards).pipe(
        Effect.tap(() => Effect.sync(() => reads++)),
        Effect.flatMap((latest) =>
          latest._tag === "Some" ? Effect.succeed(latest.value) : Effect.never,
        ),
      );
      yield* sideJobs({
        env,
        herdr: new Herdr(env),
        board,
        panels: new Map(),
        record: () => Effect.void,
        stop: () => Effect.void,
        sweepers: Effect.succeed([]),
      }).pipe(Effect.timeout("12 seconds"), Effect.ignore, fastForward);
      // Two merge looks and three News looks at least, on one build.
      expect(reads).toBeGreaterThanOrEqual(5);
      expect(listings).toBe(1);
    }),
  ));

test(
  "a merge while a Run waits on its check left to CI stops the Run, records the merge, and proves nothing",
  () =>
    proves(
      "collie-side-ci-merged-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${world.project}/thing.txt`, "one\n").pipe(Effect.orDie);
          yield* exec(["git", "add", "-A"], { cwd: world.project });
          yield* exec(
            ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "one"],
            { cwd: world.project },
          );
          const head = (yield* exec(["git", "rev-parse", "HEAD"], {
            cwd: world.project,
          })).stdout.trim();
          yield* writeTask(world.state, {
            id: "task-1",
            workspace: "w1",
            label: "project | Waits on CI",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.orDie);
          const bin = yield* FakeBin.make(`${world.home}/bin`);
          const gitlab = yield* forgeOnPath(bin, "gitlab", {
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [
              {
                project: "gitlab.example.com/mk/project",
                iid: "7",
                state: "merged",
                head,
                mergedAt: "2099-01-01T00:00:00Z",
                jobs: [{ name: "nuxi-job", state: "running" }],
              },
            ],
          });
          const PATH = `${bin.dir}:/usr/bin:/bin`;
          const COLLIE_FORGE_API = yield* serveForges(gitlab);
          yield* bin.restore();
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "waits-on-ci",
              "--task",
              "task-1",
              "--input",
              "mr=https://gitlab.example.com/mk/project/-/merge_requests/7",
              "--input",
              `workspace=${world.project}`,
              "--verify",
              `{"name":"nuxi","executable":"true","argv":[],"cwd":".","ci":"nuxi-job"}`,
            ],
            { PATH, COLLIE_FORGE_API },
          );
          expect(started.envelope.ok).toBe(true);
          const runId = yield* runIdOf(started.envelope);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const ended = yield* until(
            client.run({ runId }).pipe(Effect.orElseSucceed(() => null)),
            // Suspended, so the wait itself ended rather than polling on under the stop.
            (view) => view?.status.status === "suspended",
          );
          const log = yield* fs
            .readFileString(`${world.state}/runs/${runId}/log.txt`)
            .pipe(Effect.orElseSucceed(() => ""));
          const recorded = yield* readVerifications(evidenceDir(world.state, runId)).pipe(
            Effect.orElseSucceed(() => []),
          );
          const merged = yield* readDispositions(`${world.state}/runs/${runId}`);
          yield* stopHost(world.state);
          expect(factsOfView(world.state, ended!).state).toBe("stopped");
          expect(ended?.status.status).toBe("suspended");
          expect(log).toContain(`ci: waiting on job nuxi-job for nuxi on ${head}`);
          expect(recorded.filter((one) => one.pass === "ci")).toEqual([]);
          expect(merged.map((line) => [line.kind, line.ref])).toEqual([["merged", "mk/project!7"]]);
        }),
      ["waits-on-ci.workflow.ts"],
    ),
  120_000,
);

test(
  "a finished Run's News is retired once it is seen, for a conversation that never read it",
  () =>
    proves(
      "collie-side-seen-",
      (world) =>
        Effect.gen(function* () {
          const socket = `${world.home}/desk.sock`;
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "desk" })
            .pipe(Effect.orDie);
          const desk = {
            HERDR_SOCKET_PATH: socket,
            HERDR_WORKSPACE_ID: workspace.workspaceId,
            FAKE_HERDR_SESSIONS: asSessions([{ name: "desk", socket_path: socket }]),
          };
          const started = yield* collie(
            world,
            ["run", "start", "plain", "--here", "--input", "note=hi"],
            desk,
          );
          const runId = yield* runIdOf(started.envelope);
          const file = yield* newsPath(world.state, yield* herdOf(socket));
          const keys = readNews(file).pipe(
            Effect.map((lines) => pending(lines, "flock@pc").items.map((item) => item.key)),
          );
          const ended = `${runId}:ended:succeeded`;
          expect(yield* until(keys, (now) => now.includes(ended))).toEqual([ended]);
          expect((yield* collie(world, ["run", "seen", runId], desk)).envelope.ok).toBe(true);
          const after = yield* until(keys, (now) => now.length === 0);
          const lines = yield* readNews(file);
          yield* stopHost(world.state);
          expect(after).toEqual([]);
          expect(lines.flatMap((line) => (line.kind === "superseded" ? [line.key] : []))).toEqual([
            ended,
          ]);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "a reply that disputed a reviewer is News, keyed by the comment, and a fixed one is not",
  () =>
    proves(
      "collie-side-replied-",
      (world) =>
        Effect.gen(function* () {
          const socket = `${world.home}/desk.sock`;
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "desk" })
            .pipe(Effect.orDie);
          const desk = {
            HERDR_SOCKET_PATH: socket,
            HERDR_WORKSPACE_ID: workspace.workspaceId,
            FAKE_HERDR_SESSIONS: asSessions([{ name: "desk", socket_path: socket }]),
          };
          const started = yield* collie(
            world,
            ["run", "start", "plain", "--here", "--input", "note=hi"],
            desk,
          );
          const runId = yield* runIdOf(started.envelope);
          const file = yield* newsPath(world.state, yield* herdOf(socket));
          const items = readNews(file).pipe(
            Effect.map((lines) => pending(lines, "flock@pc").items),
          );
          const ended = `${runId}:ended:succeeded`;
          yield* until(items, (now) => now.some((item) => item.key === ended));
          const mr = "https://github.com/acme/app/pull/7";
          for (const [id, kind, body] of [
            [41, "fixed", "Fixed in `c0ffee12`: renamed it"],
            [42, "disputed", "Not changed: a map costs more here"],
          ] as const)
            yield* recordReply(runDir(world.state, runId), {
              at: "2026-10-27T10:00:00Z",
              mr,
              comment: `${mr}#issuecomment-${id}`,
              kind,
              body,
            });
          const told = yield* until(items, (now) => now.length === 2);
          yield* stopHost(world.state);
          expect(told.map((item) => item.key)).toEqual([
            ended,
            `${runId}:disputed:${mr}#issuecomment-42`,
          ]);
          expect(told[1]!.text).toContain("Not changed: a map costs more here");
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
