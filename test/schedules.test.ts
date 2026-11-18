import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { Clock, Effect, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import { recordsReadLayer } from "../src/records";
import { connect, ownerOf } from "../src/host";
import { isoOf, ScheduleChanged, ScheduleListing } from "../src/schedule-model";
import { epochMs } from "../src/time";
import { stopHost, until } from "./support/host";
import { memoryRecords } from "./support/effect";
import { collie, proves, type World } from "./support/world";
import { exec } from "./support/command";
import { stringifyJson } from "../src/json";

const FAST = { COLLIE_HOST_SCHEDULE_SECONDS: "1" };
const MODULES = ["hello.workflow.ts", "proof.workflow.ts", "helper.ts", "notes.md"];

const schedule = (world: World, args: ReadonlyArray<string>) =>
  collie(world, ["schedule", ...args], FAST);

const listed = (world: World) =>
  schedule(world, ["list"]).pipe(
    Effect.flatMap((done) => Schema.decodeUnknownEffect(ScheduleListing)(done.envelope.data)),
    Effect.orDie,
  );

const scheduled = (world: World, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runs = yield* fs
      .readDirectory(`${world.state}/runs`)
      .pipe(Effect.orElseSucceed(() => []));
    const found: Array<{ run: string; occurrence: string; line: unknown }> = [];
    for (const run of runs) {
      const start = Option.getOrUndefined(
        Arr.findFirst(
          yield* readAudit(`${world.state}/runs/${run}`).pipe(
            Effect.provide(recordsReadLayer(world.state)),
            Effect.orElseSucceed(() => []),
          ),
          (line) => line.operation === "start",
        ),
      );
      const prefix = `schedule:${name}:`;
      if (start !== undefined && pipe(start.request, Str.startsWith(prefix)))
        found.push({ run, occurrence: pipe(start.request, Str.slice(prefix.length)), line: start });
    }
    return found.sort((one, other) => pipe(one.occurrence, Str.localeCompare(other.occurrence)));
  });

const past = (ms: number) =>
  until(
    () => Clock.currentTimeMillis,
    (now) => now > ms,
  );

test("a due Schedule admits one Run per occurrence, as the schedule Actor, and its removal keeps them", () =>
  proves(
    "collie-schedule-fires-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const added = yield* schedule(world, [
          "add",
          "hello-often",
          "hello",
          "--cron",
          "*/2 * * * * *",
          "--input",
          "name=world",
          "--workspace",
          world.project,
        ]);
        expect(added.envelope).toMatchObject({ ok: true, data: { change: "add" } });
        const installation = Str.trim(yield* fs.readFileString(`${world.state}/installation`));

        const fired = yield* until(
          () => scheduled(world, "hello-often"),
          (runs) => runs.length >= 2,
        );
        yield* schedule(world, ["pause", "hello-often"]);
        const first = fired[0]!;
        expect(first.line).toMatchObject({
          operation: "start",
          actor: {
            origin: "schedule",
            schedule: { name: "hello-often", occurrence: first.occurrence },
          },
        });
        const runs = yield* scheduled(world, "hello-often");
        expect(new Set(Arr.map(runs, (one) => one.occurrence)).size).toBe(runs.length);

        const list = yield* until(
          () => listed(world),
          (now) => ["run", "refused"].includes(now.schedules[0]?.last?.outcome.kind ?? ""),
        );
        const last = list.schedules[0]?.last?.outcome;
        if (last?.kind === "refused") expect(last.reason).toBe("the Schedule was paused");
        else expect(last).toMatchObject({ kind: "run", status: "complete" });
        expect(list.machine).toEqual({ installation, hostname: hostname() });
        expect(list.schedules[0]).toMatchObject({
          machine: { installation, hostname: hostname() },
          name: "hello-often",
          workflow: "hello",
          checkout: world.project,
          cron: "*/2 * * * * *",
          paused: true,
          next: null,
          start: {
            workflow: "hello",
            inputs: { name: "world" },
            workspace: world.project,
            verify: [],
          },
        });

        const removed = yield* schedule(world, ["remove", "hello-often"]);
        expect(removed.envelope).toMatchObject({
          ok: true,
          data: { change: "remove", schedule: null, machine: { installation } },
        });
        expect((yield* listed(world)).schedules).toEqual([]);
        const shown = yield* collie(world, ["run", "show", first.run]);
        expect(shown.envelope).toMatchObject({ ok: true });
      }),
    MODULES,
  ));

const taskLabelOf = (world: World, runId: string) => {
  const db = new Database(`${world.state}/host.db`, { readonly: true });
  try {
    const row = flow(
      Schema.decodeUnknownResult(Schema.Struct({ placing: Schema.String })),
      Result.getOrThrow,
    )(db.query("select placing from collie_runs where run = ?").get(runId));
    return flow(
      Schema.decodeResult(
        Schema.fromJsonString(Schema.Struct({ taskLabel: Schema.NullOr(Schema.String) })),
      ),
      Result.getOrThrow,
    )(row.placing).taskLabel;
  } finally {
    db.close();
  }
};

test("a scheduled Run's Task is named for the Schedule's work, not its first Input", () =>
  proves(
    "collie-schedule-names-",
    (world) =>
      Effect.gen(function* () {
        yield* schedule(world, [
          "add",
          "offer-banner-nightly",
          "hello",
          "--cron",
          "*/2 * * * * *",
          "--input",
          "name=world",
          "--workspace",
          world.project,
        ]);
        const fired = yield* until(
          () => scheduled(world, "offer-banner-nightly"),
          (runs) => runs.length >= 1,
        );
        yield* schedule(world, ["remove", "offer-banner-nightly"]);
        expect(taskLabelOf(world, fired[0]!.run)).toEndWith(" | Offer banner nightly");
      }),
    MODULES,
  ));

const viewed = (world: World, runId: string) =>
  Effect.scoped(
    connect(world.state).pipe(
      Effect.flatMap((client) => client.run({ runId })),
      Effect.orDie,
    ),
  );

const asking = (world: World, runId: string) =>
  until(
    () => viewed(world, runId),
    (view) =>
      Arr.some(view?.waiting ?? [], (one) => one.name === "decision" && one.answer === null),
  );

const answer = (world: World, runId: string) =>
  collie(world, ["run", "answer", runId, "yes", "--decision", "decision"], FAST);

const addAsking = (world: World, name: string, cron: string) =>
  schedule(world, [
    "add",
    name,
    "proof",
    "--cron",
    cron,
    "--input",
    "note=n",
    "--workspace",
    world.project,
  ]);

test("a pause and a resume asked while an occurrence is admitted wait for its Run, and start no second one beside it", () =>
  proves(
    "collie-schedule-admitting-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const source = `${world.project}/admission.md`;
        const entered = `${world.home}/admitting`;
        const hold = `${world.home}/hold-admission`;
        yield* fs.writeFileString(hold, "1").pipe(Effect.orDie);
        yield* Effect.addFinalizer(() => fs.remove(hold, { force: true }).pipe(Effect.ignore));
        yield* exec(["mkfifo", source]);
        const writing = yield* Effect.forkScoped(
          exec([
            "sh",
            "-c",
            'exec 3> "$1"\n: > "$2"\nwhile test -e "$3"; do sleep 0.02; done\nprintf "# Admission\\n" >&3',
            "schedule-admission",
            source,
            entered,
            hold,
          ]),
        );
        yield* collie(
          world,
          ["schedule", "add", "racing", "proof", "--cron", "* * * * * *"].concat([
            "--input",
            "note=admission.md",
            "--workspace",
            world.project,
          ]),
          FAST,
        );
        yield* until(
          () => fs.exists(entered).pipe(Effect.orDie),
          (ready) => ready,
        );
        const pausing = yield* Effect.forkScoped(
          collie(world, ["schedule", "pause", "racing"], FAST),
        );
        yield* past((yield* Clock.currentTimeMillis) + 700);
        const resuming = yield* Effect.forkScoped(
          collie(world, ["schedule", "resume", "racing"], FAST),
        );
        yield* past((yield* Clock.currentTimeMillis) + 700);
        yield* fs.remove(hold).pipe(Effect.orDie);
        expect((yield* Fiber.join(writing)).exitCode).toBe(0);
        expect((yield* Fiber.join(pausing)).envelope.ok).toBe(true);
        expect((yield* Fiber.join(resuming)).envelope.ok).toBe(true);
        const [first] = yield* until(
          () => scheduled(world, "racing"),
          (runs) => runs.length >= 1,
        );
        yield* asking(world, first!.run);
        yield* past((yield* Clock.currentTimeMillis) + 4_000);
        expect(yield* scheduled(world, "racing")).toHaveLength(1);
      }),
    MODULES,
  ));

const markRemoving = (world: World, name: string, request: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const record = `${world.state}/schedules/${name}/schedule.json`;
    const { added } = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ added: Schema.String })),
    )(yield* fs.readFileString(record)).pipe(Effect.orDie);
    yield* fs.writeFileString(`${world.state}/schedules/${name}/removed`, `${request} ${added}\n`);
    return record;
  });

test("a removal interrupted before the record went finishes removing it when its request is retried", () =>
  proves(
    "collie-schedule-removing-",
    (world) =>
      Effect.gen(function* () {
        yield* addAsking(world, "gone", "0 7 * * *");
        yield* markRemoving(world, "gone", "rm-1");
        const retried = yield* schedule(world, ["remove", "gone", "--request-id", "rm-1"]);
        expect(retried.envelope).toMatchObject({ ok: true, data: { change: "remove" } });
        expect((yield* listed(world)).schedules).toEqual([]);
      }).pipe(Effect.orDie),
    MODULES,
  ));

test("a removal interrupted after the record went and before its receipt finishes when its request is retried, and never removes a Schedule added since", () =>
  proves(
    "collie-schedule-removed-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* addAsking(world, "gone", "0 7 * * *");
        yield* fs.remove(yield* markRemoving(world, "gone", "rm-1"));
        const other = yield* schedule(world, ["remove", "gone", "--request-id", "rm-2"]);
        expect(other.envelope.error?.code).toBe("invalid_input");
        yield* addAsking(world, "gone", "0 8 * * *");
        const retried = yield* schedule(world, ["remove", "gone", "--request-id", "rm-1"]);
        expect(retried.envelope).toMatchObject({
          ok: true,
          data: { change: "remove", schedule: null },
        });
        expect(Arr.map((yield* listed(world)).schedules, (one) => one.cron)).toEqual(["0 8 * * *"]);
      }).pipe(Effect.orDie),
    MODULES,
  ));

test("a Schedule removed or paused while core does not answer starts no Run once core is back", () =>
  proves(
    "collie-schedule-core-",
    (world, core) =>
      Effect.gen(function* () {
        core.refuse("terminal.list", "unreachable", "core is down");
        const add = (name: string) =>
          collie(
            world,
            ["schedule", "add", name, "hello", "--cron", "* * * * * *"].concat([
              "--input",
              "name=world",
              "--workspace",
              world.project,
            ]),
            FAST,
          );
        yield* add("removed");
        yield* add("paused");
        yield* until(
          () => listed(world),
          (now) =>
            now.schedules.length === 2 &&
            Arr.every(now.schedules, (one) => one.last?.outcome.kind === "waiting-for-herdr"),
        );
        yield* collie(world, ["schedule", "remove", "removed"], FAST);
        yield* collie(world, ["schedule", "pause", "paused"], FAST);
        core.restore("terminal.list");
        yield* past((yield* Clock.currentTimeMillis) + 4_000);
        expect(yield* scheduled(world, "removed")).toEqual([]);
        expect(yield* scheduled(world, "paused")).toEqual([]);
      }),
    MODULES,
  ));

test("a Run still going holds the next occurrence, its end wakes the chain, and a pause or a removal leaves its Run going", () =>
  proves(
    "collie-schedule-waits-",
    (world) =>
      Effect.gen(function* () {
        yield* addAsking(world, "asks", "*/10 * * * * *");
        const [first] = yield* until(
          () => scheduled(world, "asks"),
          (runs) => runs.length === 1,
        );
        yield* asking(world, first!.run);
        const fell = epochMs(first!.occurrence) + 10_000;
        yield* past(fell + 1_000);
        expect(yield* scheduled(world, "asks")).toHaveLength(1);
        expect((yield* listed(world)).schedules[0]?.last?.outcome).toMatchObject({
          kind: "waiting-for-run",
          run: first!.run,
        });

        expect((yield* answer(world, first!.run)).envelope).toMatchObject({ ok: true });
        const runs = yield* until(
          () => scheduled(world, "asks"),
          (all) => all.length === 2,
        );
        const second = runs[1]!;
        expect(second.occurrence).toBe(isoOf(fell));
        yield* asking(world, second.run);

        yield* schedule(world, ["pause", "asks"]);
        yield* schedule(world, ["remove", "asks"]);
        const still = yield* viewed(world, second.run);
        expect(still?.status.status).toBe("suspended");
        expect(still?.controls).toEqual([]);
        yield* answer(world, second.run);
        const done = yield* until(
          () => viewed(world, second.run),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toMatchObject({ status: "complete" });
        expect(yield* scheduled(world, "asks")).toHaveLength(2);
      }),
    MODULES,
  ));

test("a host killed while its Schedule's Run goes admits no second Run, and the chain goes on", () =>
  proves(
    "collie-schedule-killed-",
    (world) =>
      Effect.gen(function* () {
        yield* addAsking(world, "kept", "*/2 * * * * *");
        const [first] = yield* until(
          () => scheduled(world, "kept"),
          (runs) => runs.length === 1,
        );
        yield* asking(world, first!.run);
        const owner = yield* ownerOf(world.state);
        process.kill(owner!.pid, "SIGKILL");
        yield* until(
          () =>
            Effect.sync(() => {
              try {
                return process.kill(owner!.pid, 0);
              } catch {
                return false;
              }
            }),
          (alive) => !alive,
        );
        yield* listed(world);
        yield* past(epochMs(first!.occurrence) + 5_000);
        expect(yield* scheduled(world, "kept")).toHaveLength(1);
        yield* asking(world, first!.run);
        yield* answer(world, first!.run);
        const runs = yield* until(
          () => scheduled(world, "kept"),
          (all) => all.length === 2,
        );
        expect(runs[0]!.run).toBe(first!.run);
        yield* schedule(world, ["remove", "kept"]);
      }),
    MODULES,
  ));

test("occurrences missed while no host ran start once, late, for the latest of them", () =>
  proves(
    "collie-schedule-missed-",
    (world) =>
      Effect.gen(function* () {
        const second = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const seconds = Array.from({ length: 26 }, (_, at) => (second + 8 + 2 * at) % 60);
        const added = yield* addAsking(
          world,
          "missed",
          `${Arr.join(
            Arr.map(seconds, (part) =>
              part === null || part === undefined ? "" : globalThis.String(part),
            ),
            ",",
          )} * * * * *`,
        );
        yield* stopHost(world.state);
        const pending = (yield* Schema.decodeUnknownEffect(ScheduleChanged)(
          added.envelope.data,
        ).pipe(Effect.orDie)).schedule?.next;
        yield* past(epochMs(pending!) + 6_000);
        const restarted = yield* Clock.currentTimeMillis;
        yield* listed(world);
        const [late] = yield* until(
          () => scheduled(world, "missed"),
          (runs) => runs.length >= 1,
        );
        expect(epochMs(late!.occurrence)).toBeGreaterThan(epochMs(pending!) + 4_000);
        expect(epochMs(late!.occurrence)).toBeGreaterThanOrEqual(restarted - 2_000);
        yield* asking(world, late!.run);
        expect(yield* scheduled(world, "missed")).toHaveLength(1);
        yield* schedule(world, ["remove", "missed"]);
      }),
    MODULES,
  ));

test("a refused start is recorded against its occurrence once, and the chain goes on to the next", () =>
  proves(
    "collie-schedule-refused-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const gone = `${world.home}/checkout`;
        yield* fs.makeDirectory(gone, { recursive: true });
        yield* schedule(world, [
          "add",
          "refused",
          "hello",
          "--cron",
          "*/2 * * * * *",
          "--input",
          "name=x",
          "--workspace",
          gone,
        ]);
        yield* fs.remove(gone, { recursive: true });
        const trail = `${world.state}/schedules/refused`;
        const lines = yield* until(
          () =>
            readAudit(trail).pipe(
              Effect.provide(memoryRecords),
              Effect.map((all) =>
                Arr.filter(
                  all,
                  (line) =>
                    line.operation === "occurrence" &&
                    pipe(stringifyJson(line.result), Str.includes('"refused"')),
                ),
              ),
              Effect.orElseSucceed(() => []),
            ),
          (all) => all.length >= 2,
        );
        yield* schedule(world, ["pause", "refused"]);
        expect(new Set(Arr.map(lines, (line) => line.request)).size).toBe(lines.length);
        expect(lines[0]).toMatchObject({
          actor: { origin: "schedule" },
          result: { kind: "refused", reason: expect.stringContaining(gone) },
        });
        expect((yield* listed(world)).schedules[0]?.last?.outcome).toMatchObject({
          kind: "refused",
        });
      }),
    MODULES,
  ));

test("a Schedule added paused does not fire, and resuming it starts no catch-up Run", () =>
  proves(
    "collie-schedule-paused-",
    (world) =>
      Effect.gen(function* () {
        const added = yield* schedule(world, [
          "add",
          "later",
          "hello",
          "--cron",
          "*/2 * * * * *",
          "--paused",
          "--input",
          "name=x",
          "--workspace",
          world.project,
        ]);
        expect(added.envelope).toMatchObject({
          ok: true,
          data: { schedule: { paused: true, next: null } },
        });
        const addedAt = yield* Clock.currentTimeMillis;
        yield* past(addedAt + 5_000);
        expect(yield* scheduled(world, "later")).toEqual([]);
        const resumedAt = yield* Clock.currentTimeMillis;
        const resumed = yield* schedule(world, ["resume", "later"]);
        expect(resumed.envelope).toMatchObject({
          ok: true,
          data: { change: "resume", schedule: { paused: false } },
        });
        const [first] = yield* until(
          () => scheduled(world, "later"),
          (runs) => runs.length >= 1,
        );
        expect(epochMs(first!.occurrence)).toBeGreaterThan(resumedAt);
        yield* schedule(world, ["remove", "later"]);
      }),
    MODULES,
  ));

test("a host whose engine lost an active Schedule's execution starts it again", () =>
  proves(
    "collie-schedule-lost-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* addAsking(world, "lost", "*/2 * * * * *");
        yield* stopHost(world.state);
        const before = new Set(Arr.map(yield* scheduled(world, "lost"), (one) => one.run));
        for (const name of yield* fs.readDirectory(world.state))
          if (pipe(name, Str.startsWith("host.db"))) yield* fs.remove(`${world.state}/${name}`);
        yield* listed(world);
        const [run] = yield* until(
          () =>
            Effect.map(scheduled(world, "lost"), (runs) =>
              Arr.filter(runs, (one) => !before.has(one.run)),
            ),
          (runs) => runs.length >= 1,
        );
        yield* asking(world, run!.run);
        yield* schedule(world, ["remove", "lost"]);
      }),
    MODULES,
  ));
