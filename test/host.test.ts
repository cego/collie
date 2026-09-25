// The local host, proven the way it will be used: several clients, real processes.
//
// Every client here is a real connection over a real unix socket to a host that was
// started lazily by whoever asked first, and every host is a subprocess. The questions
// are about lifetimes — does a second client get the first one's host, does closing a
// client cancel the work it accepted, does a pending decision outlive the process — and
// none of them has an answer in one process with an in-memory engine.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { connect, ownerOf } from "../src/host";
import { signalProcess } from "../src/lock";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";

const root = new URL("../", import.meta.url).pathname;
const fixtures = `${root}test/fixtures/workflows`;

/** The command a client starts a host with, as `connect` reads it. */
const starts = (command: ReadonlyArray<string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_HOST: JSON.stringify(command) }));

/**
 * The compiled binary when one is named, and the sources otherwise, so the host under
 * test is the one this suite was asked for rather than whatever `bun test` is running.
 */
const collie = Effect.map(Config.option(Config.String("COLLIE_TEST_BINARY")), (binary) =>
  starts(Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`]),
);

const proves = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
  how?: Layer.Layer<never>,
) =>
  runEffect(
    Effect.gen(function* () {
      const starting = how ?? (yield* collie);
      return yield* effect.pipe(Effect.scoped, Effect.provide(starting));
    }),
  );

/** A project with a workflow saved in it, and a state directory for the host to own. */
const workspace = Effect.fn("HostTest.workspace")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  const wf = `${dir}/project/.collie/workflows`;
  yield* fs.makeDirectory(wf, { recursive: true });
  yield* fs.makeDirectory(`${dir}/state`, { recursive: true });
  for (const name of ["proof.workflow.ts", "helper.ts", "notes.md"]) {
    yield* fs.copyFile(`${fixtures}/${name}`, `${wf}/${name}`);
  }
  return { wf, project: `${dir}/project`, state: `${dir}/state` };
});

test(
  "clients that start at the same moment converge on the one host that holds the lock",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-owner-");
        // Four at once against a directory with no host: each finds nothing answering and
        // starts one, and three of those lose the lock and leave.
        const identities = yield* Effect.all(
          [1, 2, 3, 4].map(() =>
            Effect.scoped(
              connect(state).pipe(
                Effect.flatMap((client) => client.identity()),
                Effect.orDie,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(new Set(identities.map((who) => who.pid)).size).toBe(1);

        // The one they reached is the one that owns the directory, not merely the one
        // that answered first.
        const owner = yield* ownerOf(state);
        expect(owner?.pid).toBe(identities[0]!.pid);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a client that hangs up leaves its work, its registrations and the client watching it",
  () =>
    proves(
      Effect.gen(function* () {
        const { wf, project, state } = yield* workspace("collie-host-disconnect-");
        const watching = yield* connect(state).pipe(Effect.orDie);

        // Another client's whole life: it loads a module, starts a run, and goes while
        // that run is still executing.
        const started = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state);
            const loaded = yield* client.load({ entry: `${wf}/proof.workflow.ts` });
            expect(loaded.registration).toBe("proof@1");
            return yield* client.start({
              project,
              id: "proof",
              request: "req-1",
              input: { note: "kept" },
            });
          }),
        ).pipe(Effect.orDie);
        expect(started.registration).toBe("proof@1");
        const runId = started.runId;

        // The client that stayed: the registration the other one made is still held, and
        // the work it accepted is still going.
        const held = yield* watching.registrations().pipe(Effect.orDie);
        expect(held.live).toEqual(["proof@1"]);
        yield* until(
          () => watching.status({ runId }),
          (status) => status.status === "suspended",
        );
        yield* watching
          .answer({ runId, decision: "decision", value: "yes", request: "answer-yes" })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => watching.status({ runId }),
          (status) => status.status === "complete",
        );
        expect(done).toEqual({ status: "complete", value: "note:kept=yes" });
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "one request sent by four clients at once is one run, and changing it is refused",
  () =>
    proves(
      Effect.gen(function* () {
        const { project, state } = yield* workspace("collie-host-request-");
        const client = yield* connect(state).pipe(Effect.orDie);

        // The same claim, four times over one host: the database settles which of them
        // made the run, and the other three are told about it.
        const admitted = yield* Effect.all(
          [1, 2, 3, 4].map(() =>
            client.start({ project, id: "proof", request: "req-1", input: { note: "once" } }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.orDie);
        expect(new Set(admitted.map((one) => one.runId)).size).toBe(1);
        expect(admitted.filter((one) => one.fresh)).toHaveLength(1);

        // A different claim for the same work is different work: two starts, two runs.
        const other = yield* client
          .start({ project, id: "proof", request: "req-2", input: { note: "once" } })
          .pipe(Effect.orDie);
        expect(other.runId).not.toBe(admitted[0]?.runId);
        expect(other.fresh).toBe(true);

        // And the first claim, for something else, is not that claim.
        const refused = yield* client
          .start({ project, id: "proof", request: "req-1", input: { note: "changed" } })
          .pipe(Effect.flip, Effect.orDie);
        if (refused._tag !== "RequestConflict") {
          throw new Error(`started, or refused with ${refused._tag}`);
        }
        expect(refused.request).toBe("req-1");
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a decision pending when the host goes is still pending for the host that replaces it",
  () =>
    proves(
      Effect.gen(function* () {
        const { wf, project, state } = yield* workspace("collie-host-restart-");
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state);
            yield* client.load({ entry: `${wf}/proof.workflow.ts` });
            const started = yield* client.start({
              project,
              id: "proof",
              request: "req-1",
              input: { note: "durable" },
            });
            yield* until(
              () => client.status({ runId: started.runId }),
              (status) => status.status === "suspended",
            );
            return { ...(yield* client.identity()), runId: started.runId };
          }),
        ).pipe(Effect.orDie);

        // The host is asked to stop, and it goes: it leaves nothing a human has to clear.
        yield* stopHost(state);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${state}/host.sock`)).toBe(false);

        yield* Effect.scoped(
          Effect.gen(function* () {
            // Nothing is answering, so this client starts the host it needs.
            const client = yield* connect(state);
            const second = yield* client.identity();
            expect(second.pid).not.toBe(first.pid);
            // Rebuilt from the module as it is now, under the name the run started on.
            expect((yield* client.registrations()).live).toEqual(["proof@1"]);
            expect((yield* client.status({ runId: first.runId })).status).toBe("suspended");

            yield* client.answer({
              runId: first.runId,
              decision: "decision",
              value: "still here",
              request: "answer-still-here",
            });
            const done = yield* until(
              () => client.status({ runId: first.runId }),
              (status) => status.status === "complete",
            );
            expect(done).toEqual({ status: "complete", value: "note:durable=still here" });
          }),
        ).pipe(Effect.orDie);
        yield* stopHost(state);
      }),
    ),
  180_000,
);

test(
  "a lock left by a dead host is recovered without touching the process that has its pid",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state } = yield* workspace("collie-host-stale-");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Somebody else's process, which the dead host's pid now belongs to.
        const bystander = yield* spawner.spawn(
          ChildProcess.make("sleep", ["30"], { stdout: "ignore", stderr: "ignore" }),
        );
        yield* fs.writeFileString(`${state}/host.lock`, `{"pid":${bystander.pid},"start":"0"}\n`);
        // And the socket the dead host never got to remove.
        yield* fs.writeFileString(`${state}/host.sock`, "");

        const who = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);
        expect(who.pid).not.toBe(bystander.pid);
        // The claim is the new host's, and the process that merely inherited the pid is
        // alive: staleness is decided from the identity in the claim, never by signalling.
        expect((yield* ownerOf(state))?.pid).toBe(who.pid);
        expect(yield* signalProcess(bystander.pid)).toBe(true);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a host of another build is reported with what to do, and nothing is taken from it",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-build-");
        const who = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);

        const refused = yield* Effect.scoped(connect(state, { build: "0.0.0-elsewhere" })).pipe(
          Effect.flip,
        );
        if (refused._tag !== "HostVersionMismatch") {
          throw new Error(`connected, or refused with ${refused._tag}`);
        }
        expect(refused).toMatchObject({
          host: who.build,
          client: "0.0.0-elsewhere",
          pid: who.pid,
        });
        // A restart is the instruction, and the client is what stops: nothing here kills
        // the host or takes its directory.
        expect(refused.restart).toContain(`stop it (pid ${who.pid})`);
        expect((yield* ownerOf(state))?.pid).toBe(who.pid);

        // The host it would not talk to is still the host every matching client gets.
        const again = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);
        expect(again.pid).toBe(who.pid);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a host that will not start is said out loud rather than waited on forever",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-unavailable-");
        const refused = yield* Effect.scoped(connect(state)).pipe(Effect.flip);
        if (refused._tag !== "HostUnavailable") {
          throw new Error(`connected, or refused with ${refused._tag}`);
        }
        expect(refused.reason).toContain("nothing owns the directory");
        expect(yield* ownerOf(state)).toBeNull();
      }),
      // A command that exits at once, which is what a host too broken to start looks like.
      starts(["/bin/false"]),
    ),
  120_000,
);

test(
  "a host stops once its directory is gone, or the process it was to outlive no longer is",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const command = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        const [executable = "bun", ...prefix] = command;
        // What it lives no longer than: a process of the test's own, stopped at will.
        const outlived = yield* spawner.spawn(
          ChildProcess.make("sleep", ["60"], { stdout: "ignore", stderr: "ignore" }),
        );
        const hostFor = (state: string, watch: string) =>
          spawner.spawn(
            ChildProcess.make(executable, [...prefix, "host", "--dir", state], {
              env: {
                HOME: state,
                PATH: "/usr/bin:/bin",
                HERDR_PLUGIN_ROOT: root,
                COLLIE_HOST_WATCH_PID: watch,
              },
              extendEnv: false,
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
        const owned = (state: string) =>
          until(
            () => ownerOf(state),
            (owner) => owner !== null,
          );
        const gone = (pid: number) =>
          until(
            () => signalProcess(pid),
            (alive) => !alive,
          );

        const watching = (yield* workspace("collie-host-watched-")).state;
        const watcher = yield* hostFor(watching, String(outlived.pid));
        yield* owned(watching);
        yield* outlived.kill();
        yield* gone(watcher.pid);
        expect(yield* ownerOf(watching)).toBeNull();

        const removed = (yield* workspace("collie-host-removed-")).state;
        const orphan = yield* hostFor(removed, "");
        yield* owned(removed);
        yield* fs.remove(removed, { recursive: true });
        yield* gone(orphan.pid);
      }),
    ),
  120_000,
);
