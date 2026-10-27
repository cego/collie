// What holds one Run up, read for that Run alone.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { BoardAgent } from "../src/board-model";
import type { ProposalLine } from "../src/proposals";
import { runWaits } from "../src/run-waits";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { runFacts } from "./support/records";

const now = epochMs("2026-09-14T10:30:00Z");

const proposal = (id: string, run: string, expires_at = "2026-09-14T11:00:00Z"): ProposalLine => ({
  kind: "proposal",
  id,
  created_at: "2026-09-14T10:00:00Z",
  expires_at,
  interpretation: "the run drifted",
  targets: [{ run }],
  actions: [{ kind: "stop", run }],
  allowed_now: [],
  intent_versions: {},
  content_hash: "abc",
  by: "evaluator:call-1",
  state: "pending",
});

test("a memory wait belongs only to the Run whose directory records it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-waits-" });
      const a = runFacts({ id: "a", dir: `${root}/a` });
      const b = runFacts({ id: "b", dir: `${root}/b` });
      yield* fs.makeDirectory(`${a.dir}/memory-waits`, { recursive: true });
      yield* fs.makeDirectory(b.dir);
      yield* fs.writeFileString(
        `${a.dir}/memory-waits/0-1.json`,
        Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
          what: "build's agent",
          sentence: "waiting for memory on vm-mk: 2.0 of 100.0 GB available",
          since: 0,
          read: 0,
          every: 15_000,
          asker: "a-build",
        }),
      );

      const waiting = yield* runWaits(a, [], [], now);
      const free = yield* runWaits(b, [], [], now);

      expect(waiting.memory).toEqual({
        what: "build's agent",
        sentence: "waiting for memory on vm-mk: 2.0 of 100.0 GB available",
        since: 0,
        read: 0,
        every: 15_000,
        asker: "a-build",
      });
      expect(free.memory).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("each Run's blocked agent is its own, never another Run's", () =>
  runEffect(
    Effect.gen(function* () {
      const agents: BoardAgent[] = [
        { name: "a-build", status: "working", now: null, run: "a" },
        { name: "b-review", status: "blocked", now: null, run: "b" },
        { name: "a-fix", status: "blocked", now: null, run: "a" },
      ];
      const a = yield* runWaits(runFacts({ id: "a", dir: "/nowhere/a" }), [], agents, now);
      const b = yield* runWaits(runFacts({ id: "b", dir: "/nowhere/b" }), [], agents, now);
      const c = yield* runWaits(runFacts({ id: "c", dir: "/nowhere/c" }), [], agents, now);

      expect(a.blocked?.name).toBe("a-fix");
      expect(b.blocked?.name).toBe("b-review");
      expect(c.blocked).toBeNull();
    }),
  ));

test("a hold stands while its Run goes on, and holds nothing once it has ended", () =>
  runEffect(
    Effect.gen(function* () {
      const held = (state: "running" | "succeeded" | "failed" | "stopped") =>
        runWaits(runFacts({ dir: "/nowhere/r1", held: true, state }), [], [], now).pipe(
          Effect.map((waits) => waits.held),
        );

      expect(yield* held("running")).toBe(true);
      expect(yield* held("succeeded")).toBe(false);
      expect(yield* held("failed")).toBe(false);
      expect(yield* held("stopped")).toBe(false);
    }),
  ));

test("a Run waiting with no question open is parked, and one with a question is asking", () =>
  runEffect(
    Effect.gen(function* () {
      const reason = "the pane would not take the prompt";
      const parked = yield* runWaits(
        runFacts({ dir: "/nowhere/r1", state: "waiting", parked: reason }),
        [],
        [],
        now,
      );
      const asking = yield* runWaits(
        runFacts({
          dir: "/nowhere/r1",
          workflow: "plan",
          state: "waiting",
          parked: reason,
          asking: [{ name: "scope", prompt: "Which repo?", options: ["api", "web"] }],
        }),
        [],
        [],
        now,
      );

      expect(parked.parked).toEqual({ reason });
      expect(parked.questions).toEqual([]);
      expect(asking.parked).toBeNull();
      expect(asking.questions).toEqual([
        {
          kind: "question",
          run: "r1",
          id: "scope",
          step: "plan",
          topic: "scope",
          text: "Which repo?",
          options: [
            { id: "api", title: "api", subtitle: null },
            { id: "web", title: "web", subtitle: null },
          ],
        },
      ]);
    }),
  ));

test("a Run waiting with no question and no reason recorded is still parked", () =>
  runEffect(
    Effect.gen(function* () {
      const waits = yield* runWaits(
        runFacts({ dir: "/nowhere/r1", state: "waiting", parked: null }),
        [],
        [],
        now,
      );

      expect(waits.parked).toEqual({ reason: null });
    }),
  ));

test("only a proposal on this Run that is unanswered and unexpired is pending on it", () =>
  runEffect(
    Effect.gen(function* () {
      const lines: ProposalLine[] = [
        proposal("p-mine", "r1"),
        proposal("p-other", "r2"),
        proposal("p-answered", "r1"),
        { kind: "declined", id: "p-answered", at: "2026-09-14T10:10:00Z", by: "human" },
        proposal("p-expired", "r1", "2026-09-14T10:20:00Z"),
      ];

      const waits = yield* runWaits(runFacts({ dir: "/nowhere/r1" }), lines, [], now);

      expect(waits.proposals.map((one) => one.id)).toEqual(["p-mine"]);
    }),
  ));
