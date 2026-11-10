// Each Herd's proposals journal, kept in the host's database
// (ADR-draft-collies-own-records-live-in-the-hosts-database).

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { TestClock } from "effect/testing";
import type { Action } from "../src/actions";
import { connect } from "../src/host";
import {
  confirm,
  everyProposal,
  journalOf,
  PROPOSALS,
  proposalsOf,
  read,
  record,
  stepStarted,
  type Actor,
} from "../src/proposals";
import { StoreWrites } from "../src/store-writes";
import { runEffect } from "./support/effect";
import { stopHost } from "./support/host";
import { recordsAt } from "./support/records";
import { proves } from "./support/world";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({
        prefix: "hw-proposals-journal-",
      });
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

const human: Actor = { origin: "cli-tty", requestId: "req-1" };
const actions: Action[] = [{ kind: "hold", run: "r1" }];
const proposed = {
  interpretation: "hold it",
  targets: [{ run: "r1" }],
  actions,
  allowedNow: [],
  intentVersions: { r1: 2 },
  by: "evaluator:call-1",
};

test("a proposal is found in its own Herd's journal, which keeps its lines in order", () =>
  runEffect(
    Effect.gen(function* () {
      const mine = yield* record("herd-1", proposed);
      const theirs = yield* record("herd-2", { ...proposed, by: "evaluator:call-2" });
      yield* stepStarted("herd-1", mine.id, 0);

      expect(yield* journalOf(mine.id)).toBe("herd-1");
      expect(yield* journalOf(theirs.id)).toBe("herd-2");
      expect(yield* journalOf("p-none")).toBeNull();
      expect(Arr.map(yield* read("herd-1"), (line) => line.kind)).toEqual(["proposal", "step"]);
      expect(Arr.map(yield* everyProposal, (line) => line.kind)).toEqual([
        "proposal",
        "proposal",
        "step",
      ]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("two identical proposals recorded at the same instant are two proposals", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* record("herd-1", proposed);
      const second = yield* record("herd-1", proposed);
      expect(second.created_at).toBe(first.created_at);
      expect(second.id).not.toBe(first.id);
    }).pipe(Effect.provide([recordsAt(stateDir), TestClock.layer()])),
  ));

test("two confirmations of one proposal at once: one is the answer, the other is told so", () =>
  runEffect(
    Effect.gen(function* () {
      const mine = yield* record("herd-1", proposed);
      const both = yield* Effect.all(
        [
          confirm("herd-1", mine.id, mine.content_hash, human, new Map([["r1", 2]])),
          confirm("herd-1", mine.id, mine.content_hash, human, new Map([["r1", 2]])),
        ],
        { concurrency: "unbounded" },
      );
      expect(Arr.map(both, (one) => ("refused" in one ? one.refused : "confirmed")).sort()).toEqual(
        ["confirmed", "not_pending"],
      );
      expect(Arr.filter(yield* read("herd-1"), (line) => line.kind === "confirmed")).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a proposal and its confirmation tell the Run model which Runs they moved", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: string[] = [];
      yield* Effect.gen(function* () {
        const mine = yield* record("herd-1", {
          ...proposed,
          targets: [{ run: "r1" }, { run: "r2" }],
        });
        moved.length = 0;
        yield* confirm("herd-1", mine.id, mine.content_hash, human, new Map([["r1", 2]]));
      }).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(StoreWrites, (runs) => moved.push(...runs)),
      );
      expect(moved.sort()).toEqual(["r1", "r2"]);
    }),
  ));

test("a line written moves whatever follows the proposals, as the board does", () =>
  runEffect(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const following = yield* Deferred.make<void>();
      const reads = yield* reactivity
        .stream([PROPOSALS], Deferred.succeed(following, undefined).pipe(Effect.asVoid))
        .pipe(Stream.take(2), Stream.runCount, Effect.forkScoped);
      yield* Deferred.await(following);
      yield* record("herd-1", proposed);
      expect(yield* Fiber.join(reads).pipe(Effect.timeout("2 seconds"))).toBe(2);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the first host imports each Herd's journal once, less a torn last line, and leaves it in place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const journal = `${stateDir}/herd/herd-1/proposals.jsonl`;
      yield* fs.makeDirectory(`${stateDir}/herd/herd-1`, { recursive: true });
      const step = (index: number) =>
        `{"kind":"step","proposal":"p-1","index":${index},"state":"applied","at":"2026-09-09T09:00:00Z"}`;
      yield* fs.writeFileString(journal, `${step(0)}\n${step(1)}\n{"kind":"st`);

      const lines = yield* Effect.provide(read("herd-1"), recordsAt(stateDir));
      expect(Arr.map(lines, (line) => (line.kind === "step" ? line.index : -1))).toEqual([0, 1]);
      yield* fs.writeFileString(journal, `${step(0)}\n${step(1)}\n${step(2)}\n`);
      expect(yield* Effect.provide(read("herd-1"), recordsAt(stateDir))).toHaveLength(2);
      expect(yield* fs.exists(journal)).toBe(true);
    }),
  ));

test("a Run's proposals are every one that names it, in any Herd, with what became of each", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/herd/herd-0`, { recursive: true });
      yield* fs.writeFileString(
        `${stateDir}/herd/herd-0/proposals.jsonl`,
        `{"kind":"proposal","id":"p-old","content_hash":"h","interpretation":"hold it","targets":[{"run":"r1"}],"actions":[{"kind":"hold","run":"r1"}],"allowed_now":[],"created_at":"2026-09-09T09:00:00Z","expires_at":"2026-09-09T09:30:00Z","intent_versions":{},"by":"evaluator:call-0","state":"pending"}\n`,
      );
      const { lines, mine, both } = yield* Effect.gen(function* () {
        const mine = yield* record("herd-1", proposed);
        yield* record("herd-1", { ...proposed, targets: [{ run: "r2" }], by: "evaluator:call-2" });
        const both = yield* record("herd-2", {
          ...proposed,
          targets: [{ run: "r2" }, { run: "r1" }],
          by: "evaluator:call-3",
        });
        yield* confirm("herd-1", mine.id, mine.content_hash, human, new Map([["r1", 2]]));
        return { lines: yield* proposalsOf("r1"), mine, both };
      }).pipe(Effect.provide(recordsAt(stateDir)));
      expect(
        Arr.map(lines, (line) => `${line.kind}:${line.kind === "step" ? line.proposal : line.id}`),
      ).toEqual([
        "proposal:p-old",
        `proposal:${mine.id}`,
        `proposal:${both.id}`,
        `confirmed:${mine.id}`,
      ]);
    }),
  ));

test("a Herd directory the first host cannot read fails its import, and the next host imports it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const herd = `${stateDir}/herd/herd-1`;
      yield* fs.makeDirectory(herd, { recursive: true });
      yield* fs.writeFileString(
        `${herd}/proposals.jsonl`,
        `{"kind":"step","proposal":"p-1","index":0,"state":"applied","at":"2026-09-09T09:00:00Z"}\n`,
      );
      yield* fs.chmod(herd, 0o000);

      const refused = yield* Effect.exit(Effect.provide(read("herd-1"), recordsAt(stateDir)));
      expect(refused._tag).toBe("Failure");
      yield* fs.chmod(herd, 0o755);
      expect(yield* Effect.provide(read("herd-1"), recordsAt(stateDir))).toHaveLength(1);
    }),
  ));

test("another process reads a Herd's proposals, and one proposal, through the host", () =>
  proves(
    "collie-proposals-host-",
    (world) =>
      Effect.gen(function* () {
        const mine = yield* record("herd-1", proposed).pipe(Effect.provide(recordsAt(world.state)));
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const lines = yield* client.proposals({ herd: "herd-1" }).pipe(Effect.orDie);
        const found = yield* client.proposal({ id: mine.id }).pipe(Effect.orDie);
        const none = yield* client.proposal({ id: "p-none" }).pipe(Effect.orDie);
        yield* stopHost(world.state);
        expect(lines).toEqual([mine]);
        expect(found).toEqual(mine);
        expect(none).toBeNull();
      }),
    [],
  ));
