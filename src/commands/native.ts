// `collie native`: the fixture host the native-runtime proof drives.
//
// One process, one state directory, one line of JSON in and one out. It exists so a test
// can do to a real host what an operator's machine does — kill it, start it again, answer
// a decision, hold, stop, resume — against the compiled binary and a workflow file the
// checkout knows nothing about. The host Collie ships is `collie host`, which serves the
// same registry over a socket; what is left here is the operator controls that proof
// measured.

import { BunServices } from "@effect/platform-bun";
import { Console, Duration, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { configuredAgents } from "../agents";
import {
  typecheckEntry,
  type CrashPoint,
  hostLayer,
  HostReply,
  HostRequest,
  Registry,
  registryLayer,
  nativeHostLayer,
  provisionToolchain,
} from "../native";

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(HostRequest));
const encodeReply = Schema.encodeSync(Schema.fromJsonString(HostReply));

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
    crashAt: Flag.Literals("crash-at", ["admitted", "executed"]).pipe(
      Flag.withDescription(
        "Die mid-start, so recovery is proven: with the run recorded and the engine not told, or told and the receipt not written",
      ),
      Flag.optional,
    ),
  },
  (flags) => serve(flags.dir, flags.registrationTimeout, flags.crashAt),
).pipe(
  Command.withDescription(
    "Run one native workflow host on stdin/stdout (the native-runtime proof)",
  ),
);

const serve = (
  dir: string,
  registrationTimeout: Option.Option<number>,
  crashAt: Option.Option<CrashPoint>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    // Built in this command's scope, which is the host's: a registration outlives the
    // request that asked for one and is finalized when the host goes, never before.
    const registry = yield* Registry;

    const answer = (reply: typeof HostReply.Type) => Console.log(encodeReply(reply));

    /** A refusal, as this protocol says one: the op it was, and the sentence why. */
    const refused = (op: string, reason: string) => answer({ ok: false, op, detail: reason });

    const handle = Effect.fn("Native.handle")(function* (request: typeof HostRequest.Type) {
      switch (request.op) {
        case "ping":
          return yield* answer({ ok: true, op: "ping" });

        case "load": {
          const loaded = yield* registry.load(request.entry).pipe(Effect.result);
          if (loaded._tag === "Failure") {
            return yield* answer({
              ok: false,
              op: "load",
              id: loaded.failure.file,
              detail: loaded.failure.message,
            });
          }
          return yield* answer({
            ok: true,
            op: "load",
            id: loaded.success.id,
            registration: loaded.success.name,
            detail: loaded.success.title,
          });
        }

        case "registrations": {
          const held = yield* registry.registrations;
          return yield* answer({
            ok: true,
            op: "registrations",
            registrations: held.live,
            diagnostics: held.unavailable,
          });
        }

        case "start": {
          // This host is handed a file rather than asked about a project, and the run id
          // it is given is the claim: one start per run id, retried by run id.
          const started = yield* registry.newest(request.id).pipe(
            Effect.flatMap((generation) =>
              registry.start({
                generation,
                request: request.runId,
                project: "",
                runId: request.runId,
                input: request.input,
              }),
            ),
            Effect.result,
          );
          if (started._tag === "Failure") {
            return yield* answer({
              ok: false,
              op: "start",
              id: request.id,
              detail: started.failure.reason,
            });
          }
          return yield* answer({
            ok: true,
            op: "start",
            id: request.id,
            registration: started.success.registration,
          });
        }

        case "poll": {
          const status = yield* registry.status(request.runId).pipe(Effect.result);
          if (status._tag === "Failure") return yield* refused("poll", status.failure.reason);
          const value = status.success;
          switch (value.status) {
            // A run that failed names the module it failed in: a service the author
            // never provided is not visible until the body asks for it.
            case "failed":
              return yield* answer({
                ok: true,
                op: "poll",
                status: "failed",
                value: value.reason,
                id: value.entry,
              });
            case "complete":
              return yield* answer({
                ok: true,
                op: "poll",
                status: "complete",
                value: value.value,
              });
            default:
              return yield* answer({ ok: true, op: "poll", status: value.status });
          }
        }

        case "answer": {
          const done = yield* registry
            .answer({ runId: request.runId, decision: request.decision, value: request.value })
            .pipe(Effect.result);
          return yield* done._tag === "Success"
            ? answer({ ok: true, op: "answer" })
            : refused("answer", done.failure.reason);
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
          return yield* done._tag === "Success"
            ? answer({ ok: true, op: "provision" })
            : refused("provision", done.failure.message);
        }

        case "metadata": {
          const found = yield* registry.newest(request.id).pipe(Effect.result);
          if (found._tag === "Failure") return yield* refused("metadata", found.failure.reason);
          return yield* answer({
            ok: true,
            op: "metadata",
            id: request.id,
            registration: found.success.name,
            metadata: found.success.metadata,
          });
        }

        case "check": {
          const done = yield* typecheckEntry({ dir: request.dir, file: request.entry }).pipe(
            Effect.result,
          );
          return yield* done._tag === "Success"
            ? answer({ ok: true, op: "check", diagnostics: done.success })
            : refused("check", done.failure.message);
        }
      }
    });

    const control = Effect.fn("Native.control")(function* (
      request: { readonly op: string; readonly id: string; readonly runId: string },
      name: string,
      set: boolean,
    ) {
      const found = yield* registry.routed(request.runId).pipe(Effect.result);
      if (found._tag === "Failure") return yield* refused(request.op, found.failure.reason);
      yield* flag(name, request.runId, set, false);
      yield* engine.resume(found.success.generation.registration.workflow, found.success.execution);
      yield* answer({ ok: true, op: request.op });
    });

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
  }).pipe(
    Effect.provide(registryLayer(dir, { crashAt: Option.getOrUndefined(crashAt) })),
    Effect.provide(
      hostLayer({ dir, registrationTimeout: registrationTimeoutOf(registrationTimeout) }),
    ),
    Effect.provide(nativeHostLayer(dir)),
    Effect.provide(Layer.unwrap(configuredAgents(dir))),
    Effect.provide(BunServices.layer),
    Effect.scoped,
    Effect.orDie,
  );

const registrationTimeoutOf = (flag: Option.Option<number>) =>
  Option.isSome(flag) ? Duration.millis(flag.value) : undefined;
