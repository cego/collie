// The local host, proven the way it will be used: several clients, real processes.
//
// Every client here is a real connection over a real unix socket to a host that was
// started lazily by whoever asked first, and every host is a subprocess. The questions
// are about lifetimes — does a second client get the first one's host, does closing a
// client cancel the work it accepted, does a pending decision outlive the process — and
// none of them has an answer in one process with an in-memory engine.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Option, Schedule, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { connect, ownerOf } from "../src/host";
import { signalProcess } from "../src/lock";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
const fixtures = `${root}test/fixtures/native`;

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
  const wf = `${dir}/project/.herdr/workflows`;
  yield* fs.makeDirectory(wf, { recursive: true });
  yield* fs.makeDirectory(`${dir}/state`, { recursive: true });
  for (const name of ["proof.workflow.ts", "helper.ts", "notes.md"]) {
    yield* fs.copyFile(`${fixtures}/${name}`, `${wf}/${name}`);
  }
  return { wf, project: `${dir}/project`, state: `${dir}/state` };
});

/**
 * Stops whatever owns this directory, whether this test started it or recovered it. A
 * host outlives every client on purpose, so a suite that does not end one leaves it
 * running after the process that asked for it has gone.
 */
const stopHost = Effect.fn("HostTest.stopHost")(function* (dir: string) {
  const owner = yield* ownerOf(dir);
  if (owner === null) return;
  yield* Effect.sync(() => {
    try {
      process.kill(owner.pid, "SIGTERM");
    } catch {
      // Already gone, which is the state this is trying to reach.
    }
  });
  yield* until(
    () => ownerOf(dir),
    (holder) => holder === null,
  );
});

/** Retries a read until what it says is what the test is waiting for. */
const until = <A, E, R>(
  read: () => Effect.Effect<A, E, R>,
  wanted: (value: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.suspend(read).pipe(
    Effect.flatMap((value) =>
      wanted(value) ? Effect.succeed(value) : Effect.fail(new Error("not yet")),
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("250 millis") }),
    Effect.orDie,
  );

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
              runId: "r1",
              input: { note: "kept" },
            });
          }),
        ).pipe(Effect.orDie);
        expect(started.registration).toBe("proof@1");

        // The client that stayed: the registration the other one made is still held, and
        // the work it accepted is still going.
        const held = yield* watching.registrations().pipe(Effect.orDie);
        expect(held.live).toEqual(["proof@1"]);
        yield* until(
          () => watching.status({ runId: "r1" }),
          (status) => status.status === "suspended",
        );
        yield* watching
          .answer({ runId: "r1", decision: "decision", value: "yes" })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => watching.status({ runId: "r1" }),
          (status) => status.status === "complete",
        );
        expect(done).toEqual({ status: "complete", value: "note:kept=yes" });
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
            yield* client.start({ project, id: "proof", runId: "r1", input: { note: "durable" } });
            yield* until(
              () => client.status({ runId: "r1" }),
              (status) => status.status === "suspended",
            );
            return yield* client.identity();
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
            expect((yield* client.status({ runId: "r1" })).status).toBe("suspended");

            yield* client.answer({ runId: "r1", decision: "decision", value: "still here" });
            const done = yield* until(
              () => client.status({ runId: "r1" }),
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
