// Answering, holding and stopping one Run — and leaving everything else alone.
//
// These are the things an operator does to work that is already running, so none of them
// is asked of a map: every host here is a subprocess, every database is a file, and a
// restart is a second host over the first one's directory.
//
// What is being proved is narrow and specific. An answer settles the question a run is
// actually asking, once, whoever sends it and however often. A control reaches the run it
// names and no other, is still there after a restart, and is honest about whether it got
// anywhere. None of it is a file a client writes and something else consumes.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { HostReply } from "../src/native";
import { runEffect } from "./support/effect";
import { events, fixtures, openHost, until, workspace } from "./support/native";

const suspended = (reply: typeof HostReply.Type) => reply.status === "suspended";
const complete = (reply: typeof HostReply.Type) => reply.status === "complete";
const asking = (name: string) => (reply: typeof HostReply.Type) =>
  (reply.diagnostics ?? []).includes(name);

test(
  "one answer settles the question a run is asking, and the next one is refused",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-answer-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* host.ask({ op: "start", id: "proof", runId: "r1", input: { note: "once" } });
        yield* host.until({ op: "waiting", runId: "r1" }, asking("decision"));

        const first = yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "go",
          request: "req-1",
        });
        expect(first.ok).toBe(true);

        // A second answer is not a correction. The run has the first one and is acting on
        // it; changing it here would be changing work that has already started.
        const again = yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "stop instead",
          request: "req-2",
        });
        expect(again.ok).toBe(false);
        expect(again.detail).toContain("already answered");

        // The same claim again is the same answer, not a second one.
        const retried = yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "go",
          request: "req-1",
        });
        expect(retried.ok).toBe(true);

        const done = yield* host.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:once=go");
        // One launch, whatever the answers did: nothing here started the work again.
        expect(
          (yield* events(state, "r1")).filter((line) => line.startsWith("launch")),
        ).toHaveLength(1);
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a question a run has not asked, and an answer it does not take, are both refused",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-refuse-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        yield* host.ask({
          op: "start",
          id: "echo",
          runId: "e1",
          input: { text: "hi", times: 1 },
        });
        yield* host.until({ op: "waiting", runId: "e1" }, asking("keep"));

        const hidden = yield* host.ask({
          op: "answer",
          id: "echo",
          runId: "e1",
          decision: "discard",
          value: "yes",
        });
        expect(hidden.ok).toBe(false);
        expect(hidden.detail).toContain(`not waiting on a decision called "discard"`);

        // The question declares what it takes, so an answer outside that is refused
        // before the run is told anything.
        const invalid = yield* host.ask({
          op: "answer",
          id: "echo",
          runId: "e1",
          decision: "keep",
          value: "maybe",
        });
        expect(invalid.ok).toBe(false);
        expect(invalid.detail).toContain("yes, no");

        expect((yield* host.ask({ op: "poll", id: "echo", runId: "e1" })).status).toBe("suspended");

        yield* host.ask({ op: "answer", id: "echo", runId: "e1", decision: "keep", value: "yes" });
        const done = yield* host.until({ op: "poll", id: "echo", runId: "e1" }, complete);
        expect(done.value).toBe("<hi>#1|yes");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "an answer is taken in whatever case it was typed, as the option it names",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-case-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/echo.workflow.ts` });
        yield* host.ask({ op: "start", id: "echo", runId: "e1", input: { text: "hi", times: 1 } });
        yield* host.until({ op: "waiting", runId: "e1" }, asking("keep"));

        const shouted = yield* host.ask({
          op: "answer",
          id: "echo",
          runId: "e1",
          decision: "keep",
          value: "YES",
          request: "req-1",
        });
        expect(shouted).toMatchObject({ ok: true, value: "yes" });
        // The same answer in another case is the same answer, not a second one.
        const again = yield* host.ask({
          op: "answer",
          id: "echo",
          runId: "e1",
          decision: "keep",
          value: "Yes",
          request: "req-1",
        });
        expect(again).toMatchObject({ ok: true, value: "yes" });

        const done = yield* host.until({ op: "poll", id: "echo", runId: "e1" }, complete);
        expect(done.value).toBe("<hi>#1|yes");
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a caller that names no question is answered only where there is exactly one open",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-sole-");
        const host = yield* openHost(state);
        yield* host.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        const nothing = yield* host.ask({
          op: "start",
          id: "proof",
          runId: "r1",
          input: { note: "sole" },
        });
        expect(nothing.ok).toBe(true);
        // Before the run has asked anything there is nothing to land on, and nothing is
        // guessed at.
        const early = yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: null,
          value: "go",
        });
        expect(early.ok).toBe(false);
        expect(early.detail).toContain("is not waiting on a decision");

        yield* host.until({ op: "waiting", runId: "r1" }, asking("decision"));
        const answered = yield* host.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: null,
          value: "go",
        });
        expect(answered.ok).toBe(true);
        expect((yield* host.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:sole=go",
        );
        yield* host.stop;
      }).pipe(Effect.scoped),
    ),
  120_000,
);

test(
  "a pending question survives a restart, and the answer it gets there is still the only one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-restart-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "across" } });
        yield* first.until({ op: "waiting", runId: "r1" }, asking("decision"));
        yield* first.stop;

        const second = yield* openHost(state);
        // The question is still open in the host that came after, with what it takes.
        const open = yield* second.ask({ op: "waiting", runId: "r1" });
        expect(open.diagnostics).toEqual(["decision"]);

        yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "after",
          request: "req-after",
        });
        const done = yield* second.until({ op: "poll", id: "proof", runId: "r1" }, complete);
        expect(done.value).toBe("note:across=after");

        const late = yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "again",
          request: "req-late",
        });
        expect(late.ok).toBe(false);
        expect(late.detail).toContain("already answered");
        yield* second.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a hold holds the run it names and nothing beside it, and survives the host that set it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { wf, state } = yield* workspace("collie-control-sibling-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "load", entry: `${wf}/plain.workflow.ts` });
        yield* first.ask({ op: "hold", runId: "r1" });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "held" } });
        yield* first.until({ op: "poll", id: "proof", runId: "r1" }, suspended);

        // The sibling is a run of its own on the same engine and the same database, and
        // the hold is not about it.
        yield* first.ask({ op: "start", id: "plain", runId: "r2", input: { note: "free" } });
        expect((yield* first.until({ op: "poll", id: "plain", runId: "r2" }, complete)).value).toBe(
          "plain:free",
        );
        yield* first.stop;

        // A control an operator set is still set for the host that comes after: it is
        // durable state about the run, not something the process that took it remembers.
        const second = yield* openHost(state);
        yield* second.ask({ op: "start", id: "proof", runId: "r1", input: { note: "held" } });
        expect((yield* second.ask({ op: "poll", id: "proof", runId: "r1" })).status).toBe(
          "suspended",
        );
        expect(yield* events(state, "r1")).toEqual([
          expect.stringMatching(/^launch note:held /),
          "held",
        ]);

        yield* second.ask({ op: "release", id: "proof", runId: "r1" });
        yield* second.until({ op: "waiting", runId: "r1" }, asking("decision"));
        yield* second.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "on",
        });
        expect(
          (yield* second.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value,
        ).toBe("note:held=on");
        yield* second.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);

test(
  "a control over work no host is running is recorded and says so rather than confirming it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { wf, state } = yield* workspace("collie-control-missing-");
        const first = yield* openHost(state);
        yield* first.ask({ op: "load", entry: `${wf}/proof.workflow.ts` });
        yield* first.ask({ op: "start", id: "proof", runId: "r1", input: { note: "orphan" } });
        yield* first.until({ op: "waiting", runId: "r1" }, asking("decision"));
        yield* first.stop;

        yield* fs.remove(`${wf}/proof.workflow.ts`);
        const second = yield* openHost(state);
        const stopped = yield* second.ask({ op: "stop", id: "proof", runId: "r1" });
        // Recorded, because the intent is the operator's and it outlives the missing
        // file — and reported as not having reached the run, naming what to repair.
        expect(stopped.ok).toBe(true);
        expect(stopped.detail).toContain("proof.workflow.ts");
        yield* second.stop;

        // Put the module back, and the same control now reaches the run and says nothing.
        yield* fs.copyFile(`${fixtures}/proof.workflow.ts`, `${wf}/proof.workflow.ts`);
        const third = yield* openHost(state);
        const reached = yield* third.ask({ op: "stop", id: "proof", runId: "r1" });
        expect(reached).toMatchObject({ ok: true, detail: "" });
        yield* until(
          () => events(state, "r1"),
          (log) => log.includes("stopped"),
        );
        yield* third.ask({ op: "resume", id: "proof", runId: "r1" });
        yield* third.until({ op: "waiting", runId: "r1" }, asking("decision"));
        yield* third.ask({
          op: "answer",
          id: "proof",
          runId: "r1",
          decision: "decision",
          value: "back",
        });
        expect((yield* third.until({ op: "poll", id: "proof", runId: "r1" }, complete)).value).toBe(
          "note:orphan=back",
        );
        yield* third.stop;
      }).pipe(Effect.scoped),
    ),
  180_000,
);
