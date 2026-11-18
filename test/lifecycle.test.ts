import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Option, Schema, Scope, Stream } from "effect";
import type { PlatformServices } from "../src/platform";
import { writeConfigValue } from "../src/config";
import { currentEnv } from "../src/env";
import { pickFlow, type FlowPrompts } from "../src/flows";
import { Herdr } from "../src/herdr";
import { HostUnavailable, connect } from "../src/host";
import { refusal, runView, runViews } from "../src/lifecycle";
import { HostRefused } from "../src/board-model";
import { MachineUnreachable } from "../src/peers-model";
import { runDir, type RunView } from "../src/engine";
import { readAudit } from "../src/audit";
import { readDispositions } from "../src/disposition";
import { recordsReadLayer } from "../src/records";
import { RunRecords } from "../src/run-records";
import { hostRecords } from "./support/records";
import { events, stopHost, until } from "./support/host";
import { collie, proves as provesWith, save, type World } from "./support/world";

const MODULE = ["proof.workflow.ts", "helper.ts", "notes.md"] as const;

const OTHER = ["plain.workflow.ts"] as const;

const Payload = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(
    Schema.Struct({
      runId: Schema.String,
      status: Schema.Unknown,
      parked: Schema.optional(Schema.NullOr(Schema.String)),
      controls: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  runs: Schema.optional(Schema.Array(Schema.Struct({ runId: Schema.String }))),
});
const payloadOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Payload)(envelope.data).pipe(Effect.orDie);

const proves = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
) => provesWith(prefix, body, [...MODULE, ...OTHER]);

test("a run carries what it was started on and what it belongs to, for whoever asks the host", () =>
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

      expect(
        Arr.map(yield* client.runs({ task: null }).pipe(Effect.orDie), (one) => one.runId),
      ).toEqual([started.runId]);
      expect(yield* client.runs({ task: "task-other" }).pipe(Effect.orDie)).toEqual([]);
      expect(yield* client.run({ runId: "run-nobody" }).pipe(Effect.orDie)).toBeNull();
      yield* stopHost(world.state);
    }),
  ));

test("a run whose module has gone is still readable, with the file to repair named", () =>
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
      expect(view?.status).toEqual({ status: "pending" });
      expect(view?.diagnostic).toContain("proof.workflow.ts");
      expect(view?.entry).toBe(`${world.user}/proof.workflow.ts`);
      expect((yield* client.runs({ task: null }).pipe(Effect.orDie))[0]?.runId).toBe(runId);

      const beside = yield* client
        .start({ project: world.project, id: "plain", request: "req-2", input: { note: "fine" } })
        .pipe(Effect.orDie);
      expect(
        (yield* until(
          () => client.run({ runId: beside.runId }),
          (one) => one?.status.status === "complete",
        ))?.status,
      ).toEqual({ status: "complete", value: "plain:fine" });

      yield* save(world.user, MODULE);
      const recovered = yield* client.recover().pipe(Effect.orDie);
      expect(recovered.live).toContain("proof@1");
      expect(recovered.unavailable).toEqual([]);
      yield* client
        .answer({ runId, decision: "decision", value: "back", request: "answer-back" })
        .pipe(Effect.orDie);
      expect(
        (yield* until(
          () => client.run({ runId }),
          (view) => view?.status.status === "complete",
        ))?.status,
      ).toEqual({ status: "complete", value: "note:durable=back" });
      expect(
        Arr.filter(yield* events(world.state, runId), (line) =>
          pipe_(line, Str.startsWith("launch")),
        ),
      ).toHaveLength(1);
      yield* stopHost(world.state);
    }),
  ));

test("a client that closes and comes back is told where the work is now, not what it missed", () =>
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
          yield* Stream.runHead(
            client
              .watch({ runId: started.runId })
              .pipe(Stream.filter((view) => view?.status.status === "suspended")),
          );
          return started.runId;
        }),
      ).pipe(Effect.orDie);

      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* client
        .answer({ runId, decision: "decision", value: "again", request: "answer-again" })
        .pipe(Effect.orDie);
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
  ));

test("a hold on a waiting Run reaches whoever is watching it, though its status stays the same", () =>
  proves("collie-lifecycle-watch-hold-", (world) =>
    Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const { runId } = yield* client
        .start({ project: world.project, id: "proof", request: "req-1", input: { note: "x" } })
        .pipe(Effect.orDie);
      yield* Stream.runHead(
        client.watch({ runId }).pipe(Stream.filter((view) => view?.status.status === "suspended")),
      );
      const subscribed = yield* Deferred.make<void>();
      const watching = yield* Effect.forkChild(
        Stream.runHead(
          client.watch({ runId }).pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.filter((view) => view?.controls.includes("hold") === true),
          ),
        ),
      );
      yield* Deferred.await(subscribed);
      yield* Effect.sleep("2 seconds");

      yield* client
        .control({ runId, control: "hold", set: true, request: "hold-watched" })
        .pipe(Effect.orDie);
      const seen = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"), Effect.orDie);
      expect(Option.getOrNull(seen)?.status).toEqual({ status: "suspended" });
      yield* stopHost(world.state);
    }),
  ));

test("the command line starts a module, shows it, lists it and waits on it, and a retry is the same run", () =>
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
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr((yield* payloadOf(listed.envelope)).runs), (present) =>
            Arr.map(present, (one) => one.runId),
          ),
        ),
      ).toEqual([runId]);

      const asked = yield* collie(world, ["run", "wait", runId, "--until", "attention"]);
      expect(asked.exit).toBe(0);
      expect((yield* payloadOf(asked.envelope)).run?.status).toEqual({
        status: "suspended",
      });

      const client = yield* connect(world.state).pipe(Effect.orDie);
      yield* client
        .answer({ runId, decision: "decision", value: "done", request: "answer-done" })
        .pipe(Effect.orDie);
      const finished = yield* collie(world, ["run", "wait", runId]);
      expect((yield* payloadOf(finished.envelope)).run?.status).toEqual({
        status: "complete",
        value: "note:cli=done",
      });
      yield* stopHost(world.state);
    }),
  ));

test("a run whose module went missing is picked up again by resuming it, and says so until it is", () =>
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

      yield* stopHost(world.state);
      yield* fs.remove(`${world.user}/proof.workflow.ts`).pipe(Effect.orDie);
      const orphaned = yield* collie(world, ["run", "show", runId]);
      expect(orphaned.exit).toBe(0);
      expect(orphaned.envelope.ok).toBe(true);

      const unavailable = yield* collie(world, ["run", "resume", runId]);
      expect(unavailable.exit).not.toBe(0);
      expect(unavailable.envelope.error?.code).toBe("operation_failed");
      expect(unavailable.envelope.error?.message).toContain("proof.workflow.ts");

      yield* save(world.user, MODULE);
      const resumed = yield* collie(world, ["run", "resume", runId]);
      expect(resumed.exit).toBe(0);
      expect((yield* payloadOf(resumed.envelope)).run?.status).toEqual({
        status: "suspended",
      });
      yield* stopHost(world.state);
    }),
  ));

test("workspace=projects-root roots a Run at the Projects root, and a worktree cannot be cut there", () =>
  provesWith(
    "collie-lifecycle-root-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = `${world.home}/projects`;
        yield* fs.makeDirectory(`${root}/app/.git`, { recursive: true });
        yield* writeConfigValue(world.config, "projects.root", root);

        const started = yield* collie(world, [
          "run",
          "start",
          "planned",
          "--input",
          "goal=one registry",
          "--input",
          "workspace=projects-root",
        ]);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        expect(runId).not.toBe("");
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const view = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(view?.cwd).toBe(root);

        const refused = yield* collie(world, [
          "run",
          "start",
          "builds",
          "--input",
          "work=one registry",
          "--input",
          "workspace=projects-root",
        ]);
        expect(refused.envelope.ok).toBe(false);
        expect(refused.envelope.error?.message).toContain("is not a git checkout to cut one from");
        yield* stopHost(world.state);
      }),
    ["planned.workflow.ts", "builds.workflow.ts"],
  ));

test("projects-root is the root the starting front door resolved, whatever the running host's environment", () =>
  provesWith(
    "collie-lifecycle-root-once-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* collie(world, ["run", "start", "planned", "--input", "goal=warm"]);
        expect(first.exit).toBe(0);

        const root = `${world.home}/gitte`;
        yield* fs.makeDirectory(`${root}/app/.git`, { recursive: true });
        const started = yield* collie(
          world,
          ["run", "start", "planned", "--input", "goal=x", "--input", "workspace=projects-root"],
          { GITTE_CWD: root },
        );
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        const client = yield* connect(world.state).pipe(Effect.orDie);
        expect((yield* client.run({ runId }).pipe(Effect.orDie))?.cwd).toBe(root);
        yield* stopHost(world.state);
      }),
    ["planned.workflow.ts"],
  ));

test("a resume answers with the Run as it is once its stop is cleared", () =>
  proves("collie-lifecycle-unstop-", (world) =>
    Effect.gen(function* () {
      const started = yield* collie(world, ["run", "start", "proof", "--input", "note=x"]);
      const runId = (yield* payloadOf(started.envelope)).runId ?? "";
      yield* collie(world, ["run", "wait", runId, "--until", "attention"]);
      yield* collie(world, ["run", "stop", runId]);

      const resumed = yield* collie(world, ["run", "resume", runId]);
      expect(resumed.exit).toBe(0);
      expect((yield* payloadOf(resumed.envelope)).run?.controls).not.toContain("stop");
      yield* stopHost(world.state);
    }),
  ));

test("a start with no checks written down is admitted, for its agent to name them", () =>
  provesWith(
    "collie-lifecycle-unnamed-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "proved", "--input", "note=x"]);
        expect(started.envelope.ok).toBe(true);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        const finished = yield* collie(world, ["run", "wait", runId]);
        expect((yield* payloadOf(finished.envelope)).run?.status).toEqual({
          status: "complete",
          value: "",
        });
        yield* stopHost(world.state);
      }),
    ["proved.workflow.ts"],
  ));

test("a start given its checks with --verify is admitted, and its Intent grants exactly those", () =>
  provesWith(
    "collie-lifecycle-verify-flag-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, [
          "run",
          "start",
          "proved",
          "--input",
          "note=x",
          "--verify",
          '{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}',
          "--verify",
          '{"name":"lint","executable":"true","argv":[],"cwd":"worktree"}',
        ]);
        expect(started.envelope.ok).toBe(true);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        const shown = yield* collie(world, ["run", "intent", "show", runId]);
        expect(shown.envelope.data).toMatchObject({
          intent: { authority: { run_verification: [{ name: "unit" }, { name: "lint" }] } },
        });
        const finished = yield* collie(world, ["run", "wait", runId]);
        expect((yield* payloadOf(finished.envelope)).run?.status).toEqual({
          status: "complete",
          value: "unit,lint",
        });

        const grant = (...args: ReadonlyArray<string>) =>
          collie(world, ["run", "intent", "verification", runId, ...args]);
        const e2e = ["--name", "e2e", "--request-id", "g-e2e", "--", "true"];
        expect((yield* grant(...e2e)).envelope.ok).toBe(true);
        expect((yield* grant(...e2e)).envelope.ok).toBe(true);
        const grants = Arr.filter(
          yield* readAudit(runDir(world.state, runId)).pipe(
            Effect.provide(recordsReadLayer(world.state)),
          ),
          (one) => one.operation === "grant",
        );
        expect(Arr.map(grants, (one) => one.request)).toEqual(["g-e2e"]);
        const withdrawn = yield* grant("--name", "lint", "--remove");
        expect(withdrawn.envelope.data).toMatchObject({
          approved: [{ name: "unit" }, { name: "e2e" }],
        });
        const regranted = yield* collie(world, ["run", "intent", "show", runId]);
        expect(regranted.envelope.data).toMatchObject({
          intent: { authority: { run_verification: [{ name: "unit" }, { name: "e2e" }] } },
        });
        yield* stopHost(world.state);
      }),
    ["proved.workflow.ts"],
  ));

test("a check named outside the Run's tree is refused naming the directory and the Run, and one inside is kept", () =>
  provesWith(
    "collie-lifecycle-outside-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "proved", "--input", "note=x"]);
        const runId = (yield* payloadOf(started.envelope)).runId ?? "";
        yield* collie(world, ["run", "wait", runId]);
        const name = (check: string, ...cwd: ReadonlyArray<string>) =>
          collie(world, [
            "run",
            "intent",
            "verification",
            runId,
            "--name",
            check,
            ...cwd,
            "--",
            "true",
          ]);

        for (const outside of ["/", "../.."]) {
          const refused = yield* name("away", "--cwd", outside);
          expect(refused.envelope.ok).toBe(false);
          expect(refused.envelope.error?.message).toContain(`is not inside run ${runId}`);
        }
        expect((yield* name("unit")).envelope.ok).toBe(true);
        const kept = yield* name("lint", "--cwd", ".");
        expect(kept.envelope.data).toMatchObject({
          approved: [
            { name: "unit", cwd: "worktree" },
            { name: "lint", cwd: "." },
          ],
        });
        const withdrawn = yield* collie(world, [
          "run",
          "intent",
          "verification",
          runId,
          "--name",
          "lint",
          "--cwd",
          "/",
          "--remove",
        ]);
        expect(withdrawn.envelope.data).toMatchObject({ approved: [{ name: "unit" }] });
        yield* stopHost(world.state);
      }),
    ["proved.workflow.ts"],
  ));

test("a verify.json that does not read is refused by name, never taken as no checks", () =>
  provesWith(
    "collie-lifecycle-bad-verify-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${world.project}/.collie`, { recursive: true });
        yield* fs.writeFileString(`${world.project}/.collie/verify.json`, '[{"name":');
        const started = yield* collie(world, ["run", "start", "proof", "--input", "note=x"]);
        expect(started.envelope.ok).toBe(false);
        expect(started.envelope.error?.message).toContain(".collie/verify.json");
        yield* stopHost(world.state);
      }),
    [...MODULE],
  ));

const answering = (script: ReadonlyArray<string>) => {
  const answers = [...script];
  const asked: Array<string> = [];
  const prompts: FlowPrompts = {
    menu: (items, options) => {
      asked.push(options.header);
      const wanted = answers.shift();
      return Effect.succeed(
        Option.getOrUndefined(Arr.findFirst(items, (item) => item.id === wanted)) ?? null,
      );
    },
    ask: (question) => {
      asked.push(question);
      return Effect.succeed(answers.shift() ?? null);
    },
  };
  return { prompts, asked };
};

test("the picker offers a saved module and starts the same Run the command line would", () =>
  proves("collie-lifecycle-picker-", (world) =>
    Effect.gen(function* () {
      const env = yield* currentEnv;
      const { prompts, asked } = answering(["proof", "picked"]);
      expect(yield* pickFlow(new Herdr(env), env, prompts)).toBe(0);
      expect(Arr.some(asked, (question) => pipe_(question, Str.includes("Workflows")))).toBe(true);
      expect(asked.at(-1)).toBe("What do you want?");

      const listed = yield* runViews(env, null);
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
          () => runView(env, runId),
          (view) => view !== null && "status" in view && view.status.status === "suspended",
        ),
      ).toMatchObject({ runId, workflow: "proof", input: { note: "picked" } });
      yield* stopHost(world.state);
    }),
  ));

const waitingOn = (view: RunView | null) =>
  Arr.map(
    Arr.filter(view?.waiting ?? [], (one) => one.answer === null),
    (one) => one.name,
  );

test("two answers racing settle the question once, and both front doors refuse the loser alike", () =>
  proves("collie-lifecycle-answer-", (world) =>
    Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({ project: world.project, id: "proof", request: "req-1", input: { note: "race" } })
        .pipe(Effect.orDie);
      const runId = started.runId;
      yield* until(
        () => client.run({ runId }).pipe(Effect.orDie),
        (view) => waitingOn(view).includes("decision"),
      );

      const [first, second] = yield* Effect.all(
        [
          client
            .answer({ runId, decision: "decision", value: "left", request: "ans-left" })
            .pipe(Effect.result),
          client
            .answer({ runId, decision: "decision", value: "right", request: "ans-right" })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.orDie);
      const outcomes = [first, second];
      expect(Arr.filter(outcomes, (one) => one._tag === "Success")).toHaveLength(1);
      const refused = Option.getOrUndefined(
        Arr.findFirst(outcomes, (one) => one._tag === "Failure"),
      );
      expect(refused?._tag === "Failure" && refused.failure.reason).toContain("already answered");

      const won = Option.getOrUndefined(Arr.findFirst(outcomes, (one) => one._tag === "Success"));
      const value = won?._tag === "Success" ? won.success.value : "";
      expect(
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        ),
      ).toMatchObject({ status: { status: "complete", value: `note:race=${value}` } });

      const late = yield* collie(world, ["run", "answer", runId, "late", "--decision", "decision"]);
      expect(late.envelope.ok).toBe(false);
      expect(late.envelope.error?.message).toContain("already answered");
      yield* stopHost(world.state);
    }),
  ));

test("a held Run says so wherever it is read, and releasing it from the command line lets it on", () =>
  proves("collie-lifecycle-hold-", (world) =>
    Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({ project: world.project, id: "proof", request: "req-1", input: { note: "held" } })
        .pipe(Effect.orDie);
      const runId = started.runId;
      yield* until(
        () => client.run({ runId }).pipe(Effect.orDie),
        (view) => waitingOn(view).includes("decision"),
      );

      const held = yield* client
        .control({ runId, control: "hold", set: true, request: "hold-1" })
        .pipe(Effect.orDie);
      expect(held).toMatchObject({ applied: true, detail: "" });
      expect((yield* client.run({ runId }).pipe(Effect.orDie))?.controls).toEqual(["hold"]);
      const shown = yield* collie(world, ["run", "show", runId]);
      expect(shown.envelope.ok).toBe(true);

      const released = yield* collie(world, ["run", "release", runId]);
      expect(released.envelope.ok).toBe(true);
      expect((yield* client.run({ runId }).pipe(Effect.orDie))?.controls).toEqual([]);

      yield* client
        .answer({ runId, decision: "decision", value: "on", request: "ans" })
        .pipe(Effect.orDie);
      expect(
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        ),
      ).toMatchObject({ status: { status: "complete", value: "note:held=on" } });
      yield* stopHost(world.state);
    }),
  ));

test("a Run the host owns is verified by the same command, bound to the tree it ran on", () =>
  proves("collie-lifecycle-verify-", (world) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({
          project: world.project,
          id: "proof",
          request: "req-1",
          input: { note: "verified" },
        })
        .pipe(Effect.orDie);

      const recorded = yield* collie(world, [
        "verify",
        "--run",
        started.runId,
        "--name",
        "unit",
        "--",
        "true",
      ]);
      expect(recorded.envelope.ok).toBe(true);
      const journal = yield* journalOf(
        world,
        started.runId,
        "evidence/steering/verifications.jsonl",
      ).pipe(Effect.orDie);
      expect(journal).toContain(`"name":"unit"`);
      expect(journal).toContain(`"result":"pass"`);
      expect(
        yield* journalOf(world, started.runId, "evidence/metrics.jsonl").pipe(Effect.orDie),
      ).toContain(`"kind":"verification"`);

      const failing = yield* collie(world, [
        "verify",
        "--run",
        started.runId,
        "--",
        "sh",
        "-c",
        "echo the reason it failed; exit 3",
      ]);
      expect(failing.exit).toBe(3);
      expect(failing.stderr).toContain("the reason it failed");
      expect(failing.envelope.ok).toBe(true);

      const announced = yield* collie(world, [
        "verify",
        "--run",
        started.runId,
        "--name",
        "pid-of",
        "--",
        "sh",
        "-c",
        "echo $$",
      ]);
      const printed = Str.trim(
        (yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            verification: Schema.Struct({ tail: Schema.Struct({ stdout: Schema.String }) }),
          }),
        )(announced.envelope.data).pipe(Effect.orDie)).verification.tail.stdout,
      );
      expect(printed).toMatch(/^\d+$/);
      const line = `"pid-of" started, pid ${printed}`;
      expect(announced.stderr).toContain(line);
      expect(
        yield* fs.readFileString(`${world.state}/runs/${started.runId}/log.txt`).pipe(Effect.orDie),
      ).toContain(line);

      const nowhere = yield* collie(world, ["verify", "--run", "run-nobody", "--", "true"]);
      expect(nowhere.envelope.ok).toBe(false);
      expect(nowhere.envelope.error?.code).toBe("run_not_found");

      const outside = yield* collie(world, [
        "verify",
        "--run",
        started.runId,
        "--cwd",
        world.home,
        "--",
        "true",
      ]);
      expect(outside.envelope.ok).toBe(false);
      expect(outside.envelope.error?.message).toContain("is not inside run");
      yield* stopHost(world.state);
    }),
  ));

const checkedRun = (world: World, workflow: string, command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const started = yield* collie(world, [
      "run",
      "start",
      workflow,
      "--input",
      "note=x",
      "--verify",
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        name: "unit",
        executable: command[0],
        argv: command.slice(1),
        cwd: "worktree",
      }).pipe(Effect.orDie),
    ]);
    expect(started.envelope.ok).toBe(true);
    const runId = (yield* payloadOf(started.envelope)).runId ?? "";
    yield* collie(world, ["run", "wait", runId]);
    return runId;
  });

const counted = (world: World) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const counter = `${world.home}/ran`;
    return {
      counter,
      runs: fs.readFileString(counter).pipe(
        Effect.map((text) => Str.split(text, "\n").length - 1),
        Effect.orElseSucceed(() => 0),
      ),
    };
  });

const journalOf = (world: World, runId: string, journal: string) =>
  hostRecords(
    world.state,
    RunRecords.use((records) => records.lines(runId, journal)),
  ).pipe(Effect.map((lines) => Arr.join(lines, "\n")));

const recordsOf = (world: World, runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = `${world.state}/evidence/${runId}`;
    return {
      journal: yield* journalOf(world, runId, "evidence/steering/verifications.jsonl").pipe(
        Effect.orElseSucceed(() => ""),
      ),
      logs: yield* fs.readDirectory(`${evidence}/verify`).pipe(Effect.orElseSucceed(() => [])),
    };
  });

const Answer = Schema.Struct({
  ran: Schema.Boolean,
  verification: Schema.Struct({
    id: Schema.String,
    result: Schema.String,
    exit: Schema.Finite,
    by: Schema.String,
    pass: Schema.optional(Schema.String),
  }),
});

test("collie verify of one of a Run's Checks that already passed on this tree answers without running it", () =>
  provesWith(
    "collie-lifecycle-verify-once-",
    (world) =>
      Effect.gen(function* () {
        const { counter, runs } = yield* counted(world);
        const command = ["sh", "-c", `echo ran >> ${counter}`];
        const runId = yield* checkedRun(world, "checked", command);
        expect(yield* runs).toBe(1);
        const verify = (...args: ReadonlyArray<string>) =>
          collie(world, ["verify", "--run", runId, ...args]);

        const again = yield* verify("--", ...command);
        expect(again.exit).toBe(0);
        expect(yield* runs).toBe(1);
        const answer = yield* Schema.decodeUnknownEffect(Answer)(again.envelope.data).pipe(
          Effect.orDie,
        );
        expect(answer).toMatchObject({
          ran: false,
          verification: { result: "pass", pass: "gate" },
        });
        expect(again.stderr).toContain(`not run again: verification ${answer.verification.id}`);

        const expecting = yield* verify("--expect", "fail", "--", ...command);
        expect(expecting.envelope.data).toMatchObject({
          ran: false,
          verification: answer.verification,
        });
        expect(yield* runs).toBe(1);
        yield* stopHost(world.state);
      }),
    ["checked.workflow.ts"],
  ));

test("collie verify of a command already recorded on this tree answers with that record unless --again", () =>
  provesWith(
    "collie-lifecycle-verify-recorded-",
    (world) =>
      Effect.gen(function* () {
        const { counter, runs } = yield* counted(world);
        const runId = yield* checkedRun(world, "checked", ["true"]);
        const verify = (...args: ReadonlyArray<string>) =>
          collie(world, ["verify", "--run", runId, ...args]);
        const answerOf = (envelope: { readonly data?: unknown }) =>
          Schema.decodeUnknownEffect(Answer)(envelope.data).pipe(Effect.orDie);
        const command = ["sh", "-c", `echo ran >> ${counter}; true`];

        const first = yield* answerOf((yield* verify("--", ...command)).envelope);
        expect(first).toMatchObject({ ran: true, verification: { by: "agent" } });
        expect(yield* runs).toBe(1);

        const repeated = yield* verify("--", ...command);
        expect(repeated.exit).toBe(0);
        expect(yield* answerOf(repeated.envelope)).toMatchObject({
          ran: false,
          verification: { id: first.verification.id },
        });
        expect(repeated.stderr).toContain(`not run again: verification ${first.verification.id}`);
        expect(yield* runs).toBe(1);

        const forced = yield* answerOf((yield* verify("--again", "--", ...command)).envelope);
        expect(forced.ran).toBe(true);
        expect(forced.verification.id).not.toBe(first.verification.id);
        expect(yield* runs).toBe(2);

        yield* verify("--name", "renamed", "--", ...command);
        expect(yield* runs).toBe(3);

        const failing = ["sh", "-c", `echo ran >> ${counter}; exit 3`];
        yield* verify("--", ...failing);
        const failed = yield* verify("--", ...failing);
        expect(failed.exit).toBe(3);
        expect(yield* answerOf(failed.envelope)).toMatchObject({
          ran: false,
          verification: { result: "fail", exit: 3 },
        });
        expect(yield* runs).toBe(4);

        yield* verify("--expect", "fail", "--", ...command);
        expect(yield* runs).toBe(5);
        yield* stopHost(world.state);
      }),
    ["checked.workflow.ts"],
  ));

test("collie verify of a Run's Check that failed on this tree answers with that failure and runs nothing", () =>
  provesWith(
    "collie-lifecycle-verify-failed-",
    (world) =>
      Effect.gen(function* () {
        const { counter, runs } = yield* counted(world);
        const command = ["sh", "-c", `echo ran >> ${counter}; exit 3`];
        const runId = yield* checkedRun(world, "checked", command);
        expect(yield* runs).toBe(1);
        const before = yield* recordsOf(world, runId);

        for (const expecting of [[], ["--expect", "fail"]]) {
          const answered = yield* collie(world, [
            "verify",
            "--run",
            runId,
            ...expecting,
            "--",
            ...command,
          ]);
          expect(answered.exit).toBe(3);
          expect(answered.envelope.data).toMatchObject({
            ran: false,
            verification: { result: "fail", exit: 3, pass: "gate" },
          });
          expect(answered.stderr).not.toContain("already passed");
        }
        expect(yield* runs).toBe(1);
        expect(yield* recordsOf(world, runId)).toEqual(before);
        yield* stopHost(world.state);
      }),
    ["checked.workflow.ts"],
  ));

test("collie verify of a Run's Check with no record on this tree is refused, naming the gate", () =>
  provesWith(
    "collie-lifecycle-verify-gate-",
    (world) =>
      Effect.gen(function* () {
        const { counter, runs } = yield* counted(world);
        const command = ["sh", "-c", `echo ran >> ${counter}`];
        const runId = yield* checkedRun(world, "proved", command);

        for (const expecting of [[], ["--expect", "fail"]]) {
          const refused = yield* collie(world, [
            "verify",
            "--run",
            runId,
            ...expecting,
            "--",
            ...command,
          ]);
          expect(refused.envelope.ok).toBe(false);
          expect(refused.envelope.error?.code).toBe("invalid_state");
          expect(refused.envelope.error?.message).toContain("gate");
        }
        expect(yield* runs).toBe(0);
        expect(yield* recordsOf(world, runId)).toEqual({ journal: "", logs: [] });
        yield* stopHost(world.state);
      }),
    ["proved.workflow.ts"],
  ));

const mrUrl = (repo: string, iid: number) =>
  `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/${iid}`;

test("a Disposition of one merge request of several is kept by the Run that owns it, and one outside the Task is refused", () =>
  provesWith(
    "collie-lifecycle-dispose-",
    (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const fan = yield* client
          .start({
            project: world.project,
            id: "fans-out",
            request: "req-fan",
            input: { mrs: `${mrUrl("api", 3)} ${mrUrl("web", 8)}` },
            task: "task-1",
          })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId: fan.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        const web = Option.getOrThrow(
          Arr.findFirst(
            yield* client.runs({ task: "task-1" }).pipe(Effect.orDie),
            (one) => one.mr === mrUrl("web", 8),
          ),
        );

        const line = yield* client
          .dispose({
            runId: fan.runId,
            kind: "abandoned",
            ref: "web!8",
            note: null,
            request: "d-1",
          })
          .pipe(Effect.orDie);
        expect(line).toMatchObject({ kind: "abandoned", ref: "gitlab.cego.dk/cego/web!8" });
        expect(
          yield* hostRecords(world.state, readDispositions(runDir(world.state, web.runId))).pipe(
            Effect.orDie,
          ),
        ).toMatchObject([{ kind: "abandoned", ref: "gitlab.cego.dk/cego/web!8" }]);
        expect(
          yield* hostRecords(world.state, readDispositions(runDir(world.state, fan.runId))).pipe(
            Effect.orDie,
          ),
        ).toEqual([]);

        const refused = yield* client
          .dispose({
            runId: fan.runId,
            kind: "merged",
            ref: mrUrl("cli", 9),
            note: null,
            request: "d-2",
          })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          reason: expect.stringMatching(/cego\/api!3.*cego\/web!8/),
        });
        yield* stopHost(world.state);
      }),
    ["fans-out.workflow.ts", "records-mr.workflow.ts"],
  ));

test("a host that was not reached is told apart from one that refused", () => {
  const dropped = new HostUnavailable({ dir: "/far", reason: "SocketCloseError: 1000" });
  const away = new MachineUnreachable({ machine: "far", seen: "no control link" });
  const refused = new HostRefused({ reason: "no Run run-1 here" });
  expect(refusal(dropped)).toMatchObject({ ok: false, unreached: true });
  expect(refusal(away)).toMatchObject({ ok: false, unreached: true });
  expect(refusal(refused)).not.toHaveProperty("unreached");
});
