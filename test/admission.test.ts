// One request is one run, through the two windows where a host can die.
//
// A start is two things that cannot be one: a row that says this work was accepted, and an
// engine that has been told about it. Whichever order they are done in, a crash can land
// between them — so the proof is a host that really dies there, killed at a named point by
// the host itself, and a second host that has to end with one run either way.
//
// Real processes and a real database, because a gap between two writes is not something a
// map can have.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "./support/effect";
import { events, openHost, until, workspace, type Host } from "./support/native";

const suspended = (reply: { readonly status?: string }) => reply.status === "suspended";
const complete = (reply: { readonly status?: string }) => reply.status === "complete";

/** How many times the run's one launch Activity actually ran. */
const launches = (log: ReadonlyArray<string>) =>
  log.filter((line) => line.startsWith("launch")).length;

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
