import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import * as Arr from "effect/Array";
import { Order } from "effect";
import { Artefacts, ObservationFailed, type ProviderRead, ProviderReaders } from "../src/artefacts";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun } from "./support/records";

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const actor = { origin: "agent", requestId: "r" } as const;

test("scheduling one Run preserves another Run's provider retry backoff", () =>
  runEffect(
    Effect.gen(function* () {
      const catalogue = yield* Artefacts;
      const a = yield* madeRun(rig.stateDir, { id: "run-a" });
      const b = yield* madeRun(rig.stateDir, { id: "run-b" });
      const clock = yield* TestClock.make();
      yield* clock.setTime(100_000);
      let attempts = 0;
      const readers = new Map([
        [
          "acme",
          () =>
            Effect.sync(() => attempts++).pipe(
              Effect.andThen(
                Effect.fail(new ObservationFailed({ state: "denied", reason: "No access" })),
              ),
            ),
        ],
      ]);
      yield* Effect.gen(function* () {
        const { item } = yield* catalogue.register(
          b,
          "inst",
          { provider: { name: "acme", resource: "private" } },
          "register",
          actor,
        );
        yield* clock.adjust(30_001);
        yield* catalogue.pass([a, b]);
        expect(attempts).toBe(1);
        expect((yield* catalogue.list(b.id))[0]).toMatchObject({
          id: item.id,
          sourceAvailability: "denied",
        });
        yield* catalogue.schedule(a);
        yield* clock.adjust(31_000);
        yield* catalogue.pass([a, b]);
        expect(attempts).toBe(1);
        yield* clock.adjust(29_000);
        yield* catalogue.pass([a, b]);
        expect(attempts).toBe(2);
        yield* catalogue.schedule(a);
        yield* clock.adjust(60_001);
        yield* catalogue.pass([a, b]);
        expect(attempts).toBe(2);
        yield* clock.adjust(60_000);
        yield* catalogue.pass([a, b]);
        expect(attempts).toBe(3);
      }).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(ProviderReaders, readers),
      );
    }),
  ));

test("a provider reader's answers map to versions, dates and source states by namespaced identity", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Artefacts;
      const run = yield* madeRun(rig.stateDir, { id: "r-observe" });
      const said = new Map<string, Effect.Effect<ProviderRead, ObservationFailed>>();
      const asked: Array<string> = [];
      const readers = new Map([
        [
          "acme",
          (resource: { namespace: string | null; resource: string | null }) => {
            const key = `${resource.namespace}/${resource.resource}`;
            asked.push(key);
            return said.get(key) ?? Effect.die(`unexpected ${key}`);
          },
        ],
      ]);
      const observe = catalogue
        .reconcile(run)
        .pipe(Effect.provideService(ProviderReaders, readers));
      const export_ = `${rig.stateDir}/export/page.md`;
      yield* fs.makeDirectory(`${rig.stateDir}/export`, { recursive: true });
      yield* fs.writeFileString(export_, "# Exported\n");
      const a = yield* catalogue.register(
        run,
        "inst",
        {
          url: "https://acme.example/p/1",
          kind: "acme.dev/page",
          provider: { name: "acme", namespace: "team-a", resource: "p1", version: "v1" },
          updated: "2026-01-02T03:04:05.000Z",
          path: export_,
        },
        "a",
        actor,
      );
      const b = yield* catalogue.register(
        run,
        "inst",
        { provider: { name: "acme", namespace: "team-b", resource: "p1" } },
        "b",
        actor,
      );
      const other = yield* catalogue.register(
        run,
        "inst",
        { url: "https://unread.example/x", provider: { name: "nobody", resource: "x" } },
        "c",
        actor,
      );
      expect(b.item.id).not.toBe(a.item.id);
      expect(a.item.provider).toMatchObject({ version: "v1", provenance: "caller-reported" });
      expect(a.item.sourceAvailability).toBe("untracked");

      said.set(
        "team-a/p1",
        Effect.succeed({
          version: "v2",
          url: "https://acme.example/p/1?v=2",
          created: null,
          updated: null,
        }),
      );
      said.set(
        "team-b/p1",
        Effect.succeed({
          version: "b7",
          url: null,
          created: "2025-05-05T00:00:00.000Z",
          updated: null,
        }),
      );
      const first = yield* observe;
      const byId = (id: string) => Arr.findFirst(first.items, (one) => one.id === id);
      const seenA = byId(a.item.id);
      const seenB = byId(b.item.id);
      expect(Arr.sort(asked, Order.String)).toEqual(["team-a/p1", "team-b/p1"]);
      expect(seenA._tag === "Some" && seenA.value).toMatchObject({
        revision: 2,
        url: "https://acme.example/p/1?v=2",
        digest: a.item.digest,
        sourceAvailability: "available",
        provider: { version: "v2", provenance: "provider-verified" },
        created: null,
        updated: { at: "2026-01-02T03:04:05.000Z", provenance: "caller-reported" },
      });
      expect(seenB._tag === "Some" && seenB.value).toMatchObject({
        revision: 2,
        provider: { namespace: "team-b", version: "b7", provenance: "provider-verified" },
        created: { at: "2025-05-05T00:00:00.000Z", provenance: "provider-verified" },
      });
      expect(seenB._tag === "Some" && seenB.value.url).toBeUndefined();
      const unread = Arr.findFirst(first.items, (one) => one.id === other.item.id);
      expect(unread._tag === "Some" && unread.value.sourceAvailability).toBe("untracked");

      said.set(
        "team-a/p1",
        Effect.succeed({
          version: "v2",
          url: "https://acme.example/p/1?v=2",
          created: null,
          updated: null,
        }),
      );
      const failures = [
        ["unsupported", "unsupported"],
        ["auth-expired", "auth-expired"],
        ["denied", "denied"],
        ["missing", "missing"],
      ] as const;
      for (const [state, expected] of failures) {
        said.set(
          "team-b/p1",
          Effect.fail(new ObservationFailed({ state, reason: `provider said ${state}` })),
        );
        const after = Arr.findFirst((yield* observe).items, (one) => one.id === b.item.id);
        expect(after._tag === "Some" && after.value).toMatchObject({
          revision: 2,
          sourceAvailability: expected,
          reason: `provider said ${state}`,
          provider: { version: "b7" },
        });
      }
      const unchanged = Arr.findFirst((yield* observe).items, (one) => one.id === a.item.id);
      expect(unchanged._tag === "Some" && unchanged.value.revision).toBe(2);

      const entered = yield* Deferred.make<void>();
      said.set(
        "team-a/p1",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const clock = yield* TestClock.make();
      const timedOut = yield* Effect.gen(function* () {
        const fiber = yield* observe.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Effect.yieldNow;
        yield* clock.adjust(4001);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provideService(Clock.Clock, clock));
      const late = Arr.findFirst(timedOut.items, (one) => one.id === a.item.id);
      expect(late._tag === "Some" && late.value).toMatchObject({
        revision: 2,
        sourceAvailability: "timeout",
        retainedAvailability: "available",
      });
      const kept = yield* catalogue.read(run, a.item.id, 2, 0);
      expect(Buffer.from(kept.content, "base64").toString()).toBe("# Exported\n");
    }),
  ));
