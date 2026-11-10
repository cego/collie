// The agent register, kept in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database).

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Result, Schema, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { AgentInfo } from "../src/herdr";
import { connect } from "../src/host";
import {
  AgentEntrySchema,
  everyRegistered,
  lineageAgent,
  REGISTERED,
  registerAgent,
  registerOf,
  type AgentEntry,
  type RegistryScope,
} from "../src/registry";
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
        prefix: "hw-registry-",
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

const here: RegistryScope = { session: "/run/herdr.sock", workspaceId: "w1", cwd: "/project" };
const there: RegistryScope = { session: "/run/herdr.sock", workspaceId: "w2", cwd: "/project" };

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  role: "implementer",
  agent: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  runId: "r1",
  workflow: "implement",
  at: "2026-09-09T09:00:00Z",
  incarnation: { terminalId: "term-1", agentSession: null },
  ...over,
});

const live = (of: AgentEntry): AgentInfo => ({
  name: of.agent,
  paneId: of.paneId,
  workspaceId: of.workspaceId,
  status: "idle",
  title: null,
  terminalId: of.incarnation?.terminalId ?? null,
  agentSession: null,
});

const agents = (entries: ReadonlyArray<AgentEntry>) => Arr.map(entries, (one) => one.agent);

test("a registration tells the Run model the Runs of the agents it registered and dropped", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: string[] = [];
      yield* Effect.gen(function* () {
        yield* registerAgent(here, entry({ agent: "impl-gone", paneId: "1-8", runId: "r0" }));
        moved.length = 0;
        yield* registerAgent(here, entry(), {
          agents: [],
          listedAt: "2026-09-09T10:00:00Z",
        });
      }).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(StoreWrites, (runs) => moved.push(...runs)),
      );
      expect(moved.sort()).toEqual(["r0", "r1"]);
    }),
  ));

test("an agent registered again is one entry, the newest; one herdr no longer lists is dropped from its register only", () =>
  runEffect(
    Effect.gen(function* () {
      const first = entry();
      const gone = entry({ agent: "impl-gone", paneId: "1-8" });
      const elsewhere = entry({ agent: "impl-there", paneId: "2-1", workspaceId: "w2" });
      yield* registerAgent(here, first);
      yield* registerAgent(here, gone);
      yield* registerAgent(there, elsewhere);
      yield* registerAgent(here, entry({ at: "2026-09-09T09:05:00Z" }));
      expect(agents(yield* everyRegistered)).toEqual(["impl-gone", "impl-there", "impl-1"]);

      // A seat registered after the listing is kept: it may have started alongside.
      const seat = entry({ agent: "impl-seat", paneId: "1-7", at: "2026-09-09T09:20:00Z" });
      yield* registerAgent(here, seat);
      const kept = yield* registerAgent(here, entry({ agent: "impl-2", paneId: "1-6" }), {
        agents: [live(first)],
        listedAt: "2026-09-09T09:10:00Z",
      });
      expect(agents(kept)).toEqual(["impl-1", "impl-seat", "impl-2"]);
      expect(agents(yield* everyRegistered)).toEqual([
        "impl-there",
        "impl-1",
        "impl-seat",
        "impl-2",
      ]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the agent a lineage asks for is the nearest Run's live one in that role", () =>
  runEffect(
    Effect.gen(function* () {
      const parents = entry({ agent: "impl-p", paneId: "1-1", runId: "r-parent" });
      const own = entry({ agent: "impl-own", paneId: "1-2", runId: "r-child" });
      const other = entry({ agent: "impl-other", paneId: "1-3", runId: "r-other" });
      for (const one of [parents, own, other]) yield* registerAgent(here, one);
      const alive = Arr.map([parents, own, other], live);
      expect((yield* lineageAgent(alive, "implementer", ["r-child", "r-parent"]))?.agent).toBe(
        "impl-own",
      );
      expect(
        (yield* lineageAgent([live(parents)], "implementer", ["r-child", "r-parent"]))?.agent,
      ).toBe("impl-p");
      expect(yield* lineageAgent(alive, "reviewer", ["r-child"])).toBeNull();
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a registration moves whatever follows the register, as the board does", () =>
  runEffect(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const following = yield* Deferred.make<void>();
      const reads = yield* reactivity
        .stream([REGISTERED], Deferred.succeed(following, undefined).pipe(Effect.asVoid))
        .pipe(Stream.take(2), Stream.runCount, Effect.forkScoped);
      yield* Deferred.await(following);
      yield* registerAgent(here, entry());
      expect(yield* Fiber.join(reads).pipe(Effect.timeout("2 seconds"))).toBe(2);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

const asJson = (entries: ReadonlyArray<AgentEntry>) =>
  Result.getOrThrow(
    Schema.encodeResult(Schema.fromJsonString(Schema.Array(AgentEntrySchema)))(entries),
  );

test("the first host imports each register file once, in its order, and leaves the files in place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/agents/r1`, { recursive: true });
      const older = entry({ agent: "impl-old", paneId: "1-1" });
      yield* fs.writeFileString(
        `${stateDir}/agents/${registerOf(here)}.json`,
        `${asJson([older, entry()])}\n`,
      );
      yield* fs.writeFileString(`${stateDir}/agents/torn.json`, "[{");

      expect(agents(yield* Effect.provide(everyRegistered, recordsAt(stateDir)))).toEqual([
        "impl-old",
        "impl-1",
      ]);
      yield* fs.writeFileString(
        `${stateDir}/agents/${registerOf(there)}.json`,
        `${asJson([entry({ agent: "impl-later" })])}\n`,
      );
      // Imported into the register it was kept in: a registration there replaces its agent.
      const after = yield* registerAgent(here, entry({ at: "2026-09-09T10:00:00Z" })).pipe(
        Effect.provide(recordsAt(stateDir)),
      );
      expect(agents(after)).toEqual(["impl-old", "impl-1"]);
      expect(agents(yield* Effect.provide(everyRegistered, recordsAt(stateDir)))).not.toContain(
        "impl-later",
      );
      expect(yield* fs.exists(`${stateDir}/agents/${registerOf(here)}.json`)).toBe(true);
    }),
  ));

test("another process reads the register through the host", () =>
  proves(
    "collie-registry-host-",
    (world) =>
      Effect.gen(function* () {
        yield* registerAgent(here, entry()).pipe(Effect.provide(recordsAt(world.state)));
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const answered = yield* client.registered().pipe(Effect.orDie);
        yield* stopHost(world.state);
        expect(answered).toEqual([entry()]);
      }),
    [],
  ));
