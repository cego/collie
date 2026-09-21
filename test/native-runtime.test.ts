// The go/no-go proof: a workflow written outside this checkout, run by Collie's own
// executable on Effect's workflow engine over real SQLite, surviving a real restart.
//
// Every host here is a subprocess and every database is a file, because the questions
// being asked — does a completed Activity come back, does a pending decision survive, does
// a missing module leave work recoverable — have no answer in an in-memory engine.

import { expect, test } from "bun:test";
import {
  Cause,
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
  Schedule,
  Scope,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import * as Workflow from "effect/unstable/workflow/Workflow";
import { HostReply, HostRequest, hostLayer, TOOLCHAIN } from "../src/native";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
const fixtures = `${root}test/fixtures/native`;

const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(HostReply));

interface Host {
  readonly ask: (request: typeof HostRequest.Type) => Effect.Effect<typeof HostReply.Type>;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly until: (
    request: typeof HostRequest.Type,
    wanted: (reply: typeof HostReply.Type) => boolean,
  ) => Effect.Effect<typeof HostReply.Type>;
  readonly stop: Effect.Effect<void>;
}

/**
 * One host process against one state directory. Exercised against the compiled binary
 * when `COLLIE_TEST_BINARY` names one, and against the sources otherwise — the proof is
 * about the packaged executable, and running both is what keeps the two honest.
 */
const openHost = Effect.fn("NativeTest.open")(function* (
  dir: string,
  options?: { readonly registrationTimeoutMs?: number },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? binary.value : (Bun.argv[0] ?? "bun");
  const timeout = options?.registrationTimeoutMs;
  const args = [
    ...(Option.isSome(binary) ? [] : [`${root}src/main.ts`]),
    "native",
    "--dir",
    dir,
    ...(timeout === undefined ? [] : ["--registration-timeout-ms", String(timeout)]),
  ];
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      // Outside the checkout on purpose: nothing here may resolve through its node_modules.
      cwd: dir,
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
      extendEnv: false,
      stdin: Stream.fromQueue(input).pipe(Stream.encodeText),
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "1 second",
    }),
  );
  const replies = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("{")),
    Stream.mapEffect((line) => decodeReply(line)),
    Stream.toQueue({ capacity: 64 }),
  );
  const ask = (request: typeof HostRequest.Type) =>
    Queue.offer(input, `${JSON.stringify(request)}\n`).pipe(
      Effect.andThen(Queue.take(replies)),
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.die(new Error(`no reply to ${JSON.stringify(request)}`)),
      }),
      Effect.orDie,
    );
  return {
    ask,
    child,
    // A start does not wait for the workflow, so a test that wants a state asks until it
    // is there rather than sleeping for a duration it invented.
    until: (request: typeof HostRequest.Type, wanted: (reply: typeof HostReply.Type) => boolean) =>
      ask(request).pipe(
        Effect.flatMap((reply) =>
          wanted(reply) ? Effect.succeed(reply) : Effect.fail(new Error("not yet")),
        ),
        Effect.retry({ times: 80, schedule: Schedule.spaced("250 millis") }),
        Effect.orDie,
      ),
    stop: Queue.end(input).pipe(Effect.andThen(child.exitCode), Effect.asVoid, Effect.orDie),
  } satisfies Host;
});

/** A workflow directory of its own, with the fixture's entries, helper and Markdown in it. */
const workspace = Effect.fn("NativeTest.workspace")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* fs.makeDirectory(`${dir}/wf`, { recursive: true });
  yield* fs.makeDirectory(`${dir}/state`, { recursive: true });
  for (const name of [
    "proof.workflow.ts",
    "plain.workflow.ts",
    "broken.workflow.ts",
    "helper.ts",
    "notes.md",
  ]) {
    yield* fs.copyFile(`${fixtures}/${name}`, `${dir}/wf/${name}`);
  }
  return { dir, wf: `${dir}/wf`, state: `${dir}/state` };
});

const events = Effect.fn("NativeTest.events")(function* (state: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(`${state}/events.${runId}.log`)
    .pipe(Effect.orElseSucceed(() => ""));
  return text.split("\n").filter((line) => line.length > 0);
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

const stopsIn = (log: ReadonlyArray<string>) => log.filter((line) => line === "stopped").length;

const suspended = (reply: typeof HostReply.Type) => reply.status === "suspended";
const complete = (reply: typeof HostReply.Type) => reply.status === "complete";

test(
  "a module outside the checkout runs on the binary and a restart reuses its completed work",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-native-restart-");
        const first = yield* openHost(state);
        const loaded = yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        expect(loaded.ok).toBe(true);
        expect(loaded.id).toBe("proof");
        // The public id, the native registration and the run are three separate names.
        expect(loaded.registration).toBe("proof@1");

        yield* first.ask({ op: "start", id: "proof", runId: "r1", note: "first" });
        yield* first.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        // The helper it imported and the Markdown it imported both ran: `note:` is the
        // helper's, and the number is the length of the prompt beside it.
        const started = yield* events(state, "r1");
        expect(started).toHaveLength(2);
        expect(started[0]).toMatch(/^launch note:first \d+$/);
        expect(started[1]).toBe("wait");
        yield* first.stop;

        // A different process, the same SQLite file, and the registration rebuilt from
        // the module as it is now — no bundle of the code that started the run.
        const second = yield* openHost(state);
        const registrations = yield* second.ask({ op: "registrations" });
        expect(registrations.registrations).toEqual(["proof@1"]);
        yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "yes",
        });
        const done = yield* second.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:first=yes");
        yield* second.stop;

        // One launch across both hosts: the completed Activity came back rather than
        // running again. The wait re-entered, which is what a wait is for.
        const log = yield* events(state, "r1");
        expect(log.filter((line) => line.startsWith("launch"))).toHaveLength(1);
        expect(log.filter((line) => line === "wait").length).toBeGreaterThan(1);
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a hold suspends at a boundary and release resumes the same run without launching again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-native-hold-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "hold", runId: "r1" });
        yield* host.ask({ op: "start", id: "proof", runId: "r1", note: "held" });
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        // Held before the wait: the boundary read is a plain Effect, so it saw the flag
        // an operator set rather than a value cached from the first attempt.
        const paused = yield* events(state, "r1");
        expect(paused).toHaveLength(2);
        expect(paused[0]).toMatch(/^launch note:held /);
        expect(paused[1]).toBe("held");

        yield* host.ask({ op: "release", id: "proof", runId: "r1" });
        yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "go",
        });
        const done = yield* host.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:held=go");
        yield* host.stop;

        const log = yield* events(state, "r1");
        expect(log.filter((line) => line.startsWith("launch"))).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "two stop and resume cycles keep the run's work and it still completes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-native-stop-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "r1", note: "stopped" });
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);

        for (const cycle of [1, 2]) {
          yield* host.ask({ op: "stop", id: "proof", runId: "r1" });
          yield* until(
            () => events(state, "r1"),
            (log) => stopsIn(log) === cycle,
          );
          expect((yield* host.ask({ op: "poll", id: "proof", runId: "r1" })).status).toBe(
            "suspended",
          );
          yield* host.ask({ op: "resume", id: "proof", runId: "r1" });
        }

        yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "done",
        });
        const done = yield* host.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:stopped=done");
        yield* host.stop;

        // Stopping is not a counter and it is not a relaunch: the wait is re-entered once
        // per stop and once per resume, and the launch happened once.
        const log = yield* events(state, "r1");
        expect(stopsIn(log)).toBe(2);
        const launches = log.filter((line) => line.startsWith("launch"));
        expect(launches).toHaveLength(1);
        expect(launches[0]).toMatch(/^launch note:stopped /);
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a module that is gone leaves its run pending and names the file, and another one still runs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-native-missing-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "load", entry: `${wf}/plain.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", note: "orphan" });
        yield* first.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        yield* first.stop;

        yield* fs.remove(`${wf}/proof.workflow.ts`);
        const second = yield* openHost(state);
        const registrations = yield* second.ask({ op: "registrations" });
        expect(registrations.registrations).toEqual(["plain@1"]);
        expect(registrations.diagnostics?.join("\n")).toContain("proof.workflow.ts");

        // Pending, with the file to repair named — not failed, and not run on some other
        // generation's code.
        const refused = yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "no",
        });
        expect(refused.ok).toBe(false);
        expect(refused.detail).toContain("proof.workflow.ts");

        // The workflow beside it is unaffected.
        yield* second.ask({ op: "start", id: "plain", runId: "r2", note: "fine" });
        const other = yield* second.until({ op: "poll", id: "plain", runId: "r2" }, complete);
        expect(other.value).toBe("plain:fine");
        yield* second.stop;

        // Put it back, and the run that was waiting is recoverable again.
        yield* fs.copyFile(`${fixtures}/proof.workflow.ts`, `${wf}/proof.workflow.ts`);
        const third = yield* openHost(state);
        yield* third.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "back",
        });
        const done = yield* third.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:orphan=back");
        yield* third.stop;
        expect(
          (yield* events(state, "r1")).filter((line) => line.startsWith("launch")),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "loading an entry again is a new generation beside the work already running on the old one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-native-generations-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "old", note: "before" });
        yield* host.until({ op: "poll", id: "proof", runId: "old" }, suspended);

        // The helper and the prompt beside the entry are edited while work is running.
        yield* fs.writeFileString(
          `${wf}/helper.ts`,
          "export const label = (note: string): string => `edited:${note}`;\n",
        );
        const reloaded = yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        expect(reloaded.registration).toBe("proof@2");
        expect((yield* host.ask({ op: "registrations" })).registrations).toEqual([
          "proof@1",
          "proof@2",
        ]);

        // New work sees the edit; the run already going keeps the code it started on.
        const started = yield* host.ask({ op: "start", id: "proof", runId: "new", note: "after" });
        expect(started.registration).toBe("proof@2");
        yield* host.until({ op: "poll", id: "proof", runId: "new" }, suspended);
        expect((yield* events(state, "new"))[0]).toContain("edited:after");

        for (const runId of ["old", "new"]) {
          yield* host.ask({ op: "answer", id: "proof", runId, decision: "decision", value: "x" });
        }
        expect((yield* host.until({ op: "poll", id: "proof", runId: "old" }, complete)).value).toBe(
          "note:before=x",
        );
        expect((yield* host.until({ op: "poll", id: "proof", runId: "new" }, complete)).value).toBe(
          "edited:after=x",
        );
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "two hosts with their own state directories register the same workflow without meeting",
  () =>
    runEffect(
      Effect.gen(function* () {
        const one = yield* workspace("collie-native-project-one-");
        const two = yield* workspace("collie-native-project-two-");
        const hostOne = yield* openHost(one.state);
        const hostTwo = yield* openHost(two.state);
        yield* hostOne.ask({ op: "load", entry: `${one.wf}/proof.workflow.ts` });
        yield* hostTwo.ask({ op: "load", entry: `${two.wf}/plain.workflow.ts` });

        expect((yield* hostOne.ask({ op: "registrations" })).registrations).toEqual(["proof@1"]);
        expect((yield* hostTwo.ask({ op: "registrations" })).registrations).toEqual(["plain@1"]);

        // A run started in one project is not a run the other has.
        yield* hostOne.ask({ op: "start", id: "proof", runId: "shared", note: "one" });
        const elsewhere = yield* hostTwo.ask({ op: "poll", id: "proof", runId: "shared" });
        expect(elsewhere.ok).toBe(false);
        yield* hostOne.stop;
        yield* hostTwo.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "the provisioned toolchain typechecks a module, and says where a broken one is wrong",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-native-toolchain-");
        const host = yield* openHost(state);

        // Before provisioning there is no compiler, and that is what it says rather than
        // reporting the module as fine.
        const unprovisioned = yield* host.ask({
          op: "check",
          dir: wf,
          entry: `${wf}/proof.workflow.ts`,
        });
        expect(unprovisioned.ok).toBe(false);
        expect(unprovisioned.detail).toContain("provision it");

        const provisioned = yield* host.ask({ op: "provision", dir: wf });
        expect(provisioned.ok).toBe(true);

        const clean = yield* host.ask({ op: "check", dir: wf, entry: `${wf}/proof.workflow.ts` });
        expect(clean.ok).toBe(true);
        expect(clean.diagnostics).toEqual([]);

        // One module's error says nothing about another's: the broken one names its own
        // file and line, and the entry beside it still checks clean.
        const broken = yield* host.ask({ op: "check", dir: wf, entry: `${wf}/broken.workflow.ts` });
        expect(broken.diagnostics?.join("\n")).toContain("broken.workflow.ts(");
        const beside = yield* host.ask({ op: "check", dir: wf, entry: `${wf}/plain.workflow.ts` });
        expect(beside.diagnostics).toEqual([]);
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  300_000,
);

const Manifest = Schema.fromJsonString(
  Schema.Struct({ dependencies: Schema.Struct({ effect: Schema.String }) }),
);

test("the Effect an author's declarations come from is the one the host runs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
        yield* fs.readFileString(`${root}package.json`),
      );
      expect(manifest.dependencies.effect).toBe(TOOLCHAIN.effect);
    }),
  ));

test(
  "registering one name twice keeps the first, which is why a generation gets its own name",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-native-duplicate-" });
        const workflow = Workflow.make("duplicate", {
          payload: { runId: Schema.String },
          idempotencyKey: (payload) => payload.runId,
          success: Schema.String,
        });
        const body = (answer: string) => workflow.toLayer(() => Effect.succeed(answer));

        // Upstream's answer, recorded rather than assumed. Registering a name a second
        // time neither fails nor replaces anything: the first body keeps the name and the
        // second is silently ignored. Duplicate registration is therefore not a reload
        // API, which is why loading a file again mints a registration of its own.
        const ran = yield* Effect.gen(function* () {
          const scope = yield* Scope.make();
          yield* Layer.buildWithScope(body("first"), scope);
          yield* Layer.buildWithScope(body("second"), scope);
          const engine = yield* WorkflowEngine.WorkflowEngine;
          return yield* engine.execute(workflow, {
            executionId: yield* workflow.executionId({ runId: "r1" }),
            payload: { runId: "r1" },
          });
        }).pipe(Effect.provide(hostLayer({ dir })), Effect.scoped, Effect.orDie);
        expect(ran).toBe("first");
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a run whose module is missing outlasts the deadline a default host would fail it on",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-native-deadline-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", note: "patient" });
        yield* first.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        yield* first.stop;

        yield* fs.remove(`${wf}/proof.workflow.ts`);
        const second = yield* openHost(state);
        // Longer than upstream's one-minute entityRegistrationTimeout, which this host
        // does not use: the point of the setting is that waiting is not a failure.
        yield* Effect.sleep("70 seconds");
        yield* fs.copyFile(`${fixtures}/proof.workflow.ts`, `${wf}/proof.workflow.ts`);
        yield* second.stop;

        const third = yield* openHost(state);
        yield* third.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "late",
        });
        const done = yield* third.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:patient=late");
        yield* third.stop;
        expect(
          (yield* events(state, "r1")).filter((line) => line.startsWith("launch")),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  240_000,
);

test(
  "a host killed mid-run leaves the work suspended rather than failed, and the next one finishes it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-native-crash-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", note: "crashed" });
        yield* first.until({ op: "poll", id: "proof", runId: "r1" }, suspended);

        // No shutdown at all, which is the case a host that is stopped preemptively would
        // be indistinguishable from: nothing got to mark the run one way or the other.
        yield* first.child.kill({ killSignal: "SIGKILL" });
        // A killed child has no exit code, only the signal that ended it.
        yield* first.child.exitCode.pipe(Effect.ignore);

        const second = yield* openHost(state);
        expect((yield* second.ask({ op: "poll", id: "proof", runId: "r1" })).status).toBe(
          "suspended",
        );
        yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "after",
        });
        const done = yield* second.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:crashed=after");
        yield* second.stop;
        expect(
          (yield* events(state, "r1")).filter((line) => line.startsWith("launch")),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
  180_000,
);
