// The local host, proven the way it will be used: several clients, real processes.
//
// Every client here is a real connection over a real unix socket to a host that was
// started lazily by whoever asked first, and every host is a subprocess. The questions
// are about lifetimes — does a second client get the first one's host, does closing a
// client cancel the work it accepted, does a pending decision outlive the process — and
// none of them has an answer in one process with an in-memory engine.

import { expect, test } from "bun:test";
import {
  Clock,
  Config,
  ConfigProvider,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { connect, outputOf, ownerOf, restartHost } from "../src/host";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  encodeCheckRecord,
  runningChecksDir,
  type CheckRecord,
} from "../src/check-processes";
import { evidenceDir } from "../src/engine";
import { signalProcess } from "../src/lock";
import { startedOf, stillRunning } from "../src/processes";
import { readVerifications, verifyingIn } from "../src/verify";
import { VerifySpecSchema } from "../src/verify-spec";
import { exec, startDetached } from "./support/command";
import { fastForward, runEffect, suiteEnv } from "./support/effect";
import { stopHost, until } from "./support/host";
import { FakeHerdr, Rig } from "./support/recorder";
import { restartHostFlow } from "../src/flows";

const root = new URL("../", import.meta.url).pathname;
const fixtures = `${root}test/fixtures/workflows`;

/** The command a client starts a host with, as `connect` reads it. */
const starts = (command: ReadonlyArray<string>) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      COLLIE_HOST: JSON.stringify(command),
      COLLIE_HOST_STOP_GRACE: Bun.env.COLLIE_HOST_STOP_GRACE,
    }),
  );

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
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
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
  for (const name of ["proof.workflow.ts", "stubborn.workflow.ts", "helper.ts", "notes.md"]) {
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
  "a host started in a directory an update then deletes keeps answering from its state directory, without the launcher's LD_PRELOAD",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state } = yield* workspace("collie-host-cwd-");
        const gone = `${state}/../bin`;
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const host = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        // Started in Desktop's app folder, as a bridge Desktop started there did.
        const launcher = [
          "/bin/sh",
          "-c",
          'env > "$GONE.env" && mkdir -p "$GONE" && cd "$GONE" && exec "$@"',
          "sh",
          ...host,
        ];
        // Desktop's launcher sets it, and an older Desktop passed it on.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const was = Bun.env.LD_PRELOAD;
            Bun.env.LD_PRELOAD = "./libcef.so:./libvk_swiftshader.so";
            return was;
          }),
          (was) =>
            Effect.sync(() => {
              if (was === undefined) delete Bun.env.LD_PRELOAD;
              else Bun.env.LD_PRELOAD = was;
            }),
        );
        const who = yield* Effect.scoped(
          connect(state, { hostEnv: { GONE: gone } }).pipe(
            Effect.flatMap((client) => client.identity()),
          ),
        ).pipe(Effect.provide(starts(launcher)), Effect.orDie);
        yield* fs.remove(gone, { recursive: true });
        const after = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.provide(starts(launcher)), Effect.orDie);
        expect(after.pid).toBe(who.pid);
        const given = yield* fs.readFileString(`${gone}.env`);
        expect(given).toContain(`GONE=${gone}`);
        expect(given).not.toContain("LD_PRELOAD");
        if (process.platform === "linux") {
          expect(yield* fs.readLink(`/proc/${who.pid}/cwd`)).toBe(yield* fs.realPath(state));
        }
        yield* stopHost(state);
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a host given its state directory relatively owns it where it was named",
  () =>
    proves(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { state } = yield* workspace("collie-host-relative-");
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const [executable = "bun", ...prefix] = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        const host = yield* spawner.spawn(
          ChildProcess.make(executable, [...prefix, "host", "--dir", "state"], {
            cwd: `${state}/..`,
            env: { HERDR_PLUGIN_ROOT: root, COLLIE_TEST_ROOT: (yield* suiteEnv).COLLIE_TEST_ROOT },
            extendEnv: true,
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        const owner = yield* until(
          () => ownerOf(state),
          (owner) => owner !== null,
        );
        expect(owner?.pid).toBe(host.pid);
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
  "a restart with no host starts one, and one with a host replaces it while a parked and a pending Run carry on",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, project, state } = yield* workspace("collie-host-restart-cmd-");
        const fresh = yield* restartHost(state).pipe(Effect.orDie);
        expect(fresh.before).toBeNull();
        expect((yield* ownerOf(state))?.pid).toBe(fresh.after.pid);

        const marker = `${state}/started`;
        const runs = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state);
            yield* client.load({ entry: `${wf}/proof.workflow.ts` });
            const parked = yield* client.start({
              project,
              id: "proof",
              request: "req-parked",
              input: { note: "parked" },
            });
            const pending = yield* client.start({
              project,
              id: "stubborn",
              request: "req-pending",
              input: { marker },
            });
            yield* until(
              () => client.status({ runId: parked.runId }),
              (status) => status.status === "suspended",
            );
            return { parked: parked.runId, pending: pending.runId };
          }),
        ).pipe(Effect.orDie);
        yield* until(() => fs.exists(marker), Boolean);
        yield* fs.remove(marker);

        const restarted = yield* restartHost(state).pipe(Effect.orDie);
        expect(restarted.before).toEqual(fresh.after);
        expect(restarted.after.pid).not.toBe(fresh.after.pid);
        expect(yield* signalProcess(fresh.after.pid)).toBe(false);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state);
            expect((yield* client.identity()).pid).toBe(restarted.after.pid);
            // The step that was running when its host went is run again by the new one.
            yield* until(() => fs.exists(marker), Boolean);
            expect((yield* client.status({ runId: runs.pending })).status).toBe("pending");
            expect((yield* client.status({ runId: runs.parked })).status).toBe("suspended");
            yield* client.answer({
              runId: runs.parked,
              decision: "decision",
              value: "after",
              request: "answer-after",
            });
            const done = yield* until(
              () => client.status({ runId: runs.parked }),
              (status) => status.status === "complete",
            );
            expect(done).toEqual({ status: "complete", value: "note:parked=after" });
          }),
        ).pipe(Effect.orDie);
        yield* stopHost(state);
      }),
    ),
  180_000,
);

test(
  "the herdr action restarts the host and says what it did",
  () =>
    runEffect(
      Effect.gen(function* () {
        const starting = yield* collie;
        const rig = yield* Effect.acquireRelease(Rig.make(), (rig) => Effect.orDie(rig.close()));
        const env = rig.pluginEnv();
        const old = yield* Effect.scoped(
          connect(env.stateDir).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.provide(starting), Effect.orDie);

        expect(yield* restartHostFlow(new FakeHerdr(env), env).pipe(Effect.provide(starting))).toBe(
          0,
        );
        const owner = yield* ownerOf(env.stateDir);
        expect(owner?.pid).not.toBe(old.pid);
        const shown = (yield* rig.calls()).find((call) => call.cmd === "notification show");
        expect(shown?.argv).toContain("Collie host restarted");
        expect(shown?.argv?.join(" ")).toContain(`pid ${old.pid}`);
        yield* stopHost(env.stateDir);
      }).pipe(Effect.scoped, Effect.orDie),
    ),
  120_000,
);

test(
  "what a spawned host writes to its stderr is kept in the state directory",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state } = yield* workspace("collie-host-output-");
        const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
        const host = Option.isSome(binary)
          ? [binary.value]
          : [process.execPath, `${root}src/main.ts`];
        const noisy = ["/bin/sh", "-c", 'echo "said on stderr" >&2; exec "$@"', "sh", ...host];
        yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.provide(starts(noisy)), Effect.orDie);
        const kept = yield* fs.readFileString(outputOf(state));
        expect(kept).toContain("said on stderr");
        expect(kept).toContain("host started");
        yield* stopHost(state);
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a host told to stop while a step will not end is gone within seconds, and lets go",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { project, state } = yield* workspace("collie-host-stubborn-");
        const marker = `${state}/started`;
        const who = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state);
            yield* client.start({ project, id: "stubborn", request: "req-1", input: { marker } });
            return yield* client.identity();
          }),
        ).pipe(Effect.orDie);
        yield* until(() => fs.exists(marker), Boolean);

        yield* signalProcess(who.pid, "SIGTERM");
        yield* until(
          () => signalProcess(who.pid),
          (alive) => !alive,
        );
        expect(yield* ownerOf(state)).toBeNull();
        // And it said so where the next human to look will find it.
        const log = yield* fs.readFileString(`${state}/host.log`);
        expect(log).toContain("host started");
        expect(log).toContain("still stopping after");
      }),
    ),
  120_000,
);

/**
 * Starts the `stubborn` step on a host watching `watch`, takes the host's end away with
 * `end`, and gives back how long the host took to be gone and what its `host.log` said.
 */
const outlivesAStubbornStep = (
  watch: string,
  end: (state: string) => Effect.Effect<void, never, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { project, state } = yield* workspace("collie-host-ends-");
    const marker = `${state}/started`;
    const who = yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(state, { hostEnv: { COLLIE_HOST_WATCH_PID: watch } });
        yield* client.start({ project, id: "stubborn", request: "req-1", input: { marker } });
        return yield* client.identity();
      }),
    ).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => signalProcess(who.pid, "SIGKILL"));
    yield* until(() => fs.exists(marker), Boolean);

    const endedAt = yield* Clock.currentTimeMillis;
    yield* end(state);
    yield* until(
      () => signalProcess(who.pid),
      (alive) => !alive,
    );
    const took = Duration.millis((yield* Clock.currentTimeMillis) - endedAt);
    const log = yield* fs.readFileString(`${state}/host.log`);
    const grace = yield* Config.Duration("COLLIE_HOST_STOP_GRACE").pipe(
      Config.withDefault(Duration.millis(500)),
    );
    return { took, log, bound: Duration.sum(grace, Duration.seconds(5)) };
  });

test(
  "a host whose state directory is taken away while a step will not end is gone within its grace",
  () =>
    proves(
      Effect.gen(function* () {
        const { took, log, bound } = yield* outlivesAStubbornStep("", (state) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            // Moved away rather than deleted, as a recursive delete races the host's writes;
            // an empty one put back in its place is where the host's last lines land.
            yield* fs.rename(state, `${state}.gone`);
            yield* fs.makeDirectory(state);
          }).pipe(Effect.orDie),
        );
        expect(Duration.isLessThanOrEqualTo(took, bound)).toBe(true);
        expect(log).toContain("its lock is gone; stopping");
      }),
    ),
  120_000,
);

/**
 * A process for a host to watch, nobody's child so that once killed it is gone rather than a
 * zombie a signal reaches, and its kill, which first proves it was still running.
 */
const watchable = Effect.gen(function* () {
  const pid = yield* startDetached(["sleep", "60"]);
  yield* Effect.addFinalizer(() => signalProcess(pid, "SIGKILL"));
  const kill = Effect.gen(function* () {
    expect(yield* signalProcess(pid)).toBe(true);
    yield* signalProcess(pid, "SIGKILL");
  });
  return { pid, kill };
});

test.skipIf(process.platform !== "linux")(
  "a host whose watched process exits while a step will not end is gone within its grace",
  () =>
    proves(
      Effect.gen(function* () {
        const outlived = yield* watchable;
        const { took, log, bound } = yield* outlivesAStubbornStep(
          String(outlived.pid),
          () => outlived.kill,
        );
        expect(Duration.isLessThanOrEqualTo(took, bound)).toBe(true);
        expect(log).toContain("the process it watches has exited; stopping");
      }),
    ),
  120_000,
);

const heldCheck = `${root}test/fixtures/checks/held.sh`;

/**
 * Runs the `held` check, which ignores SIGTERM and has a `setsid` child, on a host watching
 * `watch`, then ends the host with `end`. Gives back the check's two processes, each with
 * its start token, once the host's pid is gone.
 */
const endsWithAHeldCheck = <R>(
  watch: string,
  end: (host: { readonly state: string; readonly pid: number }) => Effect.Effect<void, never, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { wf, project, state } = yield* workspace("collie-host-check-");
    yield* fs.copyFile(`${fixtures}/checking.workflow.ts`, `${wf}/checking.workflow.ts`);
    const notes = `${project}-notes`;
    yield* fs.makeDirectory(notes);
    yield* fs.writeFileString(
      `${project}/.collie/verify.json`,
      Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)))([
        { name: "held", executable: heldCheck, argv: [notes], cwd: "." },
      ]),
    );
    for (const args of [
      ["init", "-q"],
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"],
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"],
    ])
      yield* exec(["git", ...args], { cwd: project });

    const { who, runId } = yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(state, { hostEnv: { COLLIE_HOST_WATCH_PID: watch } });
        const started = yield* client.start({
          project,
          id: "checking",
          request: "req-1",
          input: { check: "held", cwd: project },
        });
        return { who: yield* client.identity(), runId: started.runId };
      }),
    ).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => signalProcess(who.pid, "SIGKILL"));
    const pidIn = (file: string) =>
      until(
        () => fs.readFileString(`${notes}/${file}`).pipe(Effect.orElseSucceed(() => "")),
        (text) => text.trim() !== "",
      ).pipe(Effect.map((text) => Number(text.trim())));
    const check = yield* Effect.forEach([yield* pidIn("starts"), yield* pidIn("children")], (pid) =>
      Effect.map(startedOf(pid), (started) => ({ pid, started: started ?? "" })),
    );
    // Released for whatever this did not end, so nothing outlives the test.
    yield* Effect.addFinalizer(() =>
      fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
    );

    yield* end({ state, pid: who.pid });
    yield* until(
      () => signalProcess(who.pid),
      (alive) => !alive,
    );
    const running = yield* Effect.forEach(check, stillRunning);
    return { state, runId, running, check, notes, project, host: who.pid };
  });

test.skipIf(process.platform !== "linux")(
  "a host told to stop ends the check it is running, records nothing for it, and says so",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, runId, running } = yield* endsWithAHeldCheck("", ({ pid }) =>
          Effect.asVoid(signalProcess(pid, "SIGTERM")),
        );
        expect(yield* ownerOf(state)).toBeNull();
        expect(running).toEqual([false, false]);
        const recorded = yield* readVerifications(evidenceDir(state, runId)).pipe(
          Effect.orElseSucceed(() => []),
        );
        expect(recorded.filter((one) => one.name === "held")).toEqual([]);
        expect(yield* fs.readFileString(`${state}/host.log`)).toContain(
          `ended check held of ${runId}`,
        );
      }),
    ),
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "a host whose directory is taken away, or whose watched process exits, ends its check",
  () =>
    proves(
      Effect.gen(function* () {
        const removed = yield* endsWithAHeldCheck("", ({ state }) =>
          FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.rename(state, `${state}.gone`)),
            Effect.orDie,
          ),
        );
        expect(removed.running).toEqual([false, false]);

        const outlived = yield* watchable;
        const watched = yield* endsWithAHeldCheck(String(outlived.pid), () => outlived.kill);
        expect(watched.running).toEqual([false, false]);
      }),
    ),
  120_000,
);

/** The pids the held check noted in `file`, one per line. */
const notedIn = (notes: string, file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${notes}/${file}`)),
    Effect.map((text) => text.split("\n").filter((line) => line !== "")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

/** The leader pid of each running check the host has recorded, its temp files aside. */
const recordedLeaders = (state: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readDirectory(runningChecksDir(state)).pipe(
        Effect.map((names) => names.filter((name) => name.endsWith(".json"))),
        Effect.flatMap((names) =>
          Effect.forEach(names, (name) =>
            fs
              .readFileString(`${runningChecksDir(state)}/${name}`)
              .pipe(Effect.map((text): number => JSON.parse(text).leader.pid)),
          ),
        ),
      ),
    ),
    Effect.orElseSucceed((): ReadonlyArray<number> => []),
  );

/** Lets the held check end, waits for its Run to complete, and gives back its verifications. */
const releasedOnce = (state: string, runId: string, notes: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const client = yield* connect(state);
      yield* fs.writeFileString(`${notes}/release`, "");
      yield* until(
        () => client.status({ runId }),
        (status) => status.status === "complete",
      );
      const recorded = yield* readVerifications(evidenceDir(state, runId));
      return recorded.filter((one) => one.name === "held");
    }),
  ).pipe(Effect.orDie);

test.skipIf(process.platform !== "linux")(
  "a check a killed host left is ended by the next host, named on its Run, and run once more",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const killed = yield* endsWithAHeldCheck("", ({ pid }) =>
          Effect.asVoid(signalProcess(pid, "SIGKILL")),
        );
        const { state, runId, notes } = killed;
        expect(killed.running).toEqual([true, true]);
        const run = `${state}/runs/${runId}`;
        const stale = yield* verifyingIn(run);
        expect(stale).not.toBeNull();
        const [record] = yield* fs.readDirectory(runningChecksDir(state));
        yield* Effect.addFinalizer(() => stopHost(state).pipe(Effect.ignore));

        yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);
        yield* until(
          () => notedIn(notes, "starts"),
          (pids) => pids.length === 2,
        );
        expect(yield* Effect.forEach(killed.check, stillRunning)).toEqual([false, false]);
        expect(yield* notedIn(notes, "overlaps")).toEqual([]);
        expect(yield* fs.readFileString(`${run}/log.txt`)).toContain(
          `check held (pass gate) of ${runId}, left running by host ${killed.host} `,
        );
        expect(yield* fs.readDirectory(runningChecksDir(state))).not.toContain(record);
        expect((yield* verifyingIn(run))?.started).not.toBe(stale?.started);

        expect(yield* releasedOnce(state, runId, notes)).toHaveLength(1);
        expect(yield* notedIn(notes, "starts")).toHaveLength(2);
      }),
    ),
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "a restart while a check runs leaves one check of the Run running, and one verification",
  () =>
    proves(
      Effect.gen(function* () {
        const restarted = yield* endsWithAHeldCheck("", ({ state }) =>
          restartHost(state).pipe(Effect.asVoid, Effect.orDie),
        );
        const { state, runId, notes } = restarted;
        yield* Effect.addFinalizer(() => stopHost(state).pipe(Effect.ignore));
        expect(restarted.running).toEqual([false, false]);

        const [, rerun] = yield* until(
          () => notedIn(notes, "starts"),
          (pids) => pids.length === 2,
        );
        // The host records a check only once it has spawned it and read its leader.
        const leaders = yield* until(
          () => recordedLeaders(state),
          (pids) => pids.includes(Number(rerun)),
        );
        expect(leaders).toEqual([Number(rerun)]);
        expect(yield* notedIn(notes, "overlaps")).toEqual([]);
        expect(yield* releasedOnce(state, runId, notes)).toHaveLength(1);
      }),
    ),
  120_000,
);

test.skipIf(process.platform !== "linux")(
  "a starting host ends only the checks its installation left, and says which it found gone",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state } = yield* workspace("collie-host-leftovers-");
        const installation = "installation-under-test";
        yield* fs.writeFileString(`${state}/installation`, `${installation}\n`);
        const notes = `${state}-notes`;
        yield* fs.makeDirectory(notes);
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
        );
        /** Left running by nobody, with only the bindings in `env`. */
        const nobodys = (env: ReadonlyArray<string>, argv: ReadonlyArray<string>) =>
          startDetached(["env", "-u", CHECK_INSTALLATION, "-u", CHECK_ID, ...env, ...argv]);
        const sleeper = (env: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const pid = yield* nobodys(env, ["sleep", "60"]);
            yield* Effect.addFinalizer(() => signalProcess(pid, "SIGKILL"));
            return { pid, started: (yield* startedOf(pid)) ?? "" };
          });

        const reused = yield* sleeper([]);
        const theirs = yield* sleeper([
          `${CHECK_INSTALLATION}=another-installation`,
          `${CHECK_ID}=run-two@1-theirs`,
        ]);
        const unmarked = yield* sleeper([]);
        yield* nobodys(
          [`${CHECK_INSTALLATION}=${installation}`, `${CHECK_ID}=run-four@1-ours`],
          [heldCheck, notes],
        );
        const ours = yield* Effect.forEach(["starts", "children"], (file) =>
          until(
            () => notedIn(notes, file),
            (pids) => pids.length === 1,
          ).pipe(
            Effect.map(([pid]) => Number(pid)),
            Effect.flatMap((pid) =>
              Effect.map(startedOf(pid), (started) => ({ pid, started: started ?? "" })),
            ),
          ),
        );
        yield* fs.makeDirectory(runningChecksDir(state));
        yield* fs.makeDirectory(`${state}/runs/run-four`, { recursive: true });
        const recorded = (record: CheckRecord) =>
          fs.writeFileString(
            `${runningChecksDir(state)}/${record.id}.json`,
            encodeCheckRecord(record),
          );
        yield* recorded({
          id: "run-one@1-reused",
          run: "run-one",
          name: "held",
          by: "collie",
          leader: { pid: reused.pid, started: "not-its-start", group: reused.pid },
          host: { pid: 4241, started: "1" },
          started: "2026-10-19T00:00:00.000Z",
        });
        yield* recorded({
          id: "run-four@1-ours",
          run: "run-four",
          name: "held",
          pass: "gate",
          by: "collie",
          leader: { pid: ours[0]!.pid, started: ours[0]!.started, group: ours[0]!.pid },
          host: { pid: 4242, started: "2" },
          started: "2026-10-19T00:00:00.000Z",
        });

        yield* Effect.addFinalizer(() => stopHost(state).pipe(Effect.ignore));
        yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);

        expect(yield* Effect.forEach([reused, theirs, unmarked], stillRunning)).toEqual([
          true,
          true,
          true,
        ]);
        expect(yield* Effect.forEach(ours, stillRunning)).toEqual([false, false]);
        expect(yield* fs.readDirectory(runningChecksDir(state))).toEqual([]);
        expect(yield* fs.readFileString(`${state}/runs/run-four/log.txt`)).toContain(
          "check held (pass gate) of run-four, left running by host 4242 (started 2): ended",
        );
        expect(yield* fs.readFileString(`${state}/host.log`)).toContain(
          "check held of run-one, left running by host 4241 (started 1): already gone",
        );
      }),
    ),
  120_000,
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
        expect(refused.restart).toContain("run `collie host restart`");
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
  "a client newer than the host stops it and starts a host of its own",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-newer-");
        const old = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);

        // This process can only start a host of its own build, so a client from the future
        // still ends up refused — but only after the host it found was replaced.
        const refused = yield* Effect.scoped(connect(state, { build: "999.0.0" })).pipe(
          Effect.flip,
        );
        expect(refused._tag).toBe("HostVersionMismatch");
        const now = yield* ownerOf(state);
        expect(now?.pid).not.toBe(old.pid);
        expect(yield* signalProcess(old.pid)).toBe(false);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a newer client of the release placed inside a clone install replaces that clone's host",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-clone-");
        const old = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);

        yield* Effect.scoped(connect(state, { build: "999.0.0" })).pipe(
          Effect.flip,
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ HERDR_PLUGIN_ROOT: `${old.root}/release` }),
            ),
          ),
        );
        expect(yield* signalProcess(old.pid)).toBe(false);
        yield* stopHost(state).pipe(Effect.ignore);
      }),
    ),
  120_000,
);

test(
  "a newer client replaces a host that does not stop when asked, within seconds",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { project, state } = yield* workspace("collie-host-wedged-");
        const marker = `${state}/started`;
        // A host whose stop waits on its running step for as long as that takes, the way
        // one from before the stop grace does.
        const old = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(state, { hostEnv: { COLLIE_HOST_STOP_GRACE: "1 hour" } });
            yield* client.start({ project, id: "stubborn", request: "req-1", input: { marker } });
            return yield* client.identity();
          }),
        ).pipe(Effect.orDie);
        yield* until(() => fs.exists(marker), Boolean);

        const refused = yield* Effect.scoped(connect(state, { build: "999.0.0" })).pipe(
          // Move the client's timers slowly enough for the real replacement to start.
          (effect) => fastForward(effect, 5),
          Effect.flip,
        );
        expect(refused._tag).toBe("HostVersionMismatch");
        expect(yield* signalProcess(old.pid)).toBe(false);
        expect((yield* ownerOf(state))?.pid).not.toBe(old.pid);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a host that takes the connection and never answers is reported rather than waited on",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-silent-");
        const who = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);
        // Its socket still accepts, and nothing behind it reads.
        yield* signalProcess(who.pid, "SIGSTOP");
        const refused = yield* Effect.scoped(connect(state)).pipe(
          fastForward,
          Effect.flip,
          Effect.ensuring(signalProcess(who.pid, "SIGCONT")),
        );
        if (refused._tag !== "HostUnavailable") {
          throw new Error(`connected, or refused with ${refused._tag}`);
        }
        expect(refused.reason).toContain(`pid ${who.pid} owns the directory and is not answering`);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a newer client replaces an older host that does not answer, by the build it recorded",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-silent-older-");
        const old = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);
        yield* signalProcess(old.pid, "SIGSTOP");

        const refused = yield* Effect.scoped(connect(state, { build: "999.0.0" })).pipe(
          (effect) => fastForward(effect, 5),
          Effect.flip,
        );
        expect(refused._tag).toBe("HostVersionMismatch");
        expect(yield* signalProcess(old.pid)).toBe(false);
        expect((yield* ownerOf(state))?.pid).not.toBe(old.pid);
        yield* stopHost(state);
      }),
    ),
  120_000,
);

test(
  "a newer client from another installation leaves the host running and says why",
  () =>
    proves(
      Effect.gen(function* () {
        const { state } = yield* workspace("collie-host-elsewhere-");
        const who = yield* Effect.scoped(
          connect(state).pipe(Effect.flatMap((client) => client.identity())),
        ).pipe(Effect.orDie);

        // A checkout under development: newer by its version, and not what this host serves.
        const refused = yield* Effect.scoped(connect(state, { build: "999.0.0" })).pipe(
          Effect.flip,
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_PLUGIN_ROOT: "/elsewhere" })),
          ),
        );
        if (refused._tag !== "HostVersionMismatch") {
          throw new Error(`connected, or refused with ${refused._tag}`);
        }
        expect(refused.restart).toContain("HERDR_PLUGIN_STATE_DIR");
        expect((yield* ownerOf(state))?.pid).toBe(who.pid);
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
        // What it lives no longer than: a process stopped at will, and nobody's child here —
        // a child of this test would linger as a zombie once killed, which a signal still
        // reaches, where a test process that exits is reaped by whoever started it.
        const detached = yield* exec(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"]);
        const outlived = Number(detached.stdout.trim());
        const suite = yield* suiteEnv;
        yield* Effect.addFinalizer(() => signalProcess(outlived, "SIGKILL"));
        const hostFor = (state: string, watch: string) =>
          spawner.spawn(
            ChildProcess.make(executable, [...prefix, "host", "--dir", state], {
              env: {
                HOME: state,
                PATH: "/usr/bin:/bin",
                HERDR_PLUGIN_ROOT: root,
                COLLIE_HOST_WATCH_PID: watch,
                COLLIE_TEST_ROOT: suite.COLLIE_TEST_ROOT,
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
        // Its exit, as the handle sees it: a signal would still reach it as a zombie until
        // it is reaped, which is not the host still serving.
        const gone = (host: { readonly exitCode: Effect.Effect<unknown, unknown> }) =>
          host.exitCode.pipe(Effect.timeout("20 seconds"), Effect.orDie);

        const watching = (yield* workspace("collie-host-watched-")).state;
        const watcher = yield* hostFor(watching, String(outlived));
        yield* owned(watching);
        yield* signalProcess(outlived, "SIGKILL");
        yield* gone(watcher);
        expect(yield* ownerOf(watching)).toBeNull();

        const removed = (yield* workspace("collie-host-removed-")).state;
        const orphan = yield* hostFor(removed, "");
        yield* owned(removed);
        // Moved away rather than deleted: a recursive delete races the files the host is
        // still writing there, where a rename takes the directory away in one step.
        yield* fs.rename(removed, `${removed}.gone`);
        yield* gone(orphan);
      }),
    ),
  120_000,
);

/** A host started for the installation at `pluginRoot`. */
const hostFor = (pluginRoot: string) =>
  Effect.map(Config.option(Config.String("COLLIE_TEST_BINARY")), (binary) =>
    starts([
      "env",
      `HERDR_PLUGIN_ROOT=${pluginRoot}`,
      ...(Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`]),
    ]),
  );

const identityAt = (pluginRoot: string) =>
  Effect.gen(function* () {
    const { state } = yield* workspace("collie-host-build-");
    const [who, snapshot] = yield* Effect.scoped(
      connect(state).pipe(
        Effect.flatMap((client) =>
          Effect.all([client.identity(), client.board().pipe(Stream.runHead)]),
        ),
      ),
    ).pipe(Effect.orDie, Effect.provide(yield* hostFor(pluginRoot)));
    yield* stopHost(state);
    return { ...who, board: Option.getOrUndefined(snapshot) };
  });

test(
  "a host on a development checkout names its build, and one on a release does not",
  () =>
    proves(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "collie-host-checkout-" });
        const git = (...args: string[]) =>
          exec(["git", "-C", checkout, ...args], {
            env: {
              PATH: "/usr/bin:/bin",
              GIT_AUTHOR_NAME: "t",
              GIT_AUTHOR_EMAIL: "t@example.com",
              GIT_COMMITTER_NAME: "t",
              GIT_COMMITTER_EMAIL: "t@example.com",
            },
          }).pipe(Effect.map((done) => done.stdout.trim()));
        yield* git("init", "--quiet", "-b", "feature");
        yield* git("commit", "--quiet", "--allow-empty", "-m", "work");
        const sha = yield* git("rev-parse", "--short", "HEAD");
        const release = yield* fs.makeTempDirectoryScoped({ prefix: "collie-host-release-" });

        const development = yield* identityAt(checkout);
        const released = yield* identityAt(release);

        expect(development.development).toBe(`${development.build}+${sha}`);
        expect(released.development).toBeUndefined();
        // A front door reads the same from the board it is served.
        expect(development.board).toMatchObject({ development: development.development });
        expect(released.board && "development" in released.board).toBe(false);
      }),
    ),
  120_000,
);
