// The fixture host, as a test drives one: a real subprocess, one JSON line each way.
//
// `collie native` is the host the native-runtime proof kills and restarts, so the harness
// for it lives here rather than in one of the suites that drive it.

import { Cause, Config, Effect, FileSystem, Option, Queue, Schema, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostReply, HostRequest, type CrashPoint } from "../../src/native";
import { ownerOf } from "../../src/host";

export const root = new URL("../../", import.meta.url).pathname;
export const fixtures = `${root}test/fixtures/native`;

const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(HostReply));

export interface Host {
  readonly ask: (request: typeof HostRequest.Type) => Effect.Effect<typeof HostReply.Type>;
  /** Sends and does not wait, which is the only way to ask a host that is about to die. */
  readonly tell: (request: typeof HostRequest.Type) => Effect.Effect<void>;
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
export const openHost = Effect.fn("NativeTest.open")(function* (
  dir: string,
  options?: { readonly registrationTimeoutMs?: number; readonly crashAt?: CrashPoint },
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
    ...(options?.crashAt === undefined ? [] : ["--crash-at", options.crashAt]),
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
    tell: (request: typeof HostRequest.Type) =>
      Queue.offer(input, `${JSON.stringify(request)}\n`).pipe(Effect.asVoid),
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

/**
 * Stops whatever owns this state directory, whether the test started it or recovered it.
 * A host outlives every client on purpose, so a suite that does not end one leaves it
 * running after the process that asked for it has gone.
 */
export const stopHost = Effect.fn("NativeTest.stopHost")(function* (dir: string) {
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

/** A workflow directory of its own, with the fixture's entries, helper and Markdown in it. */
export const workspace = Effect.fn("NativeTest.workspace")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* fs.makeDirectory(`${dir}/wf`, { recursive: true });
  yield* fs.makeDirectory(`${dir}/state`, { recursive: true });
  for (const name of [
    "proof.workflow.ts",
    "plain.workflow.ts",
    "broken.workflow.ts",
    "echo.workflow.ts",
    "unwired.workflow.ts",
    "conflicted.workflow.ts",
    "agent.workflow.ts",
    "helper.ts",
    "notes.md",
  ]) {
    yield* fs.copyFile(`${fixtures}/${name}`, `${dir}/wf/${name}`);
  }
  return { dir, wf: `${dir}/wf`, state: `${dir}/state` };
});

export const events = Effect.fn("NativeTest.events")(function* (state: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(`${state}/events.${runId}.log`)
    .pipe(Effect.orElseSucceed(() => ""));
  return text.split("\n").filter((line) => line.length > 0);
});

/** Retries a read until what it says is what the test is waiting for. */
export const until = <A, E, R>(
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
