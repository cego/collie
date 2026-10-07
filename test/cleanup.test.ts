// `collie cleanup` lists what the host's sweep would remove and keep, and `--apply`
// sweeps now; the host also sweeps on its own (ADR-0045).

import { expect, test } from "bun:test";
import { Clock, ConfigProvider, DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { loadEntry } from "../src/engine";
import { connect } from "../src/host";
import { proposalsPath, record as recordProposal } from "../src/proposals";
import { CleanupReport } from "../src/board-model";
import { generationsSweeper } from "../src/cleanup";
import { sweepEvery } from "../src/side-jobs";
import { fastForward, runEffect } from "./support/effect";
import { fixtures, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const DAY_MS = 24 * 60 * 60_000;

const Listed = Schema.decodeUnknownSync(CleanupReport);
const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A staged generation last used `days` ago, holding one file of `bytes`. */
const generation = (world: World, name: string, days: number, bytes = 8192) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${world.home}/.cache/collie/entries/generations/${name}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/entry.ts`, "x".repeat(bytes));
    const at = DateTime.toDateUtc(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - days * DAY_MS),
    );
    yield* fs.utimes(dir, at, at);
    return dir;
  });

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
          const removable = report.remove.filter((item) => item.kind === "generation");
          expect(removable.map((item) => item.target)).toEqual([stale]);
          expect(removable[0]?.bytes).toBeGreaterThanOrEqual(8192);
          expect(removable[0]?.reason).toBe("unused for 8 days");
          expect(report.keep).toContainEqual({
            kind: "generation",
            target: used,
            reason: "used 1 day(s) ago",
          });
          expect(report.bytes).toBe(report.remove.reduce((sum, item) => sum + item.bytes, 0));
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
          expect(report.remove.map((item) => item.target)).toEqual([stale]);
          expect(report.bytes).toBeGreaterThanOrEqual(8192);
          expect(yield* fs.exists(stale)).toBe(false);
          expect(yield* fs.exists(used)).toBe(true);

          const lines = (yield* journalOf(world)).trim().split("\n");
          expect(lines).toHaveLength(1);
          expect(parsed(lines[0] ?? "{}")).toMatchObject({
            by: { origin: "cli", request: "c-1" },
            kind: "generation",
            target: stale,
            reason: "unused for 8 days",
          });

          // The same request again is the same sweep, not another.
          const again = yield* collie(world, ["cleanup", "--apply", "--request-id", "c-1"]);
          expect(Listed(again.envelope.data).remove.map((item) => item.target)).toEqual([stale]);
        }),
      [],
    ),
  60_000,
);

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
      expect(parsed(journal.trim())).toMatchObject({
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
          expect(parsed((yield* journalOf(world)).trim())).toMatchObject({
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
          const checks = Schema.decodeUnknownSync(
            Schema.Struct({
              checks: Schema.Array(Schema.Struct({ name: Schema.String, detail: Schema.String })),
            }),
          )(doctor.envelope.data ?? doctor.envelope.error?.details);
          const disk = checks.checks.find((check) => check.name === "disk");
          expect(disk?.detail).toMatch(
            /^\/ has 8\.0 GiB free \(8%\); `collie cleanup` would free \d/,
          );
        }),
      [],
    ),
  60_000,
);
