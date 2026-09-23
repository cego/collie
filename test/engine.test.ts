// The go/no-go proof: a workflow written outside this checkout, run by Collie's own
// executable on Effect's workflow engine over real SQLite, surviving a real restart.
//
// Every host here is a subprocess and every database is a file, because the questions
// being asked — does a completed Activity come back, does a pending decision survive, does
// a missing module leave work recoverable — have no answer in an in-memory engine.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Schema, Scope } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import * as Workflow from "effect/unstable/workflow/Workflow";
import { engineLayer, TOOLCHAIN } from "../src/engine";
import { runEffect } from "./support/effect";
import { HostReply, events, fixtures, openHost, root, until, workspace } from "./support/host";

const stopsIn = (log: ReadonlyArray<string>) => log.filter((line) => line === "stopped").length;

const suspended = (reply: typeof HostReply.Type) => reply.status === "suspended";

/** The run has reached its question and the host knows it, so an answer has one to land on. */
const asking = (reply: typeof HostReply.Type) => (reply.diagnostics ?? []).includes("decision");
const complete = (reply: typeof HostReply.Type) => reply.status === "complete";

test(
  "a module outside the checkout runs on the binary and a restart reuses its completed work",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-restart-");
        const first = yield* openHost(state);
        const loaded = yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        expect(loaded.ok).toBe(true);
        expect(loaded.id).toBe("proof");
        // The public id, the registration and the run are three separate names.
        expect(loaded.registration).toBe("proof@1");

        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "first" } });
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
        const { wf, state } = yield* workspace("collie-engine-hold-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "r1", input: { note: "held" } });
        yield* host.until({ op: "waiting", runId: "r1" }, asking);
        yield* host.ask({ op: "hold", runId: "r1" });
        yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "go",
        });
        // Held once it has its answer: the boundary read is a plain Effect, so it saw the
        // flag an operator set while it waited rather than a value cached from the first
        // attempt.
        const paused = yield* until(
          () => events(state, "r1"),
          (log) => log.includes("held"),
        );
        expect(paused[0]).toMatch(/^launch note:held /);
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);

        yield* host.ask({ op: "release", id: "proof", runId: "r1" });
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
        const { wf, state } = yield* workspace("collie-engine-stop-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "r1", input: { note: "stopped" } });
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);

        for (const cycle of [1, 2]) {
          yield* host.ask({ op: "stop", id: "proof", runId: "r1" });
          yield* until(
            () => events(state, "r1"),
            (log) => stopsIn(log) === cycle,
          );
          // Asked until rather than once: the run logs that it is stopping before it has
          // finished suspending, so reading the engine on that line is reading it mid-attempt.
          yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
          yield* host.ask({ op: "resume", id: "proof", runId: "r1" });
        }

        yield* host.until({ op: "waiting", runId: "r1" }, asking);
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
        const { wf, state } = yield* workspace("collie-engine-missing-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "load", entry: `${wf}/plain.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "orphan" } });
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
        yield* second.ask({ op: "start", id: "plain", runId: "r2", input: { note: "fine" } });
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
        const { wf, state } = yield* workspace("collie-engine-generations-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "old", input: { note: "before" } });
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
        const started = yield* host.ask({
          op: "start",
          id: "proof",
          runId: "new",
          input: { note: "after" },
        });
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
        const one = yield* workspace("collie-engine-project-one-");
        const two = yield* workspace("collie-engine-project-two-");
        const hostOne = yield* openHost(one.state);
        const hostTwo = yield* openHost(two.state);
        yield* hostOne.ask({ op: "load", entry: `${one.wf}/proof.workflow.ts` });
        yield* hostTwo.ask({ op: "load", entry: `${two.wf}/plain.workflow.ts` });

        expect((yield* hostOne.ask({ op: "registrations" })).registrations).toEqual(["proof@1"]);
        expect((yield* hostTwo.ask({ op: "registrations" })).registrations).toEqual(["plain@1"]);

        // A run started in one project is not a run the other has.
        yield* hostOne.ask({ op: "start", id: "proof", runId: "shared", input: { note: "one" } });
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
        const { wf, state } = yield* workspace("collie-engine-toolchain-");
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
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-engine-duplicate-" });
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
        }).pipe(Effect.provide(engineLayer({ dir })), Effect.scoped, Effect.orDie);
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
        const { wf, state } = yield* workspace("collie-engine-deadline-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "patient" } });
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
        const { wf, state } = yield* workspace("collie-engine-crash-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "crashed" } });
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

test(
  "a typed module registers, runs on a service of its own and returns its typed result",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-echo-");
        const host = yield* openHost(state);
        const loaded = yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        expect(loaded.ok).toBe(true);

        // What the module declared about itself, as a card would read it: ids and titles
        // and the projection of the action's arguments, and none of the closures.
        const declared = yield* host.ask({ op: "metadata", id: "echo" });
        expect(declared.metadata).toMatchObject({
          hints: { text: "work-source" },
          selectable: ["feature", "docs"],
          followUps: [{ id: "echo-again", workflow: "echo", when: "succeeded" }],
          actions: [{ id: "echo-louder", title: "Echo it louder", workflow: "echo" }],
        });

        yield* host.ask({
          op: "start",
          id: "echo",
          runId: "e1",
          input: { text: "hi", times: 2 },
        });
        yield* host.until({ op: "poll", id: "echo", runId: "e1" }, suspended);
        yield* host.ask({ op: "answer", id: "echo", runId: "e1", decision: "keep", value: "yes" });
        const done = yield* host.until({ op: "poll", id: "echo", runId: "e1" }, complete);
        // `<hi>` is the module's own service; `#1 #2` is an ordinary Effect operator over
        // its own typed input. Collie supplied neither.
        expect(done.value).toBe("<hi>#1 <hi>#2|yes");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "an input the workflow's own schema rejects names the field, and starts nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-invalid-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        const refused = yield* host.ask({
          op: "start",
          id: "echo",
          runId: "e1",
          input: { text: "hi", times: "two" },
        });
        expect(refused.ok).toBe(false);
        expect(refused.detail).toContain("invalid_input");
        expect(refused.detail).toContain("times");

        // Settled before anything exists: there is no run to poll, not a failed one.
        const polled = yield* host.ask({ op: "poll", id: "echo", runId: "e1" });
        expect(polled.ok).toBe(false);
        expect(polled.detail).toContain('no run "e1" was started here');
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

const COUNTS = `
import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export const id = "counts";
export const title = "A workflow whose result is a structure";
export const description = "Counts what it was given.";
export const input = { items: Schema.Array(Schema.String) };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({
    name: registrationName,
    input,
    success: Schema.Struct({ count: Schema.Number, at: Schema.Date }),
  });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      return { count: payload.input.items.length, at: new Date(0) };
    }),
  );
  return { workflow, layer, decisions: {} };
};
`;

test(
  "a structured result reaches a client as its own schema encodes it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-result-");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${wf}/counts.workflow.ts`, COUNTS);
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/counts.workflow.ts` });
        yield* host.ask({ op: "start", id: "counts", runId: "c1", input: { items: ["a", "b"] } });
        const done = yield* host.until({ op: "poll", id: "counts", runId: "c1" }, complete);
        expect(done.value).toEqual({ count: 2, at: "1970-01-01T00:00:00.000Z" });
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a module that contradicts itself is refused at load, with every conflict named",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-conflicted-");
        const host = yield* openHost(state);
        const refused = yield* host.ask({ op: "load", entry: `${wf}/conflicted.workflow.ts` });
        expect(refused.ok).toBe(false);
        for (const conflict of [
          "is not an identity",
          'input "branch" collides with a host option',
          "both claim work-source",
          "either fixed or selectable",
          'no outcome called "vibes"',
          "is not an identity for an offer",
        ]) {
          expect(refused.detail).toContain(conflict);
        }
        // Nothing of it was registered, and the workflow beside it still loads.
        expect((yield* host.ask({ op: "registrations" })).registrations).toEqual([]);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        expect((yield* host.ask({ op: "registrations" })).registrations).toEqual(["echo@1"]);
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a service a module never provided is reported against the file that asks for it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-unwired-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/unwired.workflow.ts` });
        yield* host.ask({ op: "start", id: "unwired", runId: "u1", input: { text: "x" } });
        const failed = yield* host.until(
          { op: "poll", id: "unwired", runId: "u1" },
          (reply) => reply.status === "failed",
        );
        // Merging a Layer beside a workflow supplies it nothing, and the host can only
        // know that when the body asks — so it says which file to open.
        expect(failed.value).toContain("Service not found: unwired/Missing");
        expect(failed.id).toContain("unwired.workflow.ts");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "the example module typechecks against the declarations an author is given",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-engine-sdk-types-");
        const host = yield* openHost(state);
        expect((yield* host.ask({ op: "provision", dir: wf })).ok).toBe(true);
        for (const entry of [
          "echo.workflow.ts",
          "unwired.workflow.ts",
          "proof.workflow.ts",
          "agent.workflow.ts",
          "rally.workflow.ts",
          "reviewed.workflow.ts",
          "graded.workflow.ts",
          "roster.workflow.ts",
          "sweep.workflow.ts",
          "spread.workflow.ts",
          "share.workflow.ts",
          "offered.workflow.ts",
          // A fork of a shipped workflow, which is code an author writes the same way.
          "landing.workflow.ts",
          // The shipped five, held to the same declarations: a workflow Collie ships is
          // a module an author could have written, or the contract is two contracts.
          "plan.workflow.ts",
          "review.workflow.ts",
          "architecture.workflow.ts",
          "implement.workflow.ts",
          "renovate.workflow.ts",
        ]) {
          const checked = yield* host.ask({ op: "check", dir: wf, entry: `${wf}/${entry}` });
          expect([entry, checked.diagnostics]).toEqual([entry, []]);
        }
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  300_000,
);
