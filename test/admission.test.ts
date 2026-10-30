// One request is one run, through the two windows where a host can die.
//
// A start is two things that cannot be one: a row that says this work was accepted, and an
// engine that has been told about it. Whichever order they are done in, a crash can land
// between them — so the proof is a host that really dies there, killed at a named point by
// the host itself, and a second host that has to end with one run either way.
//
// Real processes and a real database, because a gap between two writes is not something a
// map can have.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { connect } from "../src/host";
import { runEffect } from "./support/effect";
import { events, fixtures, openHost, runDirOf, until, workspace, type Host } from "./support/host";

const suspended = (reply: { readonly status?: string }) => reply.status === "suspended";
const complete = (reply: { readonly status?: string }) => reply.status === "complete";

/** How many times the run's one launch Activity actually ran. */
const launches = (log: ReadonlyArray<string>) =>
  Arr.filter(log, (line) => pipe_(line, Str.startsWith("launch"))).length;

const started = (host: Host, runId: string, note: string) =>
  host.ask({ op: "start", id: "proof", runId, input: { note } });

test(
  "a host that dies with the run recorded and the engine not told hands it over when it starts again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-gap-");
        const dying = yield* openHost(state, { crashAt: "admitted" });
        yield* dying.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        // No reply is coming: the host kills itself between the row and the engine.
        yield* dying.tell({ op: "start", id: "proof", runId: "r1", input: { note: "gap" } });
        yield* dying.child.exitCode.pipe(Effect.ignore);
        expect(yield* events(state, "r1")).toEqual([]);

        // The next host finds work it never accepted and hands it over.
        const next = yield* openHost(state);
        yield* next.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        yield* next.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "on",
        });
        expect((yield* next.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:gap=on",
        );
        expect(launches(yield* events(state, "r1"))).toBe(1);
        yield* next.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a host that dies after the engine has the work and before the receipt does not start it twice",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-receipt-");
        const dying = yield* openHost(state, { crashAt: "executed" });
        yield* dying.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* dying.tell({ op: "start", id: "proof", runId: "r1", input: { note: "receipt" } });
        yield* dying.child.exitCode.pipe(Effect.ignore);

        // The row still says nobody has accepted it, so the next host offers it again —
        // under the identity it was admitted with, which is what makes that a no-op.
        const next = yield* openHost(state);
        yield* next.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        yield* next.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "once",
        });
        expect((yield* next.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:receipt=once",
        );
        expect(launches(yield* events(state, "r1"))).toBe(1);
        yield* next.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "an answer a host recorded and died before handing over reaches the run, and its retry is that answer",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-answer-");
        const dying = yield* openHost(state, { crashAt: "answered" });
        yield* dying.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* started(dying, "r1", "told");
        yield* dying.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        const answer = {
          op: "answer" as const,
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "on",
          request: "ans-1",
        };
        yield* dying.tell(answer);
        yield* dying.child.exitCode.pipe(Effect.ignore);

        const next = yield* openHost(state);
        expect((yield* next.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:told=on",
        );
        const retried = yield* next.ask(answer);
        expect(retried.ok).toBe(true);
        const changed = yield* next.ask({ ...answer, value: "off" });
        expect(changed.ok).toBe(false);
        yield* next.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "the same request twice is one run, and the same request with other arguments is refused",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-retry-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });

        const first = yield* started(host, "r1", "once");
        const retry = yield* started(host, "r1", "once");
        expect([first.ok, retry.ok]).toEqual([true, true]);
        expect(retry.registration).toBe(first.registration);
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        // Twice asked, once started: the second claim found the first one's run.
        expect(launches(yield* events(state, "r1"))).toBe(1);

        // The same claim for something else is not that claim.
        const changed = yield* started(host, "r1", "something else");
        expect(changed.ok).toBe(false);
        expect(changed.detail).toContain("r1");

        // What it claimed is untouched by the refusal.
        yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "x",
        });
        expect((yield* host.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:once=x",
        );
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "two requests with the same arguments are two runs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-separate-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });

        // Identical in every way but the claim, which is what says they are two.
        for (const runId of ["r1", "r2"]) {
          const reply = yield* started(host, runId, "same");
          expect(reply.ok).toBe(true);
        }
        for (const runId of ["r1", "r2"]) {
          yield* host.until({ op: "poll", id: "proof", runId }, suspended);
          expect(launches(yield* events(state, runId))).toBe(1);
        }
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a subscriber and a reader see the same committed rows",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-admission-committed-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* started(host, "r1", "committed");
        yield* host.until({ op: "poll", id: "proof", runId: "r1" }, suspended);
        yield* host.stop;

        // Nothing of this was in memory: the next host answers from what was committed.
        const next = yield* openHost(state);
        expect((yield* next.ask({ op: "poll", id: "proof", runId: "r1" })).status).toBe(
          "suspended",
        );
        yield* until(
          () => next.ask({ op: "registrations" }),
          (reply) => (reply.registrations ?? []).includes("proof@1"),
        );
        yield* next.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

for (const { target, stopped } of [
  { target: true, stopped: false },
  { target: false, stopped: false },
  { target: true, stopped: true },
]) {
  test(
    stopped
      ? "resume clears a stop over a restored admission and takes up the work beyond it"
      : target
        ? "resume takes up its interrupted admission after its module is restored"
        : "recovering another admission cannot make a finished Run's resume applied",
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { wf, state } = yield* workspace("collie-admission-resume-");
          const first = yield* openHost(state);
          yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
          yield* first.ask({ op: "load", entry: `${wf}/plain.workflow.ts` });
          yield* first.ask({
            op: "start",
            id: "plain",
            runId: "done",
            input: { note: "finished" },
          });
          yield* first.until({ op: "poll", id: "plain", runId: "done" }, complete);
          yield* first.stop;
          const crashing = yield* openHost(state, { crashAt: "admitted" });
          yield* crashing.tell({
            op: "start",
            id: "proof",
            runId: "unfinished",
            input: { note: "gap" },
          });
          yield* crashing.child.exitCode.pipe(Effect.ignore);
          yield* fs.remove(`${wf}/proof.workflow.ts`).pipe(Effect.orDie);
          const next = yield* openHost(state);
          const client = yield* connect(state).pipe(Effect.orDie);
          const rows = yield* client.runs({ task: null }).pipe(Effect.orDie);
          const pending = Option.getOrUndefined(
            Arr.findFirst(rows, (one) => one.workflow === "proof"),
          )!;
          const done = Option.getOrUndefined(
            Arr.findFirst(rows, (one) => one.workflow === "plain"),
          )!;
          const missing = yield* client
            .resume({ runId: pending.runId, request: "missing" })
            .pipe(Effect.orDie);
          expect(missing.applied).toBe(false);
          expect(missing.detail).toContain("proof.workflow.ts");
          if (stopped) {
            const recorded = yield* client
              .control({
                runId: pending.runId,
                control: "stop",
                set: true,
                request: "stop-missing",
              })
              .pipe(Effect.orDie);
            expect(recorded.applied).toBe(false);
          }
          yield* fs
            .copyFile(`${fixtures}/proof.workflow.ts`, `${wf}/proof.workflow.ts`)
            .pipe(Effect.orDie);
          const resumed = yield* client
            .resume({ runId: target ? pending.runId : done.runId, request: "restored" })
            .pipe(Effect.orDie);
          expect(resumed.applied).toBe(target);
          if (!target) {
            expect(resumed.detail).toContain("finished");
            const untouched = yield* client.run({ runId: pending.runId }).pipe(Effect.orDie);
            expect(untouched?.waiting.some((one) => one.name === "decision")).toBe(false);
            expect(launches(yield* events(state, pending.runId))).toBe(0);
            const taken = yield* client
              .resume({ runId: pending.runId, request: "taken" })
              .pipe(Effect.orDie);
            expect(taken.applied).toBe(true);
          }
          yield* until(
            () => client.run({ runId: pending.runId }).pipe(Effect.orDie),
            (one) => one?.status.status === "suspended",
          );
          const current = yield* client.run({ runId: pending.runId }).pipe(Effect.orDie);
          expect(current?.controls).not.toContain("stop");
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(current), (present) =>
                Arr.some(present.waiting, (one) => one.name === "decision" && one.answer === null),
              ),
            ),
          ).toBe(true);
          expect(launches(yield* events(state, pending.runId))).toBe(1);
          yield* next.stop;
        }).pipe(Effect.scoped),
      ),
    180_000,
  );
}

/**
 * Runs left mid-work on held-wake by a host that died, and a host that started without the
 * module, which is then put back. Each of `unaccepted` reached the engine and not the row.
 */
const stranded = (
  prefix: string,
  accepted: ReadonlyArray<string>,
  unaccepted: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { dir, wf, state } = yield* workspace(prefix);
    const module = `${wf}/held-wake.workflow.ts`;
    yield* fs.copyFile(`${fixtures}/held-wake.workflow.ts`, module).pipe(Effect.orDie);
    const gate = `${dir}/gate`;
    yield* fs.writeFileString(gate, "").pipe(Effect.orDie);
    const first = yield* openHost(state);
    for (const runId of accepted) {
      yield* first.ask({ op: "start", id: "held-wake", runId, input: { gate } });
      yield* until(
        () => events(state, runId),
        (log) => log.includes("held"),
      );
    }
    yield* first.child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
    yield* first.child.exitCode.pipe(Effect.ignore);
    for (const runId of unaccepted) {
      const dying = yield* openHost(state, { crashAt: "executed" });
      yield* dying.tell({ op: "start", id: "held-wake", runId, input: { gate } });
      yield* dying.child.exitCode.pipe(Effect.ignore);
    }
    yield* fs.remove(module).pipe(Effect.orDie);
    yield* fs.remove(gate).pipe(Effect.orDie);
    const host = yield* openHost(state);
    yield* fs.copyFile(`${fixtures}/held-wake.workflow.ts`, module).pipe(Effect.orDie);
    // Names the Runs their dying host never answered for.
    for (const runId of unaccepted) yield* host.ask({ op: "poll", id: "held-wake", runId });
    const client = yield* connect(state).pipe(Effect.orDie);
    const idOf = (name: string) =>
      runDirOf(state, name).pipe(Effect.map((trail) => trail.slice(trail.lastIndexOf("/") + 1)));
    const waiting = (name: string) =>
      until(
        () => events(state, name),
        (log) => log.at(-1) === "wait",
      );
    return { state, gate, host, client, idOf, waiting };
  });

test(
  "a resume that registers a restored module leaves another Run on it alone until it is recovered",
  () =>
    runEffect(
      Effect.gen(function* () {
        const others = ["other", "unaccepted"];
        const { state, host, client, idOf, waiting } = yield* stranded(
          "collie-admission-shared-",
          ["target", "other"],
          ["unaccepted"],
        );
        const seen = (name: string) =>
          Effect.gen(function* () {
            const view = yield* client.run({ runId: yield* idOf(name) }).pipe(Effect.orDie);
            return { log: yield* events(state, name), parked: view?.parked ?? null };
          });
        const before = yield* Effect.forEach(others, seen);
        const resumed = yield* client
          .resume({ runId: yield* idOf("target"), request: "resume-target" })
          .pipe(Effect.orDie);
        expect(resumed.applied).toBe(true);
        yield* waiting("target");
        expect(yield* Effect.forEach(others, seen)).toEqual(before);
        const taken = yield* client
          .resume({ runId: yield* idOf("unaccepted"), request: "resume-unaccepted" })
          .pipe(Effect.orDie);
        expect(taken.applied).toBe(true);
        yield* waiting("unaccepted");
        yield* client.recover().pipe(Effect.orDie);
        yield* waiting("other");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "resumes of two Runs on one restored module at once each take their Run up",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { host, client, idOf, waiting } = yield* stranded(
          "collie-admission-together-",
          ["one", "two"],
          [],
        );
        const replies = yield* Effect.forEach(
          ["one", "two"],
          (name) =>
            Effect.flatMap(idOf(name), (runId) =>
              client.resume({ runId, request: `resume-${name}` }).pipe(Effect.orDie),
            ),
          { concurrency: "unbounded" },
        );
        expect(replies.map((reply) => reply.applied)).toEqual([true, true]);
        yield* waiting("one");
        yield* waiting("two");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a resume of a Run another resume held at its start returns once that Run has asked",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { gate, host, client, idOf, waiting } = yield* stranded(
          "collie-admission-released-",
          ["first", "held"],
          [],
        );
        yield* client.resume({ runId: yield* idOf("first"), request: "resume-first" });
        yield* waiting("first");
        // Shut while the resume is asked, so it has to wait for the Run to go on to its question.
        yield* fs.writeFileString(gate, "").pipe(Effect.orDie);
        yield* Effect.forkScoped(fs.remove(gate).pipe(Effect.orDie, Effect.delay("500 millis")));
        const runId = yield* idOf("held");
        const resumed = yield* client.resume({ runId, request: "resume-held" }).pipe(Effect.orDie);
        expect(resumed.applied).toBe(true);
        const view = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(view?.waiting.map((asked) => asked.name)).toEqual(["decision"]);
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);
