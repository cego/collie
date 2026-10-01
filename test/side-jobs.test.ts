// What the host does on its own, with no pane open: the merge watch, News and pruning.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { readDispositions } from "../src/disposition";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { frontDoor } from "../src/host";
import { newsPath, read as readNews } from "../src/news";
import { writeTask } from "../src/task";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

const MR = "mr:gitlab.example.com/mk/project!7";

/** A glab that is logged in everywhere and says every merge request has merged. */
const mergedGlab = Effect.fn("sideJobs.mergedGlab")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  const view = `{"iid":7,"state":"merged","title":"Cards","web_url":"https://gitlab.example.com/mk/project/-/merge_requests/7"}`;
  yield* fs.writeFileString(
    `${dir}/glab`,
    `#!/bin/sh\n[ "$1" = mr ] && [ "$2" = view ] && echo '${view}'\nexit 0\n`,
    { mode: 0o755 },
  );
  return `${dir}:/usr/bin:/bin`;
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
          const PATH = yield* mergedGlab(`${world.home}/bin`).pipe(Effect.orDie);
          const started = yield* collie(
            world,
            ["run", "start", "targeted", "--task", "task-1", "--input", `target=${MR}`],
            { PATH },
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
              const door = yield* frontDoor(world.state);
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

test(
  "with no pane open the host sweeps the checkouts it might prune",
  () =>
    proves(
      "collie-side-prune-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          expect((yield* collie(world, ["board"])).envelope.ok).toBe(true);
          const log = yield* until(
            fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.includes(`"cmd":"worktree list"`),
          );
          yield* stopHost(world.state);
          expect(log).toContain(`"cmd":"worktree list"`);
        }),
      [],
    ),
  120_000,
);
