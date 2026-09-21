// `collie native`: the fixture host the native-runtime proof drives.
//
// One process, one state directory, one line of JSON in and one out. It exists so a test
// can do to a real host what an operator's machine does — kill it, start it again, answer
// a decision, hold, stop, resume — against the compiled binary and a workflow file the
// checkout knows nothing about. It is not the host Collie will ship.

import { BunServices } from "@effect/platform-bun";
import {
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import {
  answerDecision,
  typecheckEntry,
  clearGenerations,
  hostLayer,
  HostReply,
  HostRequest,
  loadEntry,
  nativeHostLayer,
  nextRegistrationName,
  pollStatus,
  provisionToolchain,
  readRouting,
  stageGeneration,
  writeRouting,
} from "../native";
import { describeMetadata, type Registration } from "../sdk";

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(HostRequest));
const encodeReply = Schema.encodeSync(Schema.fromJsonString(HostReply));

/** What the host is holding: the entry's public id against its live registration. */
interface Loaded {
  readonly registrationName: string;
  readonly title: string;
  /** The file it came from, so a failure of the author's names what to open. */
  readonly entry: string;
  /** What the module declared about itself, as a card and a launch would read it. */
  readonly metadata: Schema.Json;
  readonly registration: Registration;
}

export const native = Command.make(
  "native",
  {
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The state directory this host owns, SQLite and flags alike"),
    ),
    registrationTimeout: Flag.Int("registration-timeout-ms").pipe(
      Flag.withDescription("How long a message waits for a missing module; unset waits forever"),
      Flag.optional,
    ),
  },
  (flags) => serve(flags.dir, flags.registrationTimeout),
).pipe(
  Command.withDescription(
    "Run one native workflow host on stdin/stdout (the native-runtime proof)",
  ),
);

const serve = (dir: string, registrationTimeout: Option.Option<number>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    /** Every generation this host is holding, by its native registration name. */
    const live = new Map<string, Loaded>();
    /** Why a recorded generation is not holdable, so a caller hears the file, not a timeout. */
    const unavailable = new Map<string, string>();
    /** Which generation of an id new work goes to. */
    const newest = new Map<string, string>();
    let routing = yield* readRouting(dir);
    // Staged copies last only as long as this host: every generation below is staged
    // from the module as it is now, never restored.
    yield* clearGenerations(dir);

    // Registrations are built in this scope — the host's — so they outlive the command
    // that asked for one and are finalized when the host goes, never before.
    const hostScope = yield* Scope.make();

    const answer = (reply: typeof HostReply.Type) => Console.log(encodeReply(reply));

    const register = Effect.fn("Native.register")(function* (route: {
      readonly id: string;
      readonly name: string;
      readonly entry: string;
    }) {
      const entry = yield* stageGeneration({ dir, name: route.name, entry: route.entry }).pipe(
        Effect.flatMap(loadEntry),
        Effect.result,
      );
      if (entry._tag === "Failure") {
        unavailable.set(route.name, `${entry.failure.file}: ${entry.failure.message}`);
        return entry.failure.message;
      }
      const registration = entry.success.make(route.name);
      yield* Layer.buildWithScope(registration.layer, hostScope).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      );
      live.set(route.name, {
        registrationName: route.name,
        title: entry.success.title,
        entry: route.entry,
        metadata: describeMetadata(entry.success.metadata),
        registration,
      });
      unavailable.delete(route.name);
      newest.set(route.id, route.name);
      return null;
    });

    // What was registered before this host existed, rebuilt from the modules as they are
    // now. A file that has gone leaves its generation unavailable and every other one
    // registered, which is what keeps one broken module from stopping the rest.
    for (const route of routing.registrations) yield* register(route);

    /** The generation a run belongs to: the one it started on, never the newest. */
    const routeOf = (runId: string) => routing.runs[runId];

    const handle = Effect.fn("Native.handle")(function* (request: typeof HostRequest.Type) {
      switch (request.op) {
        case "ping":
          return yield* answer({ ok: true, op: "ping" });

        case "load": {
          // Read once to learn the id this file claims, then register the next
          // generation of that id.
          const described = yield* loadEntry(request.entry).pipe(Effect.result);
          if (described._tag === "Failure") {
            return yield* answer({
              ok: false,
              op: "load",
              id: described.failure.file,
              detail: described.failure.message,
            });
          }
          const name = nextRegistrationName(routing, described.success.id);
          const route = { id: described.success.id, name, entry: request.entry };
          const failure = yield* register(route);
          if (failure) return yield* answer({ ok: false, op: "load", detail: failure });
          routing = { ...routing, registrations: [...routing.registrations, route] };
          yield* writeRouting(dir, routing);
          return yield* answer({
            ok: true,
            op: "load",
            id: described.success.id,
            registration: name,
            detail: live.get(name)?.title ?? described.success.title,
          });
        }

        case "registrations":
          return yield* answer({
            ok: true,
            op: "registrations",
            registrations: [...live.keys()].sort(),
            diagnostics: [...unavailable.entries()].map(([name, why]) => `${name}: ${why}`).sort(),
          });

        case "start": {
          const name = newest.get(request.id);
          const entry = name ? live.get(name) : undefined;
          if (!entry) return yield* missing("start", request.id);
          // Settled before anything exists to clean up: an input the workflow's own
          // schema rejects names its field here, and no run, routing row or execution
          // is created for it.
          const payload = yield* Schema.decodeUnknownEffect(
            entry.registration.workflow.payloadSchema,
          )({ runId: request.runId, input: request.input }).pipe(Effect.result);
          if (payload._tag === "Failure") {
            return yield* answer({
              ok: false,
              op: "start",
              id: request.id,
              detail: `invalid_input: ${String(payload.failure)}`,
            });
          }
          const execution = yield* entry.registration.workflow.executionId(payload.success);
          routing = {
            ...routing,
            runs: {
              ...routing.runs,
              [request.runId]: { registration: entry.registrationName, execution },
            },
          };
          yield* writeRouting(dir, routing);
          yield* engine.execute(entry.registration.workflow, {
            executionId: execution,
            payload: payload.success,
            discard: true,
          });
          return yield* answer({
            ok: true,
            op: "start",
            id: request.id,
            registration: entry.registrationName,
          });
        }

        case "poll": {
          const found = yield* held("poll", request.runId);
          if (!found) return;
          const result = yield* engine.poll(found.entry.registration.workflow, found.execution);
          const status = pollStatus(result);
          // A run that failed names the module it failed in: a service the author never
          // provided is not visible until the body asks for it, and this is that moment.
          if (status.status === "failed") {
            return yield* answer({ ok: true, op: "poll", ...status, id: found.entry.entry });
          }
          return yield* answer({ ok: true, op: "poll", ...status });
        }

        case "answer": {
          const found = yield* held("answer", request.runId);
          if (!found) return;
          const done = yield* answerDecision(found.entry.registration, {
            name: request.decision,
            executionId: found.execution,
            value: request.value,
          }).pipe(Effect.result);
          return yield* answer(
            done._tag === "Success"
              ? { ok: true, op: "answer" }
              : { ok: false, op: "answer", detail: done.failure.message },
          );
        }

        case "hold":
          return yield* flag("hold", request.runId, true);

        // Setting the flag is not enough: a run parked on its decision has nothing that
        // would make it read the flag, so stopping wakes it and the wait suspends itself.
        // Releasing and resuming clear the flag first, so the run that wakes up does not
        // find the request that stopped it still there.
        case "stop":
          return yield* control(request, "stop", true);

        case "release":
          return yield* control(request, "hold", false);

        case "resume":
          return yield* control(request, "stop", false);

        case "provision": {
          const done = yield* provisionToolchain(request.dir).pipe(Effect.result);
          return yield* answer(
            done._tag === "Success"
              ? { ok: true, op: "provision" }
              : { ok: false, op: "provision", detail: done.failure.message },
          );
        }

        case "metadata": {
          const name = newest.get(request.id);
          const entry = name ? live.get(name) : undefined;
          if (!entry) return yield* missing("metadata", request.id);
          return yield* answer({
            ok: true,
            op: "metadata",
            id: request.id,
            registration: entry.registrationName,
            metadata: entry.metadata,
          });
        }

        case "check": {
          const done = yield* typecheckEntry({ dir: request.dir, file: request.entry }).pipe(
            Effect.result,
          );
          return yield* answer(
            done._tag === "Success"
              ? { ok: true, op: "check", diagnostics: done.success }
              : { ok: false, op: "check", detail: done.failure.message },
          );
        }
      }
    });

    /**
     * The generation a run is on, or the reason this host cannot act for it. A module
     * that is missing or broken leaves the work where it is and names the file, rather
     * than reporting it as failed or running it on whatever code is loaded now.
     */
    const held = Effect.fn("Native.held")(function* (op: string, runId: string) {
      const route = routeOf(runId);
      if (!route) {
        yield* answer({ ok: false, op, detail: `no run "${runId}" was started here` });
        return undefined;
      }
      const entry = live.get(route.registration);
      if (!entry) {
        yield* answer({
          ok: false,
          op,
          registration: route.registration,
          detail:
            unavailable.get(route.registration) ??
            `${route.registration} is not registered in this host`,
        });
        return undefined;
      }
      return { entry, execution: route.execution };
    });

    const control = Effect.fn("Native.control")(function* (
      request: { readonly op: string; readonly id: string; readonly runId: string },
      name: string,
      set: boolean,
    ) {
      const found = yield* held(request.op, request.runId);
      if (!found) return;
      yield* flag(name, request.runId, set, false);
      yield* engine.resume(found.entry.registration.workflow, found.execution);
      yield* answer({ ok: true, op: request.op });
    });

    const missing = (op: string, id: string) =>
      Console.log(encodeReply({ ok: false, op, detail: `no workflow "${id}" is loaded here` }));

    const flag = Effect.fn("Native.flag")(function* (
      name: string,
      runId: string,
      set: boolean,
      reply = true,
    ) {
      const fs = yield* FileSystem.FileSystem;
      const path = `${dir}/${name}.${runId}`;
      yield* (set ? fs.writeFileString(path, "") : fs.remove(path).pipe(Effect.ignore)).pipe(
        Effect.orDie,
      );
      if (reply) yield* Console.log(encodeReply({ ok: true, op: name }));
    });

    yield* Stream.fromReadableStream({
      evaluate: () => Bun.stdin.stream(),
      onError: (cause) => new Error(String(cause)),
    }).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.mapEffect((line) =>
        decodeRequest(line).pipe(
          Effect.flatMap(handle),
          Effect.catch((cause) =>
            Console.log(encodeReply({ ok: false, op: "request", detail: String(cause) })),
          ),
        ),
      ),
      Stream.runDrain,
    );
    yield* Scope.close(hostScope, Exit.void);
  }).pipe(
    Effect.provide(
      hostLayer({ dir, registrationTimeout: registrationTimeoutOf(registrationTimeout) }),
    ),
    Effect.provide(nativeHostLayer(dir)),
    Effect.provide(BunServices.layer),
    Effect.scoped,
    Effect.orDie,
  );

const registrationTimeoutOf = (flag: Option.Option<number>) =>
  Option.isSome(flag) ? Duration.millis(flag.value) : undefined;
