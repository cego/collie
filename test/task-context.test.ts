import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  adoptPlan,
  activityOf,
  appendEvent,
  briefingFor,
  contextOf,
  editSpec,
  pinRun,
  pinOf,
  postTo,
  resolvePost,
} from "../src/task-context";
import { doneIn, objectiveIn } from "../src/task-spec";
import { newQueuedTask, readTask, writeTask } from "../src/task";
import { recordsAt } from "./support/records";
import { runEffect } from "./support/effect";
import { FIRST_SPEC, SECOND_RATIONALE, SECOND_SPEC } from "./task-context.fixture";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({ prefix: "hw-context-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const plantPlan = (dir: string, spec: string, tickets: ReadonlyArray<[string, string]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${dir}/issues`, { recursive: true });
    yield* fs.writeFileString(`${dir}/SPEC.md`, spec);
    for (const [name, text] of tickets) {
      yield* fs.writeFileString(`${dir}/issues/${name}`, text);
    }
  });

const ticket = (title: string, blocked: string, criterion: string) =>
  `# ${title}\n\n**Blocked by:** ${blocked}\n**Repo:** .\n\n## Acceptance criteria\n\n- [ ] ${criterion}\n`;

const queued = () =>
  Effect.gen(function* () {
    const made = yield* newQueuedTask({ instruction: "Refund duplicate charges", cwd: "/project" });
    yield* writeTask(made);
    return made.id;
  });

test("an adopted plan is the Task's own immutable copy, and the Run's later files change none of it", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      const dir = `${stateDir}/runs/r1/plan`;
      yield* plantPlan(dir, FIRST_SPEC, [
        ["01-refund-once.md", ticket("Refund a duplicate request", "none", "Refunds once.")],
        ["02-history.md", ticket("Show the refund", "01", "The history lists one refund.")],
      ]);
      const adopted = yield* adoptPlan({
        task,
        run: "r1",
        machine: "mk-laptop",
        plan: dir,
        actor: "human",
      });
      expect(adopted.revision).toBe(1);
      const kept = yield* contextOf(task);
      expect(kept.current?.revision).toBe(1);
      expect(Arr.map(kept.current?.tickets ?? [], (one) => one.id)).toEqual(["1", "2"]);
      expect(kept.current?.tickets[1]?.blockedBy).toEqual(["1"]);
      expect(objectiveIn(kept.current?.text ?? "")).toBe(
        "Refund a duplicate charge once per order.",
      );

      yield* plantPlan(dir, SECOND_SPEC, [
        ["01-refund-once.md", ticket("Rewritten later", "none", "Something else entirely.")],
      ]);
      const again = yield* contextOf(task);
      expect(Arr.map(again.current?.tickets ?? [], (one) => one.id)).toEqual(["1", "2"]);
      expect(again.current?.tickets[0]?.criteria).toEqual(["Refunds once."]);
      expect(again.current?.source?.plan).toBe(dir);
      expect(again.current?.source?.run).toBe("r1");
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("an amendment lands on the revision its editor saw, and a stale one is refused with the current revision", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      yield* editSpec({ task, text: FIRST_SPEC, actor: "human", expected: 0 });
      const accepted = yield* editSpec({
        task,
        text: SECOND_SPEC,
        actor: "human",
        expected: 1,
        rationale: SECOND_RATIONALE,
      });
      expect(accepted.applied).toBe(true);
      expect(accepted.current.revision).toBe(2);
      expect(accepted.current.rationale).toBe(SECOND_RATIONALE);
      expect(Arr.map(accepted.current.tickets, (one) => one.id)).toEqual(["1", "2", "3"]);

      const stale = yield* editSpec({
        task,
        text: `${FIRST_SPEC}\n## Notes\n\nA draft nobody kept.\n`,
        actor: "agent",
        expected: 1,
        rationale: "A draft",
      });
      expect(stale.applied).toBe(false);
      expect(stale.refused).toBe("stale");
      expect(stale.current.revision).toBe(2);
      expect(stale.current.rationale).toBe(SECOND_RATIONALE);
      expect(Arr.map((yield* contextOf(task)).revisions, (one) => one.revision)).toEqual([1, 2]);
      const one = yield* contextOf(task);
      expect(one.at(1)?.text).toBe(FIRST_SPEC);
      expect(Arr.map(one.at(1)?.tickets ?? [], (entry) => entry.id)).toEqual(["1", "2"]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the current revision's Objective and Done when are what the Task shows after an amendment", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      yield* editSpec({ task, text: FIRST_SPEC, actor: "human", expected: 0 });
      expect(doneIn((yield* contextOf(task)).current?.text ?? "")).toBe(
        "A repeated refund request leaves the order refunded once.",
      );
      yield* editSpec({ task, text: SECOND_SPEC, actor: "human", expected: 1 });
      const now = yield* contextOf(task);
      expect(doneIn(now.current?.text ?? "")).toBe(
        "Two simultaneous refund requests leave the order refunded once.",
      );
      expect((yield* readTask(task))?.instruction).toBe("Refund duplicate charges");
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a comment posted before the first Run keeps its author, and a second host reads it again", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      const posted = yield* postTo({
        task,
        by: "mk",
        kind: "comment",
        text: "Refund the duplicate, not the original.",
      });
      expect(posted.state).toBe("applied");
      const here = yield* activityOf(task);
      expect(Arr.map(here.posts, (one) => one.text)).toEqual([
        "Refund the duplicate, not the original.",
      ]);
      expect(here.posts[0]?.actor).toEqual({ by: "mk", kind: "human" });
      const reopened = yield* Effect.provide(activityOf(task), recordsAt(stateDir));
      expect(Arr.map(reopened.posts, (one) => one.id)).toEqual(
        Arr.map(here.posts, (one) => one.id),
      );
      expect((yield* readTask(task))?.queued_at).toBeDefined();
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a challenge and the resolution that settles it both stay, and the resolution names both", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      const decision = yield* postTo({
        task,
        by: "mk",
        kind: "decision",
        text: "Refunds are idempotent by order id.",
      });
      const challenge = yield* postTo({
        task,
        by: "builder",
        kind: "challenge",
        text: "An order id is not stable across retries.",
        source: { kind: "agent", run: "r1", agent: "builder" },
        about: [decision.id],
      });
      const resolution = yield* resolvePost({
        task,
        by: "mk",
        decision: decision.id,
        challenge: challenge.id,
        text: "Use the idempotency key the retry carries.",
      });
      expect(resolution.state).toBe("applied");
      const read = yield* activityOf(task);
      expect(read.decisions).toEqual([decision.id]);
      expect(read.unresolved).toEqual([]);
      const settled = Option.getOrUndefined(
        Arr.findLast(read.posts, (one) => one.id === resolution.id),
      );
      expect(settled?.about).toEqual([decision.id, challenge.id]);
      expect(Arr.map(read.posts, (one) => one.kind)).toEqual([
        "decision",
        "challenge",
        "resolution",
      ]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("one source fact lands once, however often a host offers it", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      const event = {
        task,
        kind: "run_started" as const,
        text: "Run r1 started",
        source: { kind: "run" as const, run: "r1" },
        id: "run:r1",
      };
      const first = yield* appendEvent(event);
      const second = yield* appendEvent({ ...event, text: "Run r1 started again" });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      const read = yield* activityOf(task);
      expect(read.posts).toHaveLength(1);
      expect(read.posts[0]?.text).toBe("Run r1 started");
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("older Activity is paged behind the newest, and stays in order", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      for (const text of ["one", "two", "three", "four", "five"]) {
        yield* postTo({ task, by: "mk", kind: "comment", text });
      }
      const newest = yield* activityOf(task, { limit: 2 });
      expect(Arr.map(newest.posts, (one) => one.text)).toEqual(["four", "five"]);
      expect(newest.older).toBe(3);
      const older = yield* activityOf(task, { limit: 2, before: newest.posts[0]?.seq });
      expect(Arr.map(older.posts, (one) => one.text)).toEqual(["two", "three"]);
      const oldest = yield* activityOf(task, { limit: 2, before: older.posts[0]?.seq });
      expect(Arr.map(oldest.posts, (one) => one.text)).toEqual(["one"]);
      expect(oldest.older).toBe(0);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a Run keeps the revision and the hand-over it was admitted with after the spec moves on", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      yield* postTo({
        task,
        by: "mk",
        kind: "comment",
        text: "Refund the duplicate, not the original.",
      });
      yield* editSpec({ task, text: FIRST_SPEC, actor: "human", expected: 0 });
      const first = yield* pinRun({ task, run: "r1", at: "2026-09-01T00:00:00.000Z" });
      expect(first.revision).toBe(1);
      expect(first.briefing).toContain("Refund the duplicate, not the original.");
      expect(first.briefing).toContain("A repeated refund request leaves the order refunded once.");

      yield* editSpec({
        task,
        text: SECOND_SPEC,
        actor: "human",
        expected: 1,
        rationale: SECOND_RATIONALE,
      });
      const second = yield* pinRun({ task, run: "r2", at: "2026-09-02T00:00:00.000Z" });
      expect(second.revision).toBe(2);
      expect(second.revision).not.toBe(first.revision);
      const kept = yield* pinOf("r1");
      expect(kept?.revision).toBe(1);
      expect(kept?.briefing).toBe(first.briefing);
      expect(briefingFor(kept!)).toContain(
        "A repeated refund request leaves the order refunded once.",
      );
      const retried = yield* pinRun({ task, run: "r1", at: "2026-09-03T00:00:00.000Z" });
      expect(retried.revision).toBe(1);
      expect(retried.at).toBe(first.at);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a Task's hand-over names its goal, its decisions, its unanswered questions and its comments", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* queued();
      yield* editSpec({ task, text: SECOND_SPEC, actor: "human", expected: 0 });
      yield* postTo({ task, by: "mk", kind: "decision", text: "Refunds use the retry's key." });
      yield* postTo({ task, by: "mk", kind: "comment", text: "Keep the ledger row." });
      const briefing = (yield* pinRun({ task, run: "r1", at: "2026-09-01T00:00:00.000Z" }))
        .briefing;
      expect(briefing).toContain("Two simultaneous refund requests leave the order refunded once.");
      expect(briefing).toContain("Refunds use the retry's key.");
      expect(briefing).toContain("Keep the ledger row.");
      expect(briefing).toContain("03");
      expect(briefing).toContain("Two concurrent refund requests must settle once.");
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));
