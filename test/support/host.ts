// The host Collie ships, as a test drives one: `collie host` in a subprocess, asked over
// the socket every client uses.
//
// A proof kills a host and starts another over the same directory, so each op below is
// one request to that host, or one command an author would type — never a copy of the
// host's logic. Exercised against the compiled binary when `COLLIE_TEST_BINARY` names one,
// and against the sources otherwise.

import { Config, Effect, FileSystem, Option, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { CrashPoint } from "../../src/engine";
import { connect, ownerOf, type HostClient } from "../../src/host";
import { collie, type World } from "./world";
import { watchedBy } from "./effect";

export const root = new URL("../../", import.meta.url).pathname;
export const fixtures = `${root}test/fixtures/workflows`;

/** What a suite asks a host, by the run ids it chose. */
export const HostRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("load"), entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("registrations") }),
  Schema.Struct({
    op: Schema.Literal("start"),
    id: Schema.String,
    runId: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({ op: Schema.Literal("poll"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("answer"),
    id: Schema.String,
    runId: Schema.String,
    /** Null means the one question this run is waiting on. */
    decision: Schema.NullOr(Schema.String),
    value: Schema.String,
    /** The claim this answer arrives under, so the same one twice is one answer. */
    request: Schema.optional(Schema.String),
  }),
  Schema.Struct({ op: Schema.Literal("waiting"), runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("hold"), runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("release"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("stop"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("resume"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("provision"), dir: Schema.String }),
  Schema.Struct({ op: Schema.Literal("check"), dir: Schema.String, entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("metadata"), id: Schema.String }),
]);
type HostRequest = typeof HostRequest.Type;

/** What came back, in one shape whichever door answered it. */
export const HostReply = Schema.Struct({
  ok: Schema.Boolean,
  op: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  registration: Schema.optionalKey(Schema.String),
  registrations: Schema.optionalKey(Schema.Array(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Json),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What a module declares about itself, as a card and a launch would read it. */
  metadata: Schema.optionalKey(Schema.Json),
});
type HostReply = typeof HostReply.Type;

export interface Host {
  readonly ask: (request: HostRequest) => Effect.Effect<HostReply>;
  /** Sends and does not wait, which is the only way to ask a host that is about to die. */
  readonly tell: (request: HostRequest) => Effect.Effect<void>;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly until: (
    request: HostRequest,
    wanted: (reply: HostReply) => boolean,
  ) => Effect.Effect<HostReply>;
  readonly stop: Effect.Effect<void>;
}

/** Where a workspace keeps what its host was told, beside the directory the host owns. */
const layoutOf = (state: string) => {
  const dir = state.slice(0, state.lastIndexOf("/"));
  const world: World = {
    install: `${dir}/install`,
    user: `${dir}/install/user/workflows`,
    state,
    config: `${dir}/install/user`,
    home: `${dir}/home`,
    project: `${dir}/project`,
  };
  return { world, names: `${dir}/suite-runs.json` };
};

/**
 * The run ids a suite chose, against the ones the host gave. A host names its own Runs,
 * and a suite names them by the request that claimed them; a start whose host died
 * before answering is `told`, and is the Run nobody has claimed a name for yet.
 */
const Names = Schema.Struct({
  runs: Schema.Record(Schema.String, Schema.String),
  told: Schema.Array(Schema.String),
});
type Names = typeof Names.Type;
const NamesJson = Schema.fromJsonString(Names);

const readNames = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(NamesJson)),
    Effect.orElseSucceed((): Names => ({ runs: {}, told: [] })),
  );

const writeNames = (fs: FileSystem.FileSystem, file: string, names: Names) =>
  fs.writeFileString(file, Schema.encodeSync(NamesJson)(names)).pipe(Effect.orDie);

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** What a module check reported, as `collie workflow check` puts it in its envelope. */
const Checked = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      problems: Schema.Array(Schema.String),
      toolchain: Schema.NullOr(Schema.String),
    }),
  ),
});
const Shown = Schema.Struct({ workflow: Schema.Struct({ metadata: Schema.Json }) });
const Written = Schema.Struct({ toolchain: Schema.NullOr(Schema.String) });

/** The sentence a refusal carries, whichever of the host's errors it was. */
const Refusal = Schema.Union([
  Schema.Struct({ reason: Schema.String }),
  Schema.Struct({ message: Schema.String }),
]);
const sentenceOf = (cause: unknown): string => {
  const said = Schema.decodeUnknownOption(Refusal)(cause);
  if (Option.isNone(said)) return String(cause);
  return "reason" in said.value ? said.value.reason : said.value.message;
};

const stem = (entry: string) =>
  entry.slice(entry.lastIndexOf("/") + 1).replace(/\.workflow\.ts$/, "");

/**
 * One host process against one state directory, and a client of it. The process is the
 * shipped `collie host`, started here rather than by the client so a proof can kill it;
 * `crashAt` has it kill itself between the two writes a start is made of.
 */
export const openHost = Effect.fn("HostTest.open")(function* (
  state: string,
  options?: { readonly crashAt?: CrashPoint },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const { world, names } = layoutOf(state);
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const [executable = "bun", ...prefix] = command;
  const watch = yield* watchedBy;
  const env = {
    HOME: world.home,
    PATH: "/usr/bin:/bin",
    HERDR_PLUGIN_ROOT: world.install,
    HERDR_PLUGIN_STATE_DIR: state,
    COLLIE_USER_DIR: world.config,
    COLLIE_CWD: world.project,
    COLLIE_HOST: asCommand(command),
    COLLIE_HOST_CRASH_AT: options?.crashAt,
    COLLIE_HOST_WATCH_PID: watch,
  };
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, [...prefix, "host", "--dir", state], {
      // Outside the checkout on purpose: nothing here may resolve through its node_modules.
      cwd: world.project,
      env,
      extendEnv: false,
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    }),
  );
  // This child owns the directory and answers on its socket before any client asks, or a
  // client would start a host of its own and the proof would be about that one.
  const fs = yield* FileSystem.FileSystem;
  yield* until(
    () => Effect.all([ownerOf(state), fs.exists(`${state}/host.sock`).pipe(Effect.orDie)]),
    ([owner, bound]) => owner?.pid === child.pid && bound,
  );
  const client: HostClient = yield* connect(state).pipe(Effect.orDie);

  /** The host's run id for the one a suite chose, or the suite's own where it has none. */
  const resolve = (runId: string) =>
    Effect.gen(function* () {
      const known = yield* readNames(fs, names);
      const named = known.runs[runId];
      if (named !== undefined) return named;
      if (!known.told.includes(runId)) return runId;
      const claimed = new Set(Object.values(known.runs));
      const unclaimed = (yield* client.runs({ task: null }).pipe(Effect.orDie))
        .filter((view) => !claimed.has(view.runId))
        .sort((one, other) => one.created.localeCompare(other.created));
      const found = unclaimed[known.told.indexOf(runId)];
      if (found === undefined) return runId;
      yield* writeNames(fs, names, { ...known, runs: { ...known.runs, [runId]: found.runId } });
      return found.runId;
    });

  const control = (op: string, runId: string, name: "hold" | "stop", set: boolean) =>
    Effect.gen(function* () {
      const done = yield* client
        .control({ runId: yield* resolve(runId), control: name, set })
        .pipe(Effect.result);
      if (done._tag === "Failure") return { ok: false, op, detail: sentenceOf(done.failure) };
      // Recorded either way, and the reply says which: a control over work no host is
      // running is an intent, never a confirmation.
      return { ok: true, op, detail: done.success.detail };
    });

  const ask = (request: HostRequest): Effect.Effect<HostReply> =>
    Effect.gen(function* () {
      switch (request.op) {
        case "load": {
          const loaded = yield* client.load({ entry: request.entry }).pipe(Effect.result);
          if (loaded._tag === "Failure") {
            const failure = loaded.failure;
            return failure._tag === "EntryError"
              ? { ok: false, op: "load", id: failure.file, detail: failure.message }
              : { ok: false, op: "load", detail: sentenceOf(failure) };
          }
          return {
            ok: true,
            op: "load",
            id: loaded.success.id,
            registration: loaded.success.registration,
            detail: loaded.success.title,
          };
        }

        case "registrations": {
          const held = yield* client.registrations().pipe(Effect.orDie);
          return {
            ok: true,
            op: "registrations",
            registrations: held.live,
            diagnostics: held.unavailable,
          };
        }

        case "start": {
          // The suite's run id is the request, which is what makes a retried start the
          // same Run: the claim is the caller's, and the id is the host's.
          const started = yield* client
            .start({
              project: world.project,
              id: request.id,
              request: request.runId,
              input: request.input,
            })
            .pipe(Effect.result);
          if (started._tag === "Failure") {
            return { ok: false, op: "start", id: request.id, detail: sentenceOf(started.failure) };
          }
          const known = yield* readNames(fs, names);
          yield* writeNames(fs, names, {
            runs: { ...known.runs, [request.runId]: started.success.runId },
            told: known.told.filter((one) => one !== request.runId),
          });
          return {
            ok: true,
            op: "start",
            id: request.id,
            registration: started.success.registration,
          };
        }

        case "poll": {
          const polled = yield* client
            .status({ runId: yield* resolve(request.runId) })
            .pipe(Effect.result);
          if (polled._tag === "Failure") {
            return { ok: false, op: "poll", detail: sentenceOf(polled.failure) };
          }
          const value = polled.success;
          switch (value.status) {
            // A run that failed names the module it failed in: a service the author
            // never provided is not visible until the body asks for it.
            case "failed":
              return {
                ok: true,
                op: "poll",
                status: "failed",
                value: value.reason,
                id: value.entry,
              };
            case "complete":
              return { ok: true, op: "poll", status: "complete", value: value.value };
            default:
              return { ok: true, op: "poll", status: value.status };
          }
        }

        case "answer": {
          const answered = yield* client
            .answer({
              runId: yield* resolve(request.runId),
              decision: request.decision,
              value: request.value,
              // A suite that names no claim sends a fresh one per value: the same value
              // twice is still a second answer.
              request: request.request ?? `${request.runId}-${request.decision}-${request.value}`,
            })
            .pipe(Effect.result);
          return answered._tag === "Success"
            ? { ok: true, op: "answer", value: answered.success.value }
            : { ok: false, op: "answer", detail: sentenceOf(answered.failure) };
        }

        case "waiting": {
          const view = yield* client
            .run({ runId: yield* resolve(request.runId) })
            .pipe(Effect.orDie);
          const asked = view?.waiting ?? [];
          return {
            ok: true,
            op: "waiting",
            diagnostics: asked.filter((one) => one.answer === null).map((one) => one.name),
          };
        }

        case "hold":
          return yield* control(request.op, request.runId, "hold", true);

        case "stop":
          return yield* control(request.op, request.runId, "stop", true);

        case "release":
          return yield* control(request.op, request.runId, "hold", false);

        case "resume":
          return yield* control(request.op, request.runId, "stop", false);

        // The toolchain an author gets is installed by writing a module, which is the
        // only command that installs it.
        case "provision": {
          const written = yield* collie(world, ["workflow", "create", "toolchain-probe"]);
          const toolchain = written.envelope.ok
            ? (yield* Schema.decodeUnknownEffect(Written)(written.envelope.data).pipe(Effect.orDie))
                .toolchain
            : (written.envelope.error?.message ?? "workflow create failed");
          return toolchain === null
            ? { ok: true, op: "provision" }
            : { ok: false, op: "provision", detail: toolchain };
        }

        case "check": {
          const checked = yield* collie(world, ["workflow", "check", stem(request.entry)]);
          const envelope = checked.envelope;
          const report = yield* Schema.decodeUnknownEffect(Checked)(
            envelope.ok ? envelope.data : envelope.error?.details,
          ).pipe(Effect.orDie);
          const one = report.workflows.find((module) => module.path === request.entry);
          if (one === undefined) {
            return { ok: false, op: "check", detail: envelope.error?.message ?? "not checked" };
          }
          // Nothing typechecked is not a pass, and the reply says why nothing was.
          return one.toolchain === null
            ? { ok: true, op: "check", diagnostics: one.problems }
            : { ok: false, op: "check", detail: one.toolchain };
        }

        case "metadata": {
          const shown = yield* collie(world, ["workflow", "show", request.id]);
          if (!shown.envelope.ok) {
            return { ok: false, op: "metadata", detail: shown.envelope.error?.message ?? "" };
          }
          const described = yield* Schema.decodeUnknownEffect(Shown)(shown.envelope.data).pipe(
            Effect.orDie,
          );
          return {
            ok: true,
            op: "metadata",
            id: request.id,
            metadata: described.workflow.metadata,
          };
        }
      }
    }).pipe(
      Effect.orDie,
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.die(new Error(`no reply to ${JSON.stringify(request)}`)),
      }),
    );

  return {
    ask,
    tell: (request: HostRequest) =>
      Effect.gen(function* () {
        if (request.op === "start") {
          const known = yield* readNames(fs, names);
          yield* writeNames(fs, names, { ...known, told: [...known.told, request.runId] });
        }
        yield* Effect.forkIn(ask(request).pipe(Effect.ignore), scope);
      }),
    child,
    // A start does not wait for the workflow, so a test that wants a state asks until it
    // is there rather than sleeping for a duration it invented.
    until: (request: HostRequest, wanted: (reply: HostReply) => boolean) =>
      ask(request).pipe(
        Effect.flatMap((reply) =>
          wanted(reply) ? Effect.succeed(reply) : Effect.fail(new Error("not yet")),
        ),
        Effect.retry({ times: 80, schedule: Schedule.spaced("250 millis") }),
        Effect.orDie,
      ),
    stop: child.kill({ killSignal: "SIGTERM" }).pipe(
      Effect.ignore,
      Effect.andThen(
        until(
          () => ownerOf(state),
          (owner) => owner === null,
        ),
      ),
      Effect.asVoid,
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  } satisfies Host;
});

/**
 * Stops whatever owns this state directory, whether the test started it or recovered it.
 * A host outlives every client on purpose, so a suite that does not end one leaves it
 * running after the process that asked for it has gone.
 */
export const stopHost = Effect.fn("HostTest.stopHost")(function* (dir: string) {
  // A host that lost the race to start may still be booting, and takes the lock once its
  // owner has gone: whoever holds it is stopped, once each, until nobody does.
  const stopped = new Set<number>();
  yield* until(
    () =>
      ownerOf(dir).pipe(
        Effect.tap((owner) =>
          Effect.sync(() => {
            if (owner === null || stopped.has(owner.pid)) return;
            stopped.add(owner.pid);
            try {
              process.kill(owner.pid, "SIGTERM");
            } catch {
              // Already gone, which is the state this is trying to reach.
            }
          }),
        ),
      ),
    (holder) => holder === null,
  );
});

/**
 * An installation of its own, with the fixtures and the shipped modules saved where an
 * author saves theirs, a project to run them for, and the state directory a host owns.
 */
export const workspace = Effect.fn("HostTest.workspace")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix });
  const { world } = layoutOf(`${dir}/state`);
  for (const made of [
    world.user,
    `${world.install}/workflows`,
    world.state,
    world.config,
    world.home,
    world.project,
  ]) {
    yield* fs.makeDirectory(made, { recursive: true });
  }
  for (const name of [
    "proof.workflow.ts",
    "plain.workflow.ts",
    "broken.workflow.ts",
    "echo.workflow.ts",
    "unwired.workflow.ts",
    "conflicted.workflow.ts",
    "agent.workflow.ts",
    "rally.workflow.ts",
    "reviewed.workflow.ts",
    "graded.workflow.ts",
    "roster.workflow.ts",
    "sweep.workflow.ts",
    "spread.workflow.ts",
    "share.workflow.ts",
    "listing.ts",
    "offered.workflow.ts",
    "planned.workflow.ts",
    "hello.workflow.ts",
    "quiet.workflow.ts",
    "branches.workflow.ts",
    "delegates.workflow.ts",
    "declines.workflow.ts",
    "landing.workflow.ts",
    "capability.ts",
    "house.ts",
    "helper.ts",
    "notes.md",
  ]) {
    yield* fs.copyFile(`${fixtures}/${name}`, `${world.user}/${name}`);
  }
  // The shipped modules and the Markdown they read, beside the fixtures: what an author
  // is given has to hold the workflows Collie ships as well as the ones a test invents.
  for (const name of [
    "plan.workflow.ts",
    "plan.md",
    "review.workflow.ts",
    "review.md",
    "architecture.workflow.ts",
    "architecture.md",
    "implement.workflow.ts",
    "implement.md",
    "renovate.workflow.ts",
    "renovate.md",
    "reviewing.ts",
  ]) {
    yield* fs.copyFile(`${root}workflows/${name}`, `${world.user}/${name}`);
  }
  return { dir, wf: world.user, state: world.state };
});

/** What a run recorded, by the id the suite gave it or the one its host did. */
export const events = Effect.fn("HostTest.events")(function* (state: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const named = (yield* readNames(fs, layoutOf(state).names)).runs[runId] ?? runId;
  const text = yield* fs
    .readFileString(`${state}/events.${named}.log`)
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
