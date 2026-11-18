import { recordsAt } from "./support/records";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Result, Schema, Stream, flow } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { TaskView } from "../src/board-model";
import { buildBoard, readBranchHead } from "../src/board";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { agentsIn, liveHerds } from "../src/herds";
import { connect, frontDoor, socketOf } from "../src/host";
import { factsOfView, newestFirst } from "../src/runs";
import { appendVerification, type Verification } from "../src/verify";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { forgeOnPath, serveForges } from "./support/forge";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encodeJson = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const MERGED = "mr:gitlab.example.com/mk/project!7";
const UNKNOWN = "mr:gitlab.example.com/mk/project!8";

const comparable = (view: TaskView) => {
  const { revision: _, age: __, ...rest } = view;
  return rest;
};

const elsewhere = (world: World, statement: string, params: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const script = `${world.home}/sql-elsewhere.ts`;
    yield* (yield* FileSystem.FileSystem).writeFileString(
      script,
      Arr.join(
        [
          `import { Database } from "bun:sqlite";`,
          `const [file, statement, params] = process.argv.slice(2);`,
          `const db = new Database(file);`,
          `db.exec("PRAGMA busy_timeout = 5000");`,
          `db.query(statement).run(...JSON.parse(params));`,
        ],
        "\n",
      ),
    );
    const ran = yield* exec([
      process.execPath,
      script,
      `${world.state}/host.db`,
      statement,
      encodeJson(params),
    ]);
    expect(ran.stderr).toBe("");
  });

test("each change made outside the host reaches the board through its own event, and equals a board read from disk", () =>
  proves(
    "collie-run-model-host-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* currentEnv.pipe(Effect.orDie);
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
              title: "Cards",
            },
          ],
        });
        const COLLIE_FORGE_API = yield* serveForges(gitlab);
        yield* bin.restore();
        const extra = {
          PATH: `${bin.dir}:${Bun.env.PATH}`,
          COLLIE_FORGE_API,
          COLLIE_BOARD_TICK: "1 hour",
        };
        const start = (args: ReadonlyArray<string>) =>
          collie(world, ["run", "start", ...args], extra).pipe(
            Effect.tap(({ envelope }) => Effect.sync(() => expect(envelope.ok).toBe(true))),
            Effect.flatMap(({ envelope }) =>
              Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(envelope.data),
            ),
            Effect.map(({ runId }) => runId),
            Effect.orDie,
          );
        const files = yield* start(["plain", "--input", "note=files"]);
        const store = yield* start(["plain", "--input", "note=store"]);
        const merged = yield* start(["targeted", "--input", `target=${MERGED}`]);
        const checkout = yield* start(["targeted", "--input", `target=${UNKNOWN}`]);
        const agent = yield* start([
          "agent",
          "--input",
          "target=worktree",
          "--input",
          `cwd=${world.project}`,
          "--input",
          "skip=false",
        ]);

        const door = yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie);
        const seen: Array<Map<string, TaskView>> = [];
        const board = new Map<string, TaskView>();
        yield* door.board().pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              if (message._tag === "Snapshot") {
                board.clear();
                for (const task of message.tasks) board.set(task.id, task);
              } else if (message._tag === "Upsert") board.set(message.task.id, message.task);
              else if (message._tag === "Remove") board.delete(message.id);
              else return;
              seen.push(new Map(board));
            }),
          ),
          Effect.forkScoped,
        );
        const cardOf = (tasks: Map<string, TaskView>, run: string) =>
          Arr.findFirst([...tasks.values()], (view) => view.runs.includes(run));
        const arrival = (from: number, wanted: (tasks: Map<string, TaskView>) => boolean) =>
          until(
            () => Effect.sync(() => Arr.findFirst(seen.slice(from), wanted)),
            Option.isSome,
          ).pipe(
            Effect.asVoid,
            Effect.catchDefect((defect) =>
              Effect.die(
                new Error(
                  `${String(defect)}\nwaiting for: ${String(wanted)}\nthe board: ${encodeJson(
                    Arr.map([...board.values()], ({ runs, state, sentence, agents, checks }) => ({
                      runs,
                      state,
                      sentence,
                      agents: agents.length,
                      checks,
                    })),
                  )}`,
                ),
              ),
            ),
          );
        const cardText = (tasks: Map<string, TaskView>, run: string) =>
          encodeJson(Option.getOrNull(Option.map(cardOf(tasks, run), comparable)));
        const changedFrom = (run: string) => {
          const before = cardText(board, run);
          return (tasks: Map<string, TaskView>) => cardText(tasks, run) !== before;
        };

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const spawning = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
        const fromDisk = Effect.gen(function* () {
          const views = yield* client.runs({ task: null }).pipe(Effect.orDie);
          const { alive } = yield* liveHerds(new Herdr(env), env).pipe(Effect.flatMap(agentsIn));
          const built = yield* buildBoard({
            env,
            runs: newestFirst(Arr.map(views, (view) => factsOfView(env.stateDir, view))),
            alive,
            offers: (runId) => door.offers({ runId }).pipe(Effect.orElseSucceed(() => [])),
            head: (run) =>
              readBranchHead(run).pipe(
                Effect.orElseSucceed(() => null),
                Effect.provideContext(spawning),
              ),
          });
          return new Map(Arr.map(built, (view) => [view.id, comparable(view)]));
        });
        const equalsDisk = Effect.gen(function* () {
          for (let tries = 0; ; tries++) {
            const told = seen.length;
            const model = new Map(
              Arr.map([...board.values()], (view) => [view.id, comparable(view)]),
            );
            const disk = yield* fromDisk;
            if (Bun.deepEquals(model, disk) || tries === 20) {
              expect(model).toEqual(disk);
              return;
            }
            yield* until(
              () => Effect.sync(() => seen.length),
              (now) => now > told,
            );
          }
        });
        const ended = (run: string) => (tasks: Map<string, TaskView>) => {
          const card = cardOf(tasks, run);
          return card._tag === "Some" && card.value.state !== "active";
        };
        yield* arrival(0, (tasks) => ended(files)(tasks) && ended(store)(tasks));
        yield* arrival(0, (tasks) => {
          const card = cardOf(tasks, agent);
          return card._tag === "Some" && card.value.agents.length > 0;
        });
        yield* equalsDisk;

        yield* arrival(0, (tasks) => {
          const card = cardOf(tasks, merged);
          return card._tag === "Some" && card.value.mrState === "merged";
        });
        yield* equalsDisk;

        let mark = seen.length;
        let changed = changedFrom(store);
        yield* elsewhere(world, "UPDATE collie_runs SET checkout = ? WHERE run = ?", [
          encodeJson({
            cwd: world.project,
            branch: "mk/from-store",
            workspace: null,
            worktree: null,
          }),
          store,
        ]);
        yield* arrival(mark, changed);
        yield* equalsDisk;

        const repo = `${world.home}/repo`;
        const git = (...args: ReadonlyArray<string>) =>
          exec(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
        yield* fs.makeDirectory(repo, { recursive: true });
        yield* git("init", "-q", "-b", "mk/ship");
        yield* git("commit", "-q", "--allow-empty", "-m", "one");
        const head = Str.trim((yield* git("rev-parse", "HEAD")).stdout);
        yield* elsewhere(world, "UPDATE collie_runs SET checkout = ? WHERE run = ?", [
          encodeJson({ cwd: repo, branch: "mk/ship", workspace: null, worktree: null }),
          checkout,
        ]);
        const record: Verification = {
          id: `v-test-${head}`,
          run: checkout,
          name: "test",
          executable: "/usr/bin/true",
          argv: [],
          cwd: repo,
          start: { head_sha: head, fingerprint: "f" },
          end: { head_sha: head, fingerprint: "f" },
          exit: 0,
          seconds: 1,
          expect: "pass",
          tail: { stdout: "", stderr: "" },
          result: "pass",
          at: "2026-10-31T09:00:00Z",
          by: "collie",
        };
        yield* appendVerification(`${world.state}/evidence/${checkout}`, record);
        yield* arrival(0, (tasks) => {
          const card = cardOf(tasks, checkout);
          return card._tag === "Some" && card.value.checks?.state === "passed";
        });
        mark = seen.length;
        yield* git("commit", "-q", "--allow-empty", "-m", "two");
        yield* arrival(mark, (tasks) => {
          const card = cardOf(tasks, checkout);
          return card._tag === "Some" && card.value.checks?.state === "unchecked";
        });
        yield* equalsDisk;

        mark = seen.length;
        for (const one of yield* new Herdr(env).agentList().pipe(Effect.orDie))
          yield* core.report(one.name, "blocked");
        yield* arrival(mark, (tasks) => {
          const card = cardOf(tasks, agent);
          return card._tag === "Some" && card.value.agents[0]?.status === "blocked";
        });
        yield* equalsDisk;

        const runDir = `${world.state}/runs/${files}`;
        mark = seen.length;
        changed = changedFrom(files);
        yield* exec(["mkdir", "-p", `${runDir}/plan/issues`]);
        yield* exec([
          "cp",
          `${world.install}/user/workflows/notes.md`,
          `${runDir}/plan/issues/01-next.md`,
        ]);
        yield* arrival(mark, changed);
        yield* equalsDisk;

        const kept = `${world.home}/kept-run`;
        mark = seen.length;
        changed = changedFrom(files);
        yield* exec(["mv", runDir, kept]);
        yield* arrival(mark, changed);
        yield* equalsDisk;

        mark = seen.length;
        changed = changedFrom(files);
        yield* exec(["cp", "-r", kept, runDir]);
        yield* arrival(mark, changed);
        yield* equalsDisk;
      }).pipe(Effect.provide(recordsAt(world.state))),
    ["plain.workflow.ts", "targeted.workflow.ts", "agent.workflow.ts", "notes.md"],
  ));
