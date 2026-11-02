// `collie cleanup` lists what the host's sweep would remove and keep, and `--apply`
// sweeps now; the host also sweeps on its own (ADR-0045).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import {
  Clock,
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schema,
  flow,
  Result,
} from "effect";
import { readAudit } from "../src/audit";
import { loadEntry } from "../src/engine";
import { connect } from "../src/host";
import { proposalsPath, record as recordProposal } from "../src/proposals";
import { CleanupReport } from "../src/board-model";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  hostCheckProcesses,
  runningChecksDir,
} from "../src/check-processes";
import { checksSweeper, generationsSweeper, sweepAsked, type Sweeper } from "../src/cleanup";
import { signalProcess } from "../src/lock";
import { startedOf, stillRunning } from "../src/processes";
import { sweepEvery } from "../src/side-jobs";
import { VerifySpecSchema } from "../src/verify-spec";
import { exec, startDetached } from "./support/command";
import { fastForward, runEffect } from "./support/effect";
import { fixtures, root, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const DAY_MS = 24 * 60 * 60_000;

const Listed = flow(Schema.decodeUnknownResult(CleanupReport), Result.getOrThrow);
const parsed = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const asRecord = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))),
  Result.getOrThrow,
);

/** A staged generation last used `days` ago, holding one file of `bytes`. */
const generation = (world: World, name: string, days: number, bytes = 8192) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${world.home}/.cache/collie/entries/generations/${name}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/entry.ts`, Str.repeat(bytes)("x"));
    const at = DateTime.toDateUtc(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - days * DAY_MS),
    );
    yield* fs.utimes(dir, at, at);
    return dir;
  });

/** A `sleep` left running by nobody, carrying only the bindings in `env`. */
const leftRunning = (env: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const pid = yield* startDetached([
      "env",
      "-u",
      CHECK_INSTALLATION,
      "-u",
      CHECK_ID,
      ...env,
      "sleep",
      "120",
    ]);
    yield* Effect.addFinalizer(() => signalProcess(pid, "SIGKILL"));
    return { pid, started: (yield* startedOf(pid)) ?? "" };
  });

const RUNNING_FOR_MS = (2 * 60 + 10) * 60_000;

/** A check of `run-left` started 2h10m ago, marked for `installation` and left by its host. */
const leftCheck = (installation: string) =>
  Effect.gen(function* () {
    const id = `run-left@${(yield* Clock.currentTimeMillis) - RUNNING_FOR_MS - 30_000}-left`;
    const left = yield* leftRunning([`${CHECK_INSTALLATION}=${installation}`, `${CHECK_ID}=${id}`]);
    return { id, ...left };
  });

/** This world's installation id, which its host writes as it starts. */
const installationIn = (world: World) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(`${world.state}/installation`),
  ).pipe(
    Effect.map((text) => Str.trim(text)),
    Effect.orDie,
  );

const checkItems = (listed: { readonly envelope: { readonly data?: unknown } }) => {
  const report = Listed(listed.envelope.data);
  return {
    remove: Arr.filter(report.remove, (item) => item.kind === "check"),
    keep: Arr.filter(report.keep, (item) => item.kind === "check"),
  };
};

const journalOf = (world: World) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(`${world.state}/cleanup.jsonl`)
      .pipe(Effect.orElseSucceed(() => ""));
  });

test(
  "cleanup lists a generation unused for a week as removable, and keeps one used yesterday",
  () =>
    proves(
      "collie-cleanup-list-",
      (world) =>
        Effect.gen(function* () {
          const stale = yield* generation(world, "stale", 8);
          const used = yield* generation(world, "used", 1);

          const listed = yield* collie(world, ["cleanup"]);
          expect(listed.envelope).toMatchObject({ ok: true });
          const report = Listed(listed.envelope.data);
          const removable = Arr.filter(report.remove, (item) => item.kind === "generation");
          expect(Arr.map(removable, (item) => item.target)).toEqual([stale]);
          expect(removable[0]?.bytes).toBeGreaterThanOrEqual(8192);
          expect(removable[0]?.reason).toBe("unused for 8 days");
          expect(report.keep).toContainEqual({
            kind: "generation",
            target: used,
            reason: "used 1 day(s) ago",
          });
          expect(report.bytes).toBe(Arr.reduce(report.remove, 0, (sum, item) => sum + item.bytes));
          // A listing removes nothing.
          expect(yield* (yield* FileSystem.FileSystem).exists(stale)).toBe(true);
        }),
      [],
    ),
  60_000,
);

test(
  "cleanup --apply removes exactly what it listed, and journals it as the CLI's",
  () =>
    proves(
      "collie-cleanup-apply-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stale = yield* generation(world, "stale", 8);
          const used = yield* generation(world, "used", 1);

          const swept = yield* collie(world, ["cleanup", "--apply", "--request-id", "c-1"]);
          expect(swept.envelope).toMatchObject({ ok: true });
          const report = Listed(swept.envelope.data);
          expect(Arr.map(report.remove, (item) => item.target)).toEqual([stale]);
          expect(report.bytes).toBeGreaterThanOrEqual(8192);
          expect(yield* fs.exists(stale)).toBe(false);
          expect(yield* fs.exists(used)).toBe(true);

          const lines = Str.split(Str.trim(yield* journalOf(world)), "\n");
          expect(lines).toHaveLength(1);
          expect(parsed(lines[0] ?? "{}")).toMatchObject({
            by: { origin: "cli", request: "c-1" },
            kind: "generation",
            target: stale,
            reason: "unused for 8 days",
          });

          // The same request again is the same sweep, not another.
          const again = yield* collie(world, ["cleanup", "--apply", "--request-id", "c-1"]);
          expect(Arr.map(Listed(again.envelope.data).remove, (item) => item.target)).toEqual([
            stale,
          ]);
        }),
      [],
    ),
  60_000,
);

test("a sweep asked again under its request while it runs waits for it and answers with its report", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-twice-" });
      const trail = `${dir}/cleanup`;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let sweeps = 0;
      let left = 3;
      const slow: Sweeper = {
        kind: "generation",
        judge: Effect.gen(function* () {
          sweeps += 1;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return {
            remove:
              left === 0
                ? []
                : [{ kind: "generation", target: `${dir}/g${left}`, bytes: 10, reason: "unused" }],
            keep: [],
          };
        }),
        remove: () => Effect.sync(() => ((left -= 1), { freed: 10 })),
      };
      const asked = (request: string) =>
        sweepAsked(
          trail,
          { operation: "cleanup", request, origin: "desktop", asked: {} },
          Effect.succeed([slow]),
          dir,
          { origin: "desktop", request },
        );

      const first = yield* Effect.forkScoped(asked("d-1"));
      yield* Deferred.await(started);
      const second = yield* Effect.forkScoped(asked("d-1"));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const [one, two] = [yield* Fiber.join(first), yield* Fiber.join(second)];

      expect(sweeps).toBe(1);
      expect(one.remove).toHaveLength(1);
      expect(two).toEqual(one);
      expect(Arr.filter(yield* readAudit(trail), (line) => line.request === "d-1")).toHaveLength(1);

      yield* asked("d-2");
      expect(sweeps).toBe(2);
    }),
  ));

test("a sweep whose caller goes away still finishes and keeps its report for the same request", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-left-" });
      const trail = `${dir}/cleanup`;
      const removing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let sweeps = 0;
      let left = 1;
      const slow: Sweeper = {
        kind: "generation",
        judge: Effect.sync(() => {
          sweeps += 1;
          return {
            remove:
              left === 0
                ? []
                : [{ kind: "generation", target: `${dir}/g`, bytes: 1024, reason: "unused" }],
            keep: [],
          };
        }),
        remove: () =>
          Effect.gen(function* () {
            left -= 1;
            yield* Deferred.succeed(removing, undefined);
            yield* Deferred.await(release);
            return { freed: 1024 };
          }),
      };
      const asked = sweepAsked(
        trail,
        { operation: "cleanup", request: "d-1", origin: "desktop", asked: {} },
        Effect.succeed([slow]),
        dir,
        { origin: "desktop", request: "d-1" },
      );

      const first = yield* Effect.forkScoped(asked);
      yield* Deferred.await(removing);
      const gone = yield* Effect.forkScoped(Fiber.interrupt(first));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(gone);
      const again = yield* asked;

      expect(sweeps).toBe(1);
      expect(again.bytes).toBe(1024);
    }),
  ));

test("the host sweeps on its own every ten minutes, and journals it as its own", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scheduled-" });
      const stale = `${dir}/generations/stale`;
      yield* fs.makeDirectory(stale, { recursive: true });
      const old = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 8 * DAY_MS),
      );
      yield* fs.utimes(stale, old, old);
      yield* Effect.forkScoped(
        fastForward(
          sweepEvery(dir, Effect.succeed([generationsSweeper(`${dir}/generations`)])),
          60_000,
        ),
      );
      const journal = yield* until(
        () => fs.readFileString(`${dir}/cleanup.jsonl`).pipe(Effect.orElseSucceed(() => "")),
        (text) => text !== "",
      );
      expect(yield* fs.exists(stale)).toBe(false);
      expect(parsed(Str.trim(journal))).toMatchObject({
        by: "host",
        kind: "generation",
        target: stale,
      });
    }),
  ));

test("loading a module whose generation is already staged counts as using it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "staged-" });
      yield* fs.makeDirectory(`${dir}/project`);
      yield* fs.copyFile(`${fixtures}/hello.workflow.ts`, `${dir}/project/hello.workflow.ts`);
      const generations = `${dir}/cache/collie/entries/generations`;
      const load = loadEntry(`${dir}/project/hello.workflow.ts`).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      );
      const before = Bun.env.XDG_CACHE_HOME;
      Bun.env.XDG_CACHE_HOME = `${dir}/cache`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (before === undefined) delete Bun.env.XDG_CACHE_HOME;
          else Bun.env.XDG_CACHE_HOME = before;
        }),
      );
      yield* load;
      const [staged] = yield* fs.readDirectory(generations);
      const old = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 8 * DAY_MS),
      );
      yield* fs.utimes(`${generations}/${staged}`, old, old);

      yield* load;
      const info = yield* fs.stat(`${generations}/${staged}`);
      const used = Option.getOrThrow(info.mtime).getTime();
      expect((yield* Clock.currentTimeMillis) - used).toBeLessThan(DAY_MS);
    }),
  ));

test(
  "chat's cleanup action sweeps through the same host operation, and says what it removed",
  () =>
    proves(
      "collie-cleanup-chat-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stale = yield* generation(world, "stale", 8);
          const file = yield* proposalsPath(world.state, "some-herd");
          const proposal = yield* recordProposal(file, {
            interpretation: "free some disk",
            targets: [],
            actions: [{ kind: "cleanup" }],
            allowedNow: [],
            intentVersions: {},
            by: "evaluator:e-1",
          });
          // Started as an operator's would be, with the world's home and so its cache.
          yield* collie(world, ["cleanup"]);
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "chat" });
          const answered = yield* client.confirm({
            proposal: proposal.id,
            hash: proposal.content_hash,
            request: "r-1",
          });
          expect(answered.results).toMatchObject([{ index: 0, kind: "cleanup", state: "applied" }]);
          expect(answered.results[0]?.note).toStartWith("removed 1 item(s)");
          expect(yield* fs.exists(stale)).toBe(false);
          expect(parsed(Str.trim(yield* journalOf(world)))).toMatchObject({
            by: { origin: "chat" },
            target: stale,
          });
        }).pipe(Effect.orDie),
      [],
    ),
  60_000,
);

test(
  "doctor's low-disk warning says what a sweep would free",
  () =>
    proves(
      "collie-cleanup-doctor-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* generation(world, "stale", 8, 64 * 1024);
          // The host has served this state directory, so doctor may ask it.
          yield* collie(world, ["cleanup"]);
          const bin = `${world.home}/bin`;
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(
            `${bin}/df`,
            "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 104857600 96468992 8388608 92%% /\\n'\n",
            { mode: 0o755 },
          );

          const doctor = yield* collie(world, ["doctor"], { PATH: `${bin}:/usr/bin:/bin` });
          const checks = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              checks: Schema.Array(Schema.Struct({ name: Schema.String, detail: Schema.String })),
            }),
          )(doctor.envelope.data ?? doctor.envelope.error?.details).pipe(Effect.orDie);
          const disk = Option.getOrUndefined(
            Arr.findFirst(checks.checks, (check) => check.name === "disk"),
          );
          expect(disk?.detail).toMatch(
            /^\/ has 8\.0 GiB free \(8%\); `collie cleanup` would free \d/,
          );
        }),
      [],
    ),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "doctor warns while a check no host is collecting runs, and passes once cleanup ends it",
  () =>
    proves(
      "collie-cleanup-doctor-check-",
      (world) =>
        Effect.gen(function* () {
          yield* collie(world, ["cleanup"]);
          const left = yield* leftCheck(yield* installationIn(world));
          const checksOf = Effect.gen(function* () {
            const doctor = yield* collie(world, ["doctor"]);
            const report = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                checks: Schema.Array(
                  Schema.Struct({
                    name: Schema.String,
                    detail: Schema.String,
                    fix: Schema.String,
                    warn: Schema.optional(Schema.Boolean),
                  }),
                ),
              }),
            )(doctor.envelope.data ?? doctor.envelope.error?.details).pipe(Effect.orDie);
            return Option.getOrUndefined(
              Arr.findFirst(report.checks, (check) => check.name === "checks"),
            );
          });

          expect(yield* checksOf).toEqual({
            name: "checks",
            detail: `1 check process(es) no host is collecting: run-left's check ${left.id}, pid ${left.pid}, running 2h10m; no host is collecting it`,
            fix: "collie cleanup --apply",
            warn: true,
          });
          yield* collie(world, ["cleanup", "--apply"]);
          expect(yield* checksOf).toEqual({
            name: "checks",
            detail: "no check is running that no host is collecting",
            fix: "",
          });
        }),
      [],
    ),
  60_000,
);

test(
  "cleanup keeps the compaction controls of an agent in a session opened while the host runs",
  () =>
    proves(
      "collie-cleanup-session-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const log = Bun.env.FAKE_HERDR_LOG;
          const desk = { name: "desk", socket_path: `${world.home}/desk.sock` };
          const late = { name: "late", socket_path: `${world.home}/late.sock` };
          const state = `${log}.state.json`;
          const seeded = (yield* fs.exists(state)) ? asRecord(yield* fs.readFileString(state)) : {};
          yield* fs.writeFileString(
            state,
            asJson({ ...seeded, agents: [{ name: "impl", pane_id: "p-late" }] }),
          );
          const controls = `${world.state}/compaction/impl`;
          yield* fs.makeDirectory(controls, { recursive: true });
          yield* fs.writeFileString(
            `${controls}/control.json`,
            asJson({
              agent: "impl",
              harness: "codex",
              cwd: world.project,
              dir: controls,
              endpoint: null,
              pid: null,
              command: null,
              attempt: null,
            }),
          );
          const herdr = { FAKE_HERDR_AGENTS_IN: late.socket_path };
          yield* fs.writeFileString(`${log}.sessions.json`, asJson([desk]));
          const before = Listed((yield* collie(world, ["cleanup"], herdr)).envelope.data);
          expect(Arr.map(before.remove, (item) => item.target)).toContain(controls);

          yield* fs.writeFileString(`${log}.sessions.json`, asJson([desk, late]));
          const listed = yield* collie(world, ["cleanup"], herdr);
          expect(listed.envelope.ok).toBe(true);
          expect(Arr.map(Listed(listed.envelope.data).remove, (item) => item.target)).not.toContain(
            controls,
          );
        }),
      [],
    ),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "cleanup lists a check no host is collecting and --apply ends it, leaving another installation's and an unmarked process alone",
  () =>
    proves(
      "collie-cleanup-check-",
      (world) =>
        Effect.gen(function* () {
          yield* collie(world, ["cleanup"]);
          const left = yield* leftCheck(yield* installationIn(world));
          const theirs = yield* leftRunning([
            `${CHECK_INSTALLATION}=another-installation`,
            `${CHECK_ID}=run-theirs@1-theirs`,
          ]);
          const unmarked = yield* leftRunning([]);

          const listed = checkItems(yield* collie(world, ["cleanup"]));
          expect(listed.keep).toEqual([]);
          expect(listed.remove).toEqual([
            {
              kind: "check",
              target: left.id,
              bytes: 0,
              reason: `run-left's check ${left.id}, pid ${left.pid}, running 2h10m; no host is collecting it`,
            },
          ]);

          const swept = yield* collie(world, ["cleanup", "--apply", "--request-id", "c-1"]);
          expect(Arr.map(checkItems(swept).remove, (item) => item.target)).toEqual([left.id]);
          expect(yield* stillRunning(left)).toBe(false);
          expect(yield* Effect.forEach([theirs, unmarked], stillRunning)).toEqual([true, true]);
          expect(parsed(Str.trim(yield* journalOf(world)))).toMatchObject({
            by: { origin: "cli", request: "c-1" },
            kind: "check",
            target: left.id,
            bytes: 0,
          });
          expect(checkItems(yield* collie(world, ["cleanup"])).remove).toEqual([]);
        }),
      [],
    ),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "the host's own sweep ends a check no host is collecting, and journals it as its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "swept-checks-" });
        const checks = yield* hostCheckProcesses({
          dir,
          installation: "installation-under-test",
          sweep: true,
        });
        const left = yield* leftCheck("installation-under-test");
        yield* Effect.forkScoped(
          fastForward(sweepEvery(dir, Effect.succeed([checksSweeper(checks)])), 60_000),
        );
        const journal = yield* until(
          () => fs.readFileString(`${dir}/cleanup.jsonl`).pipe(Effect.orElseSucceed(() => "")),
          (text) => text !== "",
        );
        expect(parsed(Str.trim(journal))).toMatchObject({
          by: "host",
          kind: "check",
          target: left.id,
        });
        expect(yield* stillRunning(left)).toBe(false);
      }),
    ),
);

test.skipIf(process.platform !== "linux")(
  "cleanup keeps a check its host is collecting, and --apply leaves it running",
  () =>
    proves(
      "collie-cleanup-collected-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const notes = `${world.home}/notes`;
          yield* fs.makeDirectory(notes);
          yield* Effect.addFinalizer(() =>
            fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
          );
          yield* fs.makeDirectory(`${world.project}/.collie`);
          yield* fs.writeFileString(
            `${world.project}/.collie/verify.json`,
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(VerifySpecSchema)))([
              {
                name: "held",
                executable: `${root}test/fixtures/checks/held.sh`,
                argv: [notes],
                cwd: ".",
              },
            ]).pipe(Effect.orDie),
          );
          for (const args of [
            ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"],
            ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"],
          ])
            yield* exec(["git", ...args], { cwd: world.project });
          yield* collie(world, [
            "run",
            "start",
            "checking",
            "--input",
            "check=held",
            "--input",
            `cwd=${world.project}`,
          ]);
          const pid = Number(
            Str.trim(
              yield* until(
                () => fs.readFileString(`${notes}/starts`).pipe(Effect.orElseSucceed(() => "")),
                (text) => Str.trim(text) !== "",
              ),
            ),
          );
          const check = { pid, started: (yield* startedOf(pid)) ?? "" };
          const [record] = yield* until(
            () =>
              fs.readDirectory(runningChecksDir(world.state)).pipe(Effect.orElseSucceed(() => [])),
            // Not its `.new`, which the host writes first and renames.
            (files) => files.length === 1 && pipe_(files[0]!, Str.endsWith(".json")),
          );
          const kept = {
            kind: "check",
            target: pipe_(record ?? "", Str.replace(/\.json$/, "")),
            reason: "this host is collecting it",
          };

          const listed = checkItems(yield* collie(world, ["cleanup"]));
          expect(listed).toEqual({ remove: [], keep: [kept] });
          const swept = checkItems(yield* collie(world, ["cleanup", "--apply"]));
          expect(swept).toEqual({ remove: [], keep: [kept] });
          expect(yield* stillRunning(check)).toBe(true);
        }),
      ["checking.workflow.ts"],
    ),
  60_000,
);
