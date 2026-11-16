import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  flow,
} from "effect";
import { TestClock } from "effect/testing";
import * as PlatformError from "effect/PlatformError";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { epochMs } from "../src/time";
import { StoreWrites } from "../src/store-writes";
import { Artefacts } from "../src/artefacts";
import type { ArtefactMatches, ArtefactSearch } from "../src/artefact-model";
import { Away, searchFlock, type SearchSource } from "../src/artefact-search";
import { connect } from "../src/host";
import { removeTask, writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun, recordsAt } from "./support/records";
import { collie, proves } from "./support/world";

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

test("an unreadable historical collection remains incomplete while another Run is indexed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Artefacts;
      const first = yield* madeRun(rig.stateDir, { id: "a" });
      const second = yield* madeRun(rig.stateDir, { id: "b" });
      yield* fs.writeFileString(`${second.evidence}/proof.txt`, "retained proof");
      yield* catalogue.index([first, second]).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (path, options) =>
            path === `${first.dir}/attachments`
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readDirectory",
                  }),
                )
              : fs.readDirectory(path, options),
        }),
      );
      const page = yield* catalogue.search({}, ["a", "b"]);
      expect(page.coverage).toEqual({ runs: 2, indexed: 1 });
      expect(Arr.map(page.items, (item) => item.title)).toEqual(["proof.txt"]);
    }),
  ));

test("bounded indexing rotates past unfinished Runs to reach later retained material", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
      );
      const runs = [];
      for (let n = 0; n < 5; n++) {
        const run = yield* madeRun(rig.stateDir, { id: `r-${n}` });
        for (let file = 0; file < (n === 4 ? 1 : 20); file++)
          yield* fs.writeFileString(`${run.evidence}/${file}.txt`, "evidence");
        runs.push(run);
      }
      yield* catalogue.index(runs);
      expect(
        (yield* catalogue.search(
          { run: "r-4" },
          Arr.map(runs, (run) => run.id),
        )).items,
      ).toEqual([]);
      yield* catalogue.index(runs);
      expect(
        (yield* catalogue.search(
          { run: "r-4" },
          Arr.map(runs, (run) => run.id),
        )).items,
      ).toHaveLength(1);
    }),
  ));

test("interruption during a source read retries that source after restart without losing earlier ids or receipts", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const notified: string[] = [];
      const hostOn = Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
        Effect.provideService(StoreWrites, (runs) => notified.push(...runs)),
      );
      const catalogue = yield* hostOn;
      const run = yield* madeRun(rig.stateDir);
      yield* fs.makeDirectory(`${run.dir}/handoffs`);
      yield* fs.writeFileString(`${run.dir}/handoffs/a.md`, "first");
      const blocked = `${run.dir}/handoffs/b.md`;
      yield* fs.writeFileString(blocked, "second");
      const entered = yield* Deferred.make<void>();
      const indexing = yield* catalogue.index([run]).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: (path: string) =>
            path === blocked
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : fs.readFile(path),
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      expect(notified).toContain(run.id);
      const first = (yield* catalogue.list(run.id))[0]!;
      yield* Fiber.interrupt(indexing);
      yield* catalogue.seen(run.id, first.id, 1, "seen-before-restart", actor);
      const restarted = yield* hostOn;
      yield* restarted.index([run]);
      const page = yield* restarted.search({}, [run.id]);
      expect(page.coverage).toEqual({ runs: 1, indexed: 1 });
      expect(Arr.map(page.items, (item) => item.title).sort()).toEqual(["a.md", "b.md"]);
      expect(
        Option.getOrUndefined(Arr.findFirst(page.items, (item) => item.id === first.id)),
      ).toMatchObject({ ref: "handoff:a.md", seen: { revision: 1 } });
    }),
  ));

test("search filters by name, description, URL, path, Run, kind, role and unseen, pages stably, and resumes historical indexing after a restart", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // One host's database, opened by two hosts in turn: the second is the first restarted.
      const hostOn = Layer.build(recordsAt(rig.stateDir)).pipe(
        Effect.map((built) => Context.get(built, Artefacts)),
      );
      const catalogue = yield* hostOn;
      const old = yield* madeRun(rig.stateDir, { id: "r-old" });
      const newer = yield* madeRun(rig.stateDir, { id: "r-new" });
      yield* fs.makeDirectory(`${old.dir}/attachments`, { recursive: true });
      yield* fs.makeDirectory(`${old.dir}/handoffs`, { recursive: true });
      yield* fs.writeFileString(`${old.dir}/attachments/design-brief.md`, "# Brief\n");
      for (const n of Arr.range(0, 9))
        yield* fs.writeFileString(`${old.dir}/handoffs/h${n}.txt`, `handoff ${n}\n`);
      yield* fs.writeFileString(`${newer.evidence}/report.txt`, "evidence\n");
      yield* fs.makeDirectory(`${rig.stateDir}/outside`, { recursive: true });
      yield* fs.writeFileString(`${rig.stateDir}/outside/data.csv`, "a,b\n");
      const link = yield* catalogue.register(
        newer,
        "inst",
        {
          url: "https://example.com/dash",
          title: "Dashboard",
          description: "Quarterly numbers",
        },
        "link",
        actor,
      );
      const dataset = yield* catalogue.register(
        newer,
        "inst",
        { path: `${rig.stateDir}/outside/data.csv`, kind: "dataset", title: "Æble.csv" },
        "data",
        actor,
      );
      const eligible = ["r-old", "r-new"];
      const all = (asked: ArtefactSearch = {}) => catalogue.search(asked, eligible);

      expect((yield* all()).coverage).toEqual({ runs: 2, indexed: 0 });
      yield* catalogue.pass([old, newer]);
      const halfway = yield* all();
      expect(halfway.coverage).toEqual({ runs: 2, indexed: 1 });
      expect(Arr.filter(halfway.items, (item) => item.run === "r-old")).toHaveLength(8);
      const brief = Arr.findFirst(halfway.items, (item) => item.title === "design-brief.md");
      expect(brief._tag).toBe("Some");
      const briefItem = brief._tag === "Some" ? brief.value : undefined;
      yield* catalogue.seen("r-old", briefItem!.id, 1, "seen-brief", actor);

      const restarted = yield* hostOn;
      yield* restarted.pass([old, newer]);
      const whole = yield* restarted.search({}, eligible);
      expect(whole.coverage).toEqual({ runs: 2, indexed: 2 });
      expect(whole.items).toHaveLength(14);
      const again = Arr.findFirst(whole.items, (item) => item.id === briefItem!.id);
      expect(again._tag === "Some" && again.value).toMatchObject({
        title: "design-brief.md",
        seen: { revision: 1 },
        updated: { provenance: "filesystem-mtime" },
      });
      for (const before of halfway.items)
        expect(Arr.some(whole.items, (item) => item.id === before.id)).toBe(true);

      const titles = (matches: ArtefactMatches) => Arr.map(matches.items, (item) => item.title);
      expect(titles(yield* restarted.search({ query: "BRIEF" }, eligible))).toEqual([
        "design-brief.md",
      ]);
      expect(titles(yield* restarted.search({ query: "quarterly" }, eligible))).toEqual([
        "Dashboard",
      ]);
      expect(titles(yield* restarted.search({ query: "example.com/dash" }, eligible))).toEqual([
        "Dashboard",
      ]);
      expect(titles(yield* restarted.search({ query: "outside/data" }, eligible))).toEqual([
        "Æble.csv",
      ]);
      expect(titles(yield* restarted.search({ kind: "dataset" }, eligible))).toEqual(["Æble.csv"]);
      expect(titles(yield* restarted.search({ query: "Æble" }, eligible))).toEqual(["Æble.csv"]);
      expect(titles(yield* restarted.search({ role: "evidence" }, eligible))).toEqual([
        "report.txt",
      ]);
      expect(
        Arr.map(
          (yield* restarted.search({ run: "r-new" }, eligible)).items,
          (item) => item.id,
        ).sort(),
      ).toEqual(
        Arr.map(
          Arr.filter(whole.items, (item) => item.run === "r-new"),
          (item) => item.id,
        ).sort(),
      );
      expect((yield* restarted.search({ run: "r-new" }, eligible)).items).toHaveLength(3);
      const unseen = yield* restarted.search({ unseen: true }, eligible);
      expect(unseen.items).toHaveLength(13);
      expect(Arr.some(unseen.items, (item) => item.id === briefItem!.id)).toBe(false);
      expect(link.item.kind).toBe("link");
      expect(dataset.item.kind).toBe("dataset");
      const clock = yield* TestClock.make();
      yield* clock.setTime(epochMs(dataset.item.observedAt) + 31_000);
      const stale = yield* restarted.search({ kind: "dataset" }, eligible).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: () => Effect.die("search read file bytes"),
        }),
      );
      expect(stale.items[0]).toMatchObject({ id: dataset.item.id, stale: true, pending: false });
      expect((yield* restarted.search({}, ["r-new"])).items).toHaveLength(3);
      expect((yield* restarted.search({}, [])).items).toEqual([]);

      const paged: Array<string> = [];
      let after: ArtefactSearch["after"] = undefined;
      for (;;) {
        const page: ArtefactMatches = yield* restarted.search({ limit: 4, after }, eligible);
        expect(page.items.length).toBeLessThanOrEqual(4);
        paged.push(...Arr.map(page.items, (item) => item.id));
        if (!page.more) break;
        const last = page.items[page.items.length - 1]!;
        after = { detectedAt: last.detectedAt, run: last.run, id: last.id };
      }
      expect(paged).toEqual(Arr.map(whole.items, (item) => item.id));
      expect(new Set(paged).size).toBe(14);
    }),
  ));

const found = (
  installation: string,
  run: string,
  id: string,
  detectedAt: string,
): ArtefactMatches["items"][number] => ({
  id,
  run,
  kind: "file",
  role: "deliverable",
  title: `${id}.md`,
  ref: `registered:/${id}`,
  source: `/${id}`,
  mediaType: "text/markdown",
  size: 1,
  revision: 1,
  digest: id,
  registeredAt: detectedAt,
  observedAt: detectedAt,
  detectedAt,
  seen: null,
  sourceAvailability: "available",
  retainedAvailability: "available",
  reason: null,
  installation,
});

/** A host's search over `items`, ordered and paged as a host's catalogue is. */
const hostOf = (
  installation: string,
  items: ReadonlyArray<ArtefactMatches["items"][number]>,
  runs: ReadonlyArray<string>,
  asked: Array<ArtefactSearch>,
) => ({
  installation,
  has: (run: string) => Effect.succeed(runs.includes(run)),
  search: (query: ArtefactSearch) =>
    Effect.sync(() => {
      asked.push(query);
      const ordered = Arr.filter(
        [...items].sort(
          (a, b) =>
            Str.localeCompare(a.detectedAt)(b.detectedAt) ||
            Str.localeCompare(b.run)(a.run) ||
            Str.localeCompare(b.id)(a.id),
        ),
        (item) =>
          (query.run === undefined || item.run === query.run) &&
          (query.after === undefined ||
            item.detectedAt < query.after.detectedAt ||
            (item.detectedAt === query.after.detectedAt &&
              (item.run > query.after.run ||
                (item.run === query.after.run && item.id > query.after.id)))),
      );
      const limit = query.limit ?? 50;
      return {
        items: ordered.slice(0, limit),
        more: ordered.length > limit,
        coverage: { runs: runs.length, indexed: runs.length },
      } satisfies ArtefactMatches;
    }),
});

test("the Flock's search keeps Machines' Runs apart, refuses an ambiguous bare id, counts one installation once, and names what it could not search", () =>
  runEffect(
    Effect.gen(function* () {
      const askedA: Array<ArtefactSearch> = [];
      const askedB: Array<ArtefactSearch> = [];
      const a = hostOf(
        "inst-a",
        [
          found("inst-a", "run-1", "a1", "2026-11-01T00:00:03.000Z"),
          found("inst-a", "run-1", "a2", "2026-11-01T00:00:01.000Z"),
          found("inst-a", "run-9", "a3", "2026-11-01T00:00:05.000Z"),
        ],
        ["run-1", "run-9"],
        askedA,
      );
      const b = hostOf(
        "inst-b",
        [
          found("inst-b", "run-1", "b1", "2026-11-01T00:00:04.000Z"),
          found("inst-b", "run-1", "b2", "2026-11-01T00:00:02.000Z"),
        ],
        ["run-1"],
        askedB,
      );
      const sources: Array<SearchSource<never>> = [
        { machine: "alpha", reach: Effect.succeed(a) },
        { machine: "beta", reach: Effect.succeed(b) },
        // A second route to the first installation, as a paired link and herdr both offer it.
        { machine: "alpha-over-ssh", reach: Effect.succeed(a) },
      ];

      const first = yield* searchFlock(sources, { limit: 2 });
      expect(Arr.map(first.items, (one) => [one.machine, one.item.id])).toEqual([
        ["alpha", "a3"],
        ["beta", "b1"],
      ]);
      expect(first.machines).toEqual([
        {
          installation: "inst-a",
          machine: "alpha",
          state: "searched",
          reason: null,
          runs: 2,
          indexed: 2,
        },
        {
          installation: "inst-b",
          machine: "beta",
          state: "searched",
          reason: null,
          runs: 1,
          indexed: 1,
        },
      ]);
      expect(first.complete).toBe(true);
      const rest: Array<string> = [];
      let cursor = first.next;
      while (cursor !== null) {
        const page = yield* searchFlock(sources, { limit: 2, cursor });
        expect(page.machines).toHaveLength(2);
        rest.push(...Arr.map(page.items, (one) => one.item.id));
        cursor = page.next;
      }
      expect(rest).toEqual(["a1", "b2", "a2"]);

      const ambiguous = yield* searchFlock(sources, { run: "run-1" }).pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "AmbiguousRun",
        run: "run-1",
        candidates: [
          { installation: "inst-a", machine: "alpha" },
          { installation: "inst-b", machine: "beta" },
        ],
      });
      const byInstallation = yield* searchFlock(sources, { run: "inst-b:run-1" });
      expect(Arr.map(byInstallation.items, (one) => one.item.id)).toEqual(["b1", "b2"]);
      const byLabel = yield* searchFlock(sources, { run: "alpha:run-1" });
      expect(Arr.map(byLabel.items, (one) => one.item.id)).toEqual(["a1", "a2"]);
      const bare = yield* searchFlock(sources, { run: "run-9" });
      expect(Arr.map(bare.items, (one) => one.item.id)).toEqual(["a3"]);

      const renamed = yield* searchFlock(
        [
          { machine: "gamma", reach: Effect.succeed(a) },
          { machine: "beta", reach: Effect.succeed(b) },
        ],
        { run: "inst-a:run-1" },
      );
      expect(Arr.map(renamed.items, (one) => [one.installation, one.machine, one.item.id])).toEqual(
        [
          ["inst-a", "gamma", "a1"],
          ["inst-a", "gamma", "a2"],
        ],
      );

      const partial = yield* searchFlock(
        [
          { machine: "alpha", reach: Effect.succeed(a) },
          {
            machine: "beta",
            reach: Effect.fail(new Away({ state: "unreachable", reason: "connection refused" })),
          },
          {
            machine: "old",
            reach: Effect.succeed({
              installation: "inst-old",
              has: () => Effect.succeed(false),
              search: () =>
                Effect.fail(
                  new Away({ state: "unsupported", reason: "Upgrade this Machine to search" }),
                ),
            }),
          },
          {
            machine: "indexing",
            reach: Effect.succeed({
              installation: "inst-c",
              has: () => Effect.succeed(false),
              search: () =>
                Effect.succeed({ items: [], more: false, coverage: { runs: 3, indexed: 1 } }),
            }),
          },
        ],
        {},
      );
      expect(Arr.map(partial.items, (one) => one.item.id)).toEqual(["a3", "a1", "a2"]);
      expect(partial.complete).toBe(false);
      expect(partial.machines).toEqual([
        {
          installation: "inst-a",
          machine: "alpha",
          state: "searched",
          reason: null,
          runs: 2,
          indexed: 2,
        },
        {
          installation: null,
          machine: "beta",
          state: "unreachable",
          reason: "connection refused",
          runs: 0,
          indexed: 0,
        },
        {
          installation: "inst-old",
          machine: "old",
          state: "unsupported",
          reason: "Upgrade this Machine to search",
          runs: 0,
          indexed: 0,
        },
        {
          installation: "inst-c",
          machine: "indexing",
          state: "searched",
          reason: null,
          runs: 3,
          indexed: 1,
        },
      ]);
      expect(
        yield* searchFlock(sources, { cursor: "not a cursor" }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "HostRefused",
      });
    }),
  ));

test(
  "a Task's earlier Run off the board, its active Run and a Run with no Task card are all found once reconciled",
  () =>
    proves(
      "collie-artefact-search-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* writeTask({
            id: "task-1",
            workspace: "w1",
            label: "project | Find material",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.provide(recordsAt(world.state)), Effect.orDie);
          const runIdOf = flow(
            Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String })),
            Effect.map(({ runId }) => runId),
            Effect.orDie,
          );
          // Given at the start, so each Run's material is there before anything indexes it.
          for (const name of ["old", "active", "loose"])
            yield* fs.writeFileString(`${world.project}/${name}-findings.md`, `# ${name}\n`);
          const attach = (name: string) => ["--attach", `${world.project}/${name}-findings.md`];
          const old = yield* runIdOf(
            (yield* collie(world, [
              "run",
              "start",
              "plain",
              "--task",
              "task-1",
              ...attach("old"),
              "--input",
              "note=old",
            ])).envelope.data,
          );
          yield* collie(world, ["run", "wait", old]);
          const active = yield* runIdOf(
            (yield* collie(world, [
              "run",
              "start",
              "asks",
              "--task",
              "task-1",
              ...attach("active"),
              "--input",
              "goal=now",
            ])).envelope.data,
          );
          const loose = yield* runIdOf(
            (yield* collie(world, [
              "run",
              "start",
              "plain",
              ...attach("loose"),
              "--input",
              "note=loose",
            ])).envelope.data,
          );
          yield* collie(world, ["run", "wait", loose]);
          const door = yield* connect(world.state).pipe(Effect.orDie);
          const looseTask = (yield* door.run({ runId: loose }).pipe(Effect.orDie))?.task;
          if (looseTask != null)
            yield* removeTask(looseTask).pipe(Effect.provide(recordsAt(world.state)), Effect.orDie);

          const search = door.artefactSearch({ query: "findings" }).pipe(Effect.orDie);
          let searched = yield* search;
          for (
            let tries = 0;
            searched.coverage.indexed < searched.coverage.runs && tries < 200;
            tries++
          )
            searched = yield* search;
          expect(searched.coverage.indexed).toBe(searched.coverage.runs);
          expect(searched.coverage.runs).toBeGreaterThanOrEqual(3);
          expect(Arr.map(searched.items, (item) => [item.run, item.title]).sort()).toEqual(
            [
              [old, "old-findings.md"],
              [active, "active-findings.md"],
              [loose, "loose-findings.md"],
            ].sort(),
          );

          const cli = yield* collie(world, ["artefacts", "--query", "findings"]);
          expect(cli.envelope.ok).toBe(true);
          expect(cli.envelope.data).toMatchObject({ complete: true, next: null });
          const listed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              items: Schema.Array(
                Schema.Struct({
                  installation: Schema.String,
                  item: Schema.Struct({ run: Schema.String, title: Schema.String }),
                }),
              ),
            }),
          )(cli.envelope.data);
          const installation = Str.trim(yield* fs.readFileString(`${world.state}/installation`));
          expect(Arr.map(listed.items, (one) => one.installation)).toEqual([
            installation,
            installation,
            installation,
          ]);
        }),
      ["plain.workflow.ts", "asks.workflow.ts"],
    ),
  120_000,
);

test("an unavailable Run lookup is bounded and reported alongside another Machine's results", () =>
  runEffect(
    Effect.gen(function* () {
      const page = yield* searchFlock(
        [
          {
            machine: "ok",
            reach: Effect.succeed(hostOf("ok", [found("ok", "r", "a", "2026-01-01")], ["r"], [])),
          },
          {
            machine: "old",
            reach: Effect.succeed({
              installation: "old",
              has: () => Effect.fail(new Away({ state: "unsupported", reason: "upgrade" })),
              search: () => Effect.never,
            }),
          },
        ],
        { run: "r" },
      );
      expect(Arr.map(page.items, (one) => one.item.id)).toEqual(["a"]);
      expect(page.complete).toBe(false);
      expect(page.machines).toContainEqual({
        installation: "old",
        machine: "old",
        state: "unsupported",
        reason: "upgrade",
        runs: 0,
        indexed: 0,
      });
    }),
  ));
