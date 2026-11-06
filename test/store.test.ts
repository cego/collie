// The rows Collie owns beside the executions Effect owns.
//
// Real SQLite in a real file, because the questions are about durability and atomicity:
// does a request claimed twice make one run, does a database that is closed and opened
// again still hold what was admitted, and does a subscriber hear about a committed change.
// None of those is answerable in a map.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { Deferred, Effect, Fiber, FileSystem, Layer, Order, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { RunModel, runModelLayer } from "../src/run-model";
import { Store, storeLayer } from "../src/store";
import { runEffect } from "./support/effect";

/** One store on one file. Opening it again is what a restart does. */
const opens = (file: string) =>
  storeLayer.pipe(
    Layer.provideMerge(
      SqliteClient.layer({ filename: file }).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
  );

const admission = (
  request: string,
  run: string,
  input: Record<string, string>,
  belongs?: { readonly task?: string; readonly parent?: string },
) => ({
  request,
  run,
  workflow: "proof",
  project: "/work/thing",
  input,
  provenance: Rec.fromEntries(Arr.map(Rec.keys(input), (name) => [name, "typed"] as const)),
  options: {},
  generation: "proof@1",
  execution: `execution-${run}`,
  task: belongs?.task ?? null,
  parent: belongs?.parent ?? null,
});

/** A database of its own, and the store on it, for the length of one question. */
const onStore = <A, E>(prefix: string, body: Effect.Effect<A, E, Store | SqlClient.SqlClient>) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      return yield* body.pipe(Effect.provide(opens(`${dir}/host.db`)));
    }).pipe(Effect.scoped),
  );

test("a request claims one run, and claiming it again is that same run", () =>
  onStore(
    "collie-store-claim-",
    Effect.gen(function* () {
      const store = yield* Store;
      const first = yield* store.admit(admission("req-1", "run-a", { note: "once" }));
      expect(first.fresh).toBe(true);
      expect(first.row.run).toBe("run-a");

      // The same request again, with the run id a retrying caller minted for itself.
      const again = yield* store.admit(admission("req-1", "run-b", { note: "once" }));
      expect(again.fresh).toBe(false);
      expect(again.row.run).toBe("run-a");
      expect(again.row.execution).toBe("execution-run-a");
      expect(Arr.map(yield* store.runs, (row) => row.run)).toEqual(["run-a"]);
    }),
  ));

test("claims of one request that arrive together settle on one run", () =>
  onStore(
    "collie-store-concurrent-",
    Effect.gen(function* () {
      const store = yield* Store;
      const claimed = yield* Effect.all(
        Arr.map(["a", "b", "c", "d"], (suffix) =>
          store.admit(admission("req-1", `run-${suffix}`, { note: "once" })),
        ),
        { concurrency: "unbounded" },
      );
      expect(new Set(Arr.map(claimed, (one) => one.row.run)).size).toBe(1);
      expect(Arr.filter(claimed, (one) => one.fresh)).toHaveLength(1);
      expect(yield* store.runs).toHaveLength(1);
    }),
  ));

test("a request reused with other arguments is refused, and what it claimed is untouched", () =>
  onStore(
    "collie-store-conflict-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "first" }));
      const refused = yield* store
        .admit(admission("req-1", "run-b", { note: "second" }))
        .pipe(Effect.flip);
      expect(refused._tag).toBe("RequestConflict");
      expect(refused.request).toBe("req-1");

      const held = yield* store.runs;
      expect(held).toHaveLength(1);
      expect(held[0]?.run).toBe("run-a");
      expect(held[0]?.input).toContain("first");
    }),
  ));

test("a request reused with other host options, another Task or another parent is refused", () =>
  onStore(
    "collie-store-arguments-",
    Effect.gen(function* () {
      const store = yield* Store;
      const first = {
        ...admission("req-1", "run-a", { note: "same" }),
        options: { branch: "one" },
      };
      yield* store.admit(first);
      for (const changed of [
        { ...first, options: { branch: "two" } },
        { ...first, task: "task-7" },
        { ...first, parent: "run-parent" },
      ]) {
        const refused = yield* store.admit({ ...changed, run: "run-b" }).pipe(Effect.flip);
        expect(refused._tag).toBe("RequestConflict");
      }
      // Placing a fresh Task is the host's doing, not an argument the retry changed.
      yield* store.place("run-a", { checkout: "{}", task: "task-new" });
      expect((yield* store.admit({ ...first, run: "run-b" })).fresh).toBe(false);
    }),
  ));

test("an answer under a request already used for another answer is refused", () =>
  onStore(
    "collie-store-answer-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "asks" }));
      yield* store.asking({ run: "run-a", decision: "go", prompt: "Go?", options: ["yes", "no"] });
      const answer = { run: "run-a", decision: "go", request: "ans-1" };
      expect((yield* store.settle({ ...answer, value: "no" }))._tag).toBe("accepted");
      expect((yield* store.settle({ ...answer, value: "no" }))._tag).toBe("repeat");
      const changed = yield* store.settle({ ...answer, value: "yes" });
      expect(changed._tag === "refused" && changed.reason).toContain('"no"');
      expect((yield* store.asked("run-a"))[0]?.answer).toBe("no");
    }),
  ));

const human = { origin: "desktop" as const, requestId: "steer-1" };
const agentOn = (run: string, agent: string) => ({
  origin: "agent" as const,
  requestId: `ans-${agent}`,
  from: { run, agent },
});

test("a supersede and an answer racing on one question: whichever lands first stands", () =>
  onStore(
    "collie-store-supersede-race-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "asks" }));
      const supersede = (decision: string) =>
        store.supersede({
          run: "run-a",
          decision,
          cause: "delivery-1",
          actor: human,
          agent: "planner",
        });
      const answer = (decision: string) =>
        store.settle({ run: "run-a", decision, value: "yes", request: `ans-${decision}` });

      yield* store.asking({ run: "run-a", decision: "q1", prompt: "Go?", options: ["yes"] });
      const [superseded, refused] = yield* Effect.all([supersede("q1"), answer("q1")], {
        concurrency: "unbounded",
      });
      expect(superseded._tag).toBe("accepted");
      expect(refused._tag === "refused" && refused.reason).toContain("superseded");
      expect(refused._tag === "refused" && refused.reason).toContain("delivery-1");
      const [q1] = yield* store.asked("run-a");
      expect(q1).toMatchObject({
        answer: null,
        cause: "delivery-1",
        messaged: [{ agent: "planner" }],
      });
      expect(q1?.superseded).not.toBeNull();
      expect(q1?.superseder).toEqual(human);

      yield* store.asking({ run: "run-a", decision: "q2", prompt: "Go?", options: ["yes"] });
      const [answered, late] = yield* Effect.all([answer("q2"), supersede("q2")], {
        concurrency: "unbounded",
      });
      expect(answered._tag).toBe("accepted");
      expect(late._tag === "refused" && late.reason).toContain('already answered "yes"');
      const q2 = (yield* store.asked("run-a"))[1];
      expect(q2).toMatchObject({ answer: "yes", superseded: null, cause: null, superseder: null });
    }),
  ));

test("a superseded workflow question takes an answer only from the agent the human messaged", () =>
  onStore(
    "collie-store-supersede-d8-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "asks" }));
      const question = { run: "run-a", prompt: "What next?", options: ["Implement now"] };
      const asks = (decision: string) => store.asking({ ...question, decision });
      const supersede = (decision: string) =>
        store.supersede({
          run: "run-a",
          decision,
          cause: "delivery-1",
          actor: human,
          agent: "planner",
        });
      const answer = (decision: string, by: ReturnType<typeof agentOn>) =>
        store.settle({
          run: "run-a",
          decision,
          value: "Implement now",
          request: `${by.requestId}-${decision}`,
          answerer: by,
        });

      yield* asks("next-1");
      yield* supersede("next-1");
      const reviewer = yield* answer("next-1", agentOn("run-a", "reviewer"));
      expect(reviewer._tag === "refused" && reviewer.reason).toContain("superseded");
      const elsewhere = yield* answer("next-1", agentOn("run-b", "planner"));
      expect(elsewhere._tag).toBe("refused");
      const planner = yield* answer("next-1", agentOn("run-a", "planner"));
      expect(planner._tag).toBe("accepted");
      expect((yield* store.asked("run-a"))[0]).toMatchObject({
        answer: "Implement now",
        cause: "delivery-1",
        messaged: [{ agent: "planner" }],
      });

      yield* asks("next-2");
      yield* supersede("next-2");
      yield* store.asking({ ...question, decision: "next-2-revision", revises: "next-2" });
      const revised = yield* answer("next-2", agentOn("run-a", "planner"));
      expect(revised._tag === "refused" && revised.reason).toContain("superseded");
      const row = Arr.findFirst(yield* store.asked("run-a"), (one) => one.decision === "next-2");
      expect(row._tag === "Some" && row.value.answer).toBeNull();
    }),
  ));

test("a revision opens only for the agents its caller found finished, not one messaged since", () =>
  onStore(
    "collie-store-revise-stale-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "asks" }));
      yield* store.asking({ run: "run-a", decision: "go", prompt: "Go?", options: ["yes"] });
      yield* store.supersede({
        run: "run-a",
        decision: "go",
        cause: "delivery-1",
        actor: human,
        agent: "planner",
      });
      const checked = (yield* store.asked("run-a"))[0]!.messaged ?? [];
      const revise = (name: string, messaged: typeof checked) =>
        store.revise({ run: "run-a", decision: "go", name, messaged });

      yield* store.alsoMessaged({ run: "run-a", decision: "go", agent: "reviewer" });
      expect(yield* revise("go.r2", checked)).toBe(false);

      const refreshed = (yield* store.asked("run-a"))[0]!.messaged ?? [];
      yield* store.alsoMessaged({ run: "run-a", decision: "go", agent: "planner" });
      expect(yield* revise("go.r2", refreshed)).toBe(false);

      expect(yield* revise("go.r2", (yield* store.asked("run-a"))[0]!.messaged ?? [])).toBe(true);
    }),
  ));

test("only questions a human's message can still set aside or extend are supersedable", () =>
  onStore(
    "collie-store-supersedable-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "asks" }));
      const question = { run: "run-a", prompt: "Go?", options: ["yes"] };
      const supersede = (decision: string) =>
        store.supersede({ run: "run-a", decision, cause: "d-1", actor: human, agent: "planner" });
      yield* store.asking({ ...question, decision: "open" });
      yield* store.asking({ ...question, decision: "aside" });
      yield* supersede("aside");
      yield* store.asking({ ...question, decision: "own", asker: "build" });
      yield* supersede("own");
      yield* store.asking({ ...question, decision: "old" });
      yield* supersede("old");
      const [old] = Arr.filter(yield* store.asked("run-a"), (one) => one.decision === "old");
      const messaged = old!.messaged ?? [];
      yield* store.revise({ run: "run-a", decision: "old", name: "old.r2", messaged });
      yield* store.settle({ run: "run-a", decision: "old.r2", value: "yes", request: "a-1" });

      expect(Arr.map(yield* store.supersedable, (one) => one.decision).sort()).toEqual([
        "aside",
        "open",
      ]);
    }),
  ));

test("two requests with the same input are two runs", () =>
  onStore(
    "collie-store-separate-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "same" }));
      yield* store.admit(admission("req-2", "run-b", { note: "same" }));
      expect(Arr.map(yield* store.runs, (row) => row.run).sort()).toEqual(["run-a", "run-b"]);
    }),
  ));

test("what a host admitted is there when the database is opened again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-store-reopen-" });
      const file = `${dir}/host.db`;

      yield* Effect.gen(function* () {
        const store = yield* Store;
        yield* store.remember({ name: "proof@1", workflow: "proof", entry: "/saved/proof.ts" });
        yield* store.admit(admission("req-1", "run-a", { note: "durable" }));
      }).pipe(Effect.provide(opens(file)), Effect.scoped);

      // A second host, on the same file, with nothing carried over in memory.
      yield* Effect.gen(function* () {
        const store = yield* Store;
        expect(yield* store.generations).toEqual([
          { name: "proof@1", workflow: "proof", entry: "/saved/proof.ts" },
        ]);
        const found = yield* store.run("run-a");
        expect(found?.request).toBe("req-1");
        expect(found?.execution).toBe("execution-run-a");
        // Admitted and never accepted: work for the new host to pick up.
        expect(Arr.map(yield* store.pending, (row) => row.run)).toEqual(["run-a"]);
      }).pipe(Effect.provide(opens(file)), Effect.scoped);
    }).pipe(Effect.scoped),
  ));

test("a run belongs to the task and the run it was started from", () =>
  onStore(
    "collie-store-belongs-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(
        admission("req-1", "run-a", { note: "child" }, { task: "task-7", parent: "run-parent" }),
      );
      const found = yield* store.run("run-a");
      expect(found?.task).toBe("task-7");
      expect(found?.parent).toBe("run-parent");
      // What was started on its own belongs to nothing, which is not the same as "task-7".
      yield* store.admit(admission("req-2", "run-b", { note: "alone" }));
      expect((yield* store.run("run-b"))?.task).toBeNull();
    }),
  ));

test("a run the engine has taken is no longer work to recover", () =>
  onStore(
    "collie-store-accepted-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "accepted" }));
      expect(yield* store.pending).toHaveLength(1);
      yield* store.accepted("run-a");
      expect(yield* store.pending).toHaveLength(0);
    }),
  ));

test("a subscriber is told once the change is committed", () =>
  onStore(
    "collie-store-changes-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-1", "run-a", { note: "before" }));

      // The first is what is there; the second is what the admission below committed.
      const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(store.changes, 2)));
      yield* Effect.yieldNow;
      yield* store.admit(admission("req-2", "run-b", { note: "after" }));

      const updates = yield* Fiber.join(seen);
      expect(Arr.map(updates, (rows) => Arr.map(rows, (row) => row.run))).toEqual([
        ["run-a"],
        ["run-a", "run-b"],
      ]);
    }),
  ));

test("a Run's near rows are its Task's, their parents and children, and the Runs asked for", () =>
  onStore(
    "collie-store-near-",
    Effect.gen(function* () {
      const store = yield* Store;
      const admit = (run: string, belongs: { task?: string; parent?: string }, placing?: string) =>
        store.admit({ ...admission(`req-${run}`, run, {}, belongs), ...(placing && { placing }) });
      yield* admit("parent", { task: "elsewhere" });
      yield* admit("lead", { task: "t1" });
      yield* admit("follow", { task: "t1", parent: "parent" });
      yield* admit("child", { task: "t2", parent: "lead" });
      yield* admit("asked", { task: "t3" }, '{"requestedBy":{"run":"lead"}}');
      yield* admit("unrelated", { task: "t4" });
      yield* admit("alone", {});

      const near = (run: string) =>
        Effect.map(store.near(run), (rows) =>
          Arr.sort(
            Arr.map(rows, (row) => row.run),
            Order.String,
          ),
        );

      expect(yield* near("lead")).toEqual(["asked", "child", "follow", "lead", "parent"]);
      expect(yield* near("alone")).toEqual(["alone", "asked"]);
    }),
  ));

test("a Run's near rows, with nothing written, are the rows read before", () =>
  onStore(
    "collie-store-near-kept-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-lead", "lead", {}, { task: "t1" }));
      yield* store.admit(admission("req-follow", "follow", {}, { task: "t1" }));
      const every = yield* store.runs;

      const near = yield* store.near("lead");
      expect(near.length).toBe(2);
      for (const row of near) expect(every).toContain(row);
    }),
  ));

test("Runs read again with nothing written are the rows read before, and a write renews only its Run's", () =>
  onStore(
    "collie-store-kept-rows-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-a", "run-a", { note: "a" }));
      yield* store.admit(admission("req-b", "run-b", { note: "b" }));
      const before = yield* store.runs;
      expect(yield* store.runs).toBe(before);

      yield* store.accepted("run-b");
      const after = yield* store.runs;
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[1]?.accepted).not.toBeNull();
    }),
  ));

test("a write reads again only the rows of the Runs it wrote, and an announce none", () =>
  onStore(
    "collie-store-written-rows-",
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      yield* store.admit(admission("req-a", "run-a", { note: "a" }));
      yield* store.admit(admission("req-b", "run-b", { note: "b" }));
      const before = yield* store.runs;

      // Unseen by the store, as no write through it names run-a.
      yield* sql`UPDATE collie_runs SET project = '/elsewhere' WHERE run = 'run-a'`;
      yield* store.announce;
      yield* store.accepted("run-b");
      yield* store.admit(admission("req-c", "run-c", { note: "c" }));
      const after = yield* store.runs;

      expect(after[0]).toBe(before[0]);
      expect(after[1]?.accepted).not.toBeNull();
      expect(Arr.map(after, (row) => row.run)).toEqual(["run-a", "run-b", "run-c"]);
    }),
  ));

/** An accepted run-a whose next read of the Runs waits on the connection until `release`. */
const waitingRead = Effect.gen(function* () {
  const store = yield* Store;
  const sql = yield* SqlClient.SqlClient;
  yield* store.admit(admission("req-a", "run-a", { note: "a" }));
  yield* store.runs;
  yield* store.accepted("run-a");
  const held = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  yield* sql
    .withTransaction(Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release)))
    .pipe(Effect.forkChild({ startImmediately: true }));
  yield* Deferred.await(held);
  const first = yield* store.runs.pipe(Effect.forkChild({ startImmediately: true }));
  return { store, first, release: Deferred.succeed(release, undefined) };
});

test("a read of the Runs made while another is reading them again has the writes before it", () =>
  onStore(
    "collie-store-overlap-",
    Effect.gen(function* () {
      const { store, first, release } = yield* waitingRead;
      const second = yield* store.runs.pipe(Effect.forkChild({ startImmediately: true }));
      yield* release;
      expect((yield* Fiber.join(second))[0]?.accepted).not.toBeNull();
      expect((yield* Fiber.join(first))[0]?.accepted).not.toBeNull();
    }),
  ));

test("a read of the Runs interrupted while reading them again leaves the writes to the next", () =>
  onStore(
    "collie-store-interrupted-",
    Effect.gen(function* () {
      const { store, first, release } = yield* waitingRead;
      yield* Fiber.interrupt(first);
      yield* release;
      expect((yield* store.runs)[0]?.accepted).not.toBeNull();
    }),
  ));

test("a question asked of one Run moves that Run's decisions alone, and an announce moves none", () =>
  onStore(
    "collie-store-decided-",
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit(admission("req-a", "run-a", {}));
      yield* store.admit(admission("req-b", "run-b", {}));
      const decided = yield* store.decided;
      const a = decided("run-a");
      const b = decided("run-b");

      yield* store.asking({ run: "run-a", decision: "go", prompt: "Go?", options: ["yes"] });
      yield* store.announce;
      expect(decided("run-a")).not.toBe(a);
      expect(decided("run-b")).toBe(b);
    }),
  ));

test("a write to a Run's row moves that Run's revision in the host's Run model, and no other", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-store-model-" });
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const model = yield* RunModel;
        yield* store.admit(admission("req-a", "run-a", {}));
        yield* store.admit(admission("req-b", "run-b", {}));
        const a = model.revision("run-a").seq;
        const b = model.revision("run-b").seq;
        yield* store.recordPlacing("run-a", "{}");
        expect(model.revision("run-a").seq).toBeGreaterThan(a);
        expect(model.revision("run-b").seq).toBe(b);
      }).pipe(
        Effect.provide(
          storeLayer.pipe(
            Layer.provideMerge(runModelLayer(dir, "installation")),
            Layer.provide(
              SqliteClient.layer({ filename: `${dir}/host.db` }).pipe(
                Layer.provideMerge(Reactivity.layer),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  ));
