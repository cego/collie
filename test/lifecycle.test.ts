// A native Run through the doors an operator actually uses.
//
// Ticket 01 proved the engine survives a restart and ticket 05 proved one request is one
// run. What is left is whether any of that is reachable: does a workflow saved as a module
// start from the command line and from the picker, is it the same Run either way, can it be
// shown, listed and waited on, does closing the thing watching it leave the work alone, and
// does a host that replaces another pick up what was left.
//
// Real hosts, real SQLite, real processes: none of those questions has an answer in a map.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, Scope, Stream } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { currentEnv } from "../src/env";
import { pickFlow, type FlowPrompts } from "../src/flows";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { nativeRun, nativeRuns } from "../src/lifecycle";
import { runEffect } from "./support/effect";
import { events, fixtures, root, stopHost, until } from "./support/native";

/** A module, its helper and its prompt, as an author has them beside each other. */
const MODULE = ["proof.workflow.ts", "helper.ts", "notes.md"] as const;

/** A second entry, so a missing module is shown to cost only its own Runs. */
const OTHER = ["plain.workflow.ts"] as const;

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

interface World {
  /** The installation whose user directory an author saves into. */
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly config: string;
  readonly home: string;
  readonly project: string;
}

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);
const asEnvelope = Schema.decodeUnknownEffect(Envelope);

/** The command itself, run as an operator runs it: another process, one JSON envelope. */
const collie = Effect.fn("LifecycleTest.collie")(function* (
  world: World,
  args: ReadonlyArray<string>,
) {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: world.home,
      HERDR_PLUGIN_ROOT: world.install,
      HERDR_PLUGIN_STATE_DIR: world.state,
      HERDR_PLUGIN_CONFIG_DIR: world.config,
      COLLIE_CWD: world.project,
      // The host a client starts is this same program, as an installation's would be.
      COLLIE_HOST: asCommand(command),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exit] = yield* Effect.promise(() =>
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  );
  return { exit, envelope: yield* asEnvelope(stdout).pipe(Effect.orDie) };
});

/** What a `--json` envelope carries for a native Run, as these tests read it. */
const Payload = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(Schema.Struct({ runId: Schema.String, status: Schema.Unknown })),
  native: Schema.optional(Schema.Array(Schema.Struct({ runId: Schema.String }))),
});
const payloadOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Payload)(envelope.data).pipe(Effect.orDie);

const save = (into: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const name of names) yield* fs.copyFile(`${fixtures}/${name}`, `${into}/${name}`);
  }).pipe(Effect.orDie);

/**
 * An installation with a workflow saved in it, a project to run it for, and a state
 * directory for the host that serves both. Exercised against the compiled binary when
 * `COLLIE_TEST_BINARY` names one, and the sources otherwise.
 */
const proves = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      const world: World = {
        install: `${dir}/install`,
        user: `${dir}/install/user/workflows`,
        state: `${dir}/state`,
        config: `${dir}/config`,
        home: `${dir}/home`,
        project: `${dir}/project`,
      };
      for (const made of [
        world.user,
        `${world.install}/workflows`,
        world.state,
        world.config,
        world.home,
        world.project,
      ]) {
        yield* fs.makeDirectory(made, { recursive: true }).pipe(Effect.orDie);
      }
      yield* save(world.user, [...MODULE, ...OTHER]);
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${root}src/main.ts`];
      return yield* body(world).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              HERDR_PLUGIN_CONFIG_DIR: world.config,
              HOME: world.home,
              COLLIE_CWD: world.project,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

test(
  "a run carries what it was started on and what it belongs to, for whoever asks the host",
  () =>
    proves("collie-lifecycle-view-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "proof",
            request: "req-1",
            input: { note: "shown" },
            task: "task-7",
            parent: "run-before",
          })
          .pipe(Effect.orDie);

        const view = yield* client.run({ runId: started.runId }).pipe(Effect.orDie);
        expect(view).toMatchObject({
          runId: started.runId,
          workflow: "proof",
          project: world.project,
          task: "task-7",
          parent: "run-before",
          registration: "proof@1",
          entry: `${world.user}/proof.workflow.ts`,
          input: { note: "shown" },
          diagnostic: null,
        });

        // The same run in the listing, and only the task's when a task is named.
        expect(
          (yield* client.runs({ task: null }).pipe(Effect.orDie)).map((one) => one.runId),
        ).toEqual([started.runId]);
        expect(yield* client.runs({ task: "task-other" }).pipe(Effect.orDie)).toEqual([]);
        // Nothing was started here: an id nobody admitted is nothing, not a failure.
        expect(yield* client.run({ runId: "run-nobody" }).pipe(Effect.orDie)).toBeNull();
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "a run whose module has gone is still readable, with the file to repair named",
  () =>
    proves("collie-lifecycle-gone-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runId = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state);
            const started = yield* client.start({
              project: world.project,
              id: "proof",
              request: "req-1",
              input: { note: "durable" },
            });
            yield* until(
              () => client.run({ runId: started.runId }),
              (view) => view?.status.status === "suspended",
            );
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        yield* stopHost(world.state);
        yield* fs.remove(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const view = yield* client.run({ runId }).pipe(Effect.orDie);
        // Pending with the file to fix, rather than gone, failed, or run on whatever
        // code is nearest: the history is Collie's rows and they are all still here.
        expect(view?.status).toEqual({ status: "pending" });
        expect(view?.diagnostic).toContain("proof.workflow.ts");
        expect(view?.entry).toBe(`${world.user}/proof.workflow.ts`);
        expect((yield* client.runs({ task: null }).pipe(Effect.orDie))[0]?.runId).toBe(runId);

        // One module missing costs its own Runs and nothing else: the entry beside it
        // starts and finishes while the broken one waits to be repaired.
        const beside = yield* client
          .start({ project: world.project, id: "plain", request: "req-2", input: { note: "fine" } })
          .pipe(Effect.orDie);
        expect(
          (yield* until(
            () => client.run({ runId: beside.runId }),
            (one) => one?.status.status === "complete",
          ))?.status,
        ).toEqual({ status: "complete", value: "plain:fine" });

        // Put back, and the work is picked up without a host to restart: the routing is
        // rebuilt from the module as it is now.
        yield* save(world.user, MODULE);
        const recovered = yield* client.recover().pipe(Effect.orDie);
        expect(recovered.live).toContain("proof@1");
        expect(recovered.unavailable).toEqual([]);
        yield* client.answer({ runId, decision: "decision", value: "back" }).pipe(Effect.orDie);
        expect(
          (yield* until(
            () => client.run({ runId }),
            (view) => view?.status.status === "complete",
          ))?.status,
        ).toEqual({ status: "complete", value: "note:durable=back" });
        // What ran before the module went is not run again: the Activity's result is
        // durable, and recovery re-enters the code rather than starting the work over.
        expect(
          (yield* events(world.state, runId)).filter((line) => line.startsWith("launch")),
        ).toHaveLength(1);
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);

test(
  "a client that closes and comes back is told where the work is now, not what it missed",
  () =>
    proves("collie-lifecycle-reconnect-", (world) =>
      Effect.gen(function* () {
        const runId = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state);
            const started = yield* client.start({
              project: world.project,
              id: "proof",
              request: "req-1",
              input: { note: "watched" },
            });
            // Watched until it is waiting, then this client goes — mid-run, as a board
            // being closed or a `wait` being interrupted goes.
            yield* Stream.runHead(
              client
                .watch({ runId: started.runId })
                .pipe(Stream.filter((view) => view?.status.status === "suspended")),
            );
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        // The work is where it was left: nothing was cancelled with the client.
        const client = yield* connect(world.state).pipe(Effect.orDie);
        yield* client.answer({ runId, decision: "decision", value: "again" }).pipe(Effect.orDie);
        // The first thing a stream says is the current state, so a client that was not
        // listening when it changed is not waiting for an update that has been and gone.
        const first = yield* Stream.runHead(client.watch({ runId }));
        expect(Option.isSome(first)).toBe(true);
        const seen = yield* Stream.runHead(
          client.watch({ runId }).pipe(Stream.filter((view) => view?.status.status === "complete")),
        );
        expect(Option.getOrNull(seen)?.status).toEqual({
          status: "complete",
          value: "note:watched=again",
        });
        yield* stopHost(world.state);
      }),
    ),
  180_000,
);

test(
  "the command line starts a module, shows it, lists it and waits on it, and a retry is the same run",
  () =>
    proves("collie-lifecycle-cli-", (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, [
          "run",
          "start",
          "proof",
          "--input",
          "note=cli",
          "--request-id",
          "req-1",
        ]);
        expect(started.envelope.ok).toBe(true);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        expect(runId).not.toBe("");

        // The same request again is the same Run: the claim is the host's, and the
        // receipt is the CLI's, so neither of them can make a second one.
        const again = yield* collie(world, [
          "run",
          "start",
          "proof",
          "--input",
          "note=cli",
          "--request-id",
          "req-1",
        ]);
        expect((yield* payloadOf(again.envelope)).runId).toBe(runId);

        const shown = yield* collie(world, ["run", "show", runId]);
        expect(shown.exit).toBe(0);
        const view = (yield* payloadOf(shown.envelope)).run;
        expect(view?.runId).toBe(runId);

        const listed = yield* collie(world, ["run", "list"]);
        expect((yield* payloadOf(listed.envelope)).native?.map((one) => one.runId)).toEqual([
          runId,
        ]);

        // A wait that ends on the question, and then one that ends on the answer.
        const asked = yield* collie(world, ["run", "wait", runId, "--until", "attention"]);
        expect(asked.exit).toBe(0);
        expect((yield* payloadOf(asked.envelope)).run?.status).toEqual({
          status: "suspended",
        });

        const client = yield* connect(world.state).pipe(Effect.orDie);
        yield* client.answer({ runId, decision: "decision", value: "done" }).pipe(Effect.orDie);
        const finished = yield* collie(world, ["run", "wait", runId]);
        expect((yield* payloadOf(finished.envelope)).run?.status).toEqual({
          status: "complete",
          value: "note:cli=done",
        });
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);

test(
  "a run whose module went missing is picked up again by resuming it, and says so until it is",
  () =>
    proves("collie-lifecycle-resume-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const started = yield* collie(world, [
          "run",
          "start",
          "proof",
          "--input",
          "note=resumed",
          "--request-id",
          "req-1",
        ]);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        yield* collie(world, ["run", "wait", runId, "--until", "attention"]);

        // The module goes, and the host with it: what is left is Collie's rows.
        yield* stopHost(world.state);
        yield* fs.remove(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);
        const orphaned = yield* collie(world, ["run", "show", runId]);
        expect(orphaned.exit).toBe(0);
        expect(orphaned.envelope.ok).toBe(true);

        yield* save(world.user, MODULE);
        const resumed = yield* collie(world, ["run", "resume", runId]);
        expect(resumed.exit).toBe(0);
        expect((yield* payloadOf(resumed.envelope)).run?.status).toEqual({
          status: "suspended",
        });
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);

/** The human at the picker, as a script: each question answered in the order it is asked. */
const answering = (script: ReadonlyArray<string>) => {
  const answers = [...script];
  const asked: Array<string> = [];
  const prompts: FlowPrompts = {
    menu: (items, options) => {
      asked.push(options.header);
      const wanted = answers.shift();
      return Effect.succeed(items.find((item) => item.id === wanted) ?? null);
    },
    ask: (question) => {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
  return { prompts, asked };
};

test(
  "the picker offers a saved module and starts the same Run the command line would",
  () =>
    proves("collie-lifecycle-picker-", (world) =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const { prompts, asked } = answering(["proof", "picked"]);
        expect(yield* pickFlow(new Herdr(env), env, prompts, "inline")).toBe(0);
        // Offered by the picker, and asked for by the name the module declares.
        expect(asked.some((question) => question.includes("Workflows"))).toBe(true);
        expect(asked.at(-1)).toContain("note");

        // The Run it started is the host's, with this project's and this module's marks
        // on it — the same row a `collie run start` would have made, read back through
        // the same operations the command line reads.
        const listed = yield* nativeRuns(env, null);
        expect(listed.runs).toHaveLength(1);
        const runId = listed.runs[0]?.runId ?? "";
        expect(listed.runs[0]).toMatchObject({
          workflow: "proof",
          project: world.project,
          registration: "proof@1",
          input: { note: "picked" },
        });
        expect(
          yield* until(
            () => nativeRun(env, runId),
            (view) => view !== null && "status" in view && view.status.status === "suspended",
          ),
        ).toMatchObject({ runId, workflow: "proof", input: { note: "picked" } });
        yield* stopHost(world.state);
      }),
    ),
  240_000,
);
