// `collie native`: the fixture host the native-runtime proof drives.
//
// One process, one state directory, one line of JSON in and one out. It exists so a test
// can do to a real host what an operator's machine does — kill it, start it again, answer
// a decision, hold, stop, resume — against the compiled binary and a workflow file the
// checkout knows nothing about. The host Collie ships is `collie host`, which serves the
// same registry over a socket; what is left here is the operator controls that proof
// measured.

import { BunServices } from "@effect/platform-bun";
import { Console, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { configuredAgents } from "../agents";
import {
  typecheckEntry,
  type CrashPoint,
  foundationLayer,
  HostReply,
  HostRequest,
  Registry,
  registryLayer,
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
            .answer({
              runId: request.runId,
              decision: request.decision,
              value: request.value,
              // A fixture host has no front door to mint one, so the answer is its
              // own claim: the same value twice is still a second answer.
              request: request.request ?? `${request.runId}-${request.decision}-${request.value}`,
            })
            .pipe(Effect.result);
          return yield* done._tag === "Success"
            ? answer({ ok: true, op: "answer", value: done.success.value })
            : refused("answer", done.failure.reason);
        }

        case "waiting": {
          const open = yield* registry.waiting(request.runId);
          return yield* answer({
            ok: true,
            op: "waiting",
            diagnostics: open.filter((one) => one.answer === null).map((one) => one.name),
            metadata: open.map((one) => ({ ...one, options: [...one.options] })),
          });
        }

        // Setting a control is not enough on its own: a run parked on its question has
        // nothing that would make it look again, so everything but a hold wakes it — a
        // stop so the wait suspends itself, a release or a resume so it carries on. The
        // registry clears the control first, so what wakes up does not find it still set.
        case "hold":
          return yield* control(request.op, request.runId, "hold", true);

        case "stop":
          return yield* control(request.op, request.runId, "stop", true);

        case "release":
          return yield* control(request.op, request.runId, "hold", false);

        case "resume":
          return yield* control(request.op, request.runId, "stop", false);

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
      op: string,
      runId: string,
      name: "hold" | "stop",
      set: boolean,
    ) {
      const done = yield* registry.control({ runId, control: name, set }).pipe(Effect.result);
      if (done._tag === "Failure") return yield* refused(op, done.failure.reason);
      // Recorded either way, and the reply says which: a control over work no host is
      // running is an intent, never a confirmation.
      yield* answer({ ok: true, op, detail: done.success.detail });
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
      foundationLayer({ dir, registrationTimeout: registrationTimeoutOf(registrationTimeout) }),
    ),
    Effect.provide(Layer.unwrap(configuredAgents(dir))),
    Effect.provide(BunServices.layer),
    Effect.scoped,
    Effect.orDie,
  );

const registrationTimeoutOf = (flag: Option.Option<number>) =>
  Option.isSome(flag) ? Duration.millis(flag.value) : undefined;
