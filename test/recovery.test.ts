import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect, frontDoor, ownerOf, socketOf } from "../src/host";
import { collie, proves } from "./support/world";
import { until } from "./support/host";
import { readAudit } from "../src/audit";
import { FakeBin } from "./support/bin";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeOnPath,
  serveForges,
  type FakeMr,
} from "./support/forge";
import { exec } from "./support/command";
import { holderLives } from "../src/lock";
import { herdOf } from "../src/steering";
import { newsPath, pending, read as readNews } from "../src/news";
import { epochMs } from "../src/time";
import { CommandLine } from "effect/process";
import { pipe } from "effect/Function";
import { runEffect } from "./support/effect";
import { recheckPark, rememberFailedCi } from "../src/park-recheck";

const idOf = flow(
  Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String })),
  Effect.map((one) => one.runId),
  Effect.orDie,
);
const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const quote = (word: string) => Result.getOrThrow(CommandLine.quote(word));

test(
  "the host resumes a clean checkout park under its own recover request",
  () =>
    proves(
      "collie-recovery-clean-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=checkout-dirty-collie",
              "--input",
              "mr=",
              "--input",
              `file=${world.home}/fact`,
            ],
            { COLLIE_RECOVERY_EVERY: "100 millis" },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
          const runId = runs[0]!.runId;
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.parked !== null,
          );
          yield* (yield* FileSystem.FileSystem)
            .writeFileString(`${world.home}/fact`, "ready")
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status.status).toBe("complete");
          const audit = yield* until(
            () => readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
            (lines) => Arr.some(lines, (line) => line.operation === "resume"),
          );
          const resumes = Arr.filter(audit, (line) => line.operation === "resume");
          expect(resumes).toHaveLength(1);
          expect(resumes[0]).toMatchObject({
            request: expect.stringMatching(/^recover:/),
            actor: { origin: "host" },
          });
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "an automatically resumed mr Step repeats neither its push nor its merge request",
  () =>
    proves(
      "collie-recovery-mr-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const realGit = Bun.which("git")!;
          yield* exec(
            ["git", "remote", "add", "origin", "https://gitlab.example.com/mk/project.git"],
            { cwd: world.project },
          );
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const model = { installed: true, loggedIn: ["gitlab.example.com"], login: "me", mrs: [] };
          const forge = yield* forgeOnPath(bin, "gitlab", model);
          const COLLIE_FORGE_API = yield* serveForges(forge);
          const url = "https://gitlab.example.com/mk/project/-/merge_requests/7";
          const made = forge.holding({
            ...model,
            mrs: [{ project: "gitlab.example.com/mk/project", iid: "7", state: "open" }],
          });
          const effects = `${world.home}/effects`;
          yield* fs.copyFile(`${bin.dir}/glab`, `${bin.dir}/glab-original`).pipe(Effect.orDie);
          yield* bin.add(
            "git",
            `if [ "$1" = push ]; then echo push >> ${quote(effects)}; exit 0; fi\nexec ${quote(realGit)} "$@"`,
          );
          yield* bin.add(
            "glab",
            `if [ "$1 $2" = "mr create" ]; then echo opened >> ${quote(effects)}; printf '%s' ${quote(made.text)} > ${quote(made.path)}; echo ${quote(url)}; exit 0; fi\nexec ${quote(`${bin.dir}/glab-original`)} "$@"`,
          );
          const outputs = `${world.home}/outputs.json`;
          yield* fs
            .writeFileString(
              outputs,
              asJson([
                {
                  writes: [],
                  sh: "git push origin HEAD && glab mr create --title fixture --yes",
                  output: { url },
                },
                {
                  writes: [],
                  sh: "git push origin HEAD && glab mr create --title fixture --yes",
                  output: { url },
                },
              ]),
            )
            .pipe(Effect.orDie);
          const extra = {
            PATH: `${bin.dir}:${yield* Config.String("PATH")}`,
            COLLIE_FORGE_API,
            FAKE_HERDR_OUTPUTS: outputs,
            COLLIE_RECOVERY_EVERY: "100 millis",
          };
          expect(
            (yield* collie(world, ["settings", "set", "recovery.resume", "false"], extra)).envelope,
          ).toMatchObject({ ok: true });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "recover-mr",
              request: "start",
              input: { file: `${world.home}/fact` },
            })
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "suspended" && view.parked !== null,
          );
          yield* fs.writeFileString(`${world.home}/fact`, "ready").pipe(Effect.orDie);
          yield* collie(world, ["settings", "set", "recovery.resume", "true"]);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(Str.trim(yield* fs.readFileString(effects).pipe(Effect.orDie))).toBe(
            "push\nopened",
          );
          expect((yield* forge.model()).mrs).toHaveLength(1);
          expect(yield* client.launches({ run: runId }).pipe(Effect.orDie)).toHaveLength(1);
        }),
      ["recover-mr.workflow.ts"],
    ),
  120_000,
);

test(
  "a herdr park is rechecked read-only and resumes once herdr answers",
  () =>
    proves(
      "collie-recovery-herdr-",
      (world) =>
        Effect.gen(function* () {
          const off = yield* collie(world, ["settings", "set", "recovery.resume", "false"], {
            COLLIE_RECOVERY_EVERY: "100 millis",
            FAKE_HERDR_SESSIONS: "[]",
          });
          expect(off.envelope).toMatchObject({ ok: true });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "rechecks",
              request: "start",
              input: { cause: "herdr-unavailable", mr: "", file: `${world.home}/fact` },
            })
            .pipe(Effect.orDie);
          yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(
                lines,
                (line) => line.action === "rechecked" && line.note === "herdr answered",
              ),
          );
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.status.status).toBe(
            "suspended",
          );
          yield* (yield* FileSystem.FileSystem)
            .writeFileString(`${world.home}/fact`, "ready")
            .pipe(Effect.orDie);
          yield* collie(world, ["settings", "set", "recovery.resume", "true"]);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "clearing rechecks never answer Decisions, release Holds or Stops, or resume superseded work",
  () =>
    proves(
      "collie-recovery-human-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          const status = `${world.home}/status`;
          yield* fs
            .writeFileString(outputs, asJson([{ verdict: "done" }, { verdict: "done" }]))
            .pipe(Effect.orDie);
          yield* fs.writeFileString(status, "working").pipe(Effect.orDie);
          const off = yield* collie(world, ["settings", "set", "recovery.resume", "false"], {
            COLLIE_RECOVERY_EVERY: "100 millis",
            FAKE_HERDR_OUTPUTS: outputs,
            FAKE_HERDR_AGENT_STATUS_FILE: status,
            COLLIE_HOST_SUPERSEDE_GRACE_MS: "600000",
          });
          expect(off.envelope).toMatchObject({ ok: true });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const ids: string[] = [];
          for (const kind of ["hold", "stop", "decision", "superseded", "free"]) {
            const file = `${world.home}/${kind}`;
            if (kind === "decision" || kind === "superseded")
              yield* fs.writeFileString(file, "decision").pipe(Effect.orDie);
            const { runId } = yield* client
              .start({
                project: world.project,
                id: "rechecks",
                request: kind,
                input: { cause: "checkout-dirty-collie", file, mr: "" },
              })
              .pipe(Effect.orDie);
            ids.push(runId);
            yield* until(
              () => client.run({ runId }).pipe(Effect.orDie),
              (view) => view?.status.status === "suspended" && view.parked !== null,
            );
            if (kind === "hold" || kind === "stop")
              yield* client
                .control({ runId, control: kind, set: true, request: `control-${kind}` })
                .pipe(Effect.orDie);
            if (kind === "superseded") {
              const [launch] = yield* client.launches({ run: runId }).pipe(Effect.orDie);
              const desktop = yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie);
              yield* desktop.declare({ frontDoor: "desktop" }).pipe(Effect.orDie);
              yield* desktop
                .act({
                  actions: [
                    {
                      kind: "deliver",
                      run: runId,
                      agent: launch!.agent,
                      text: "Rework it",
                      mode: "boundary",
                    },
                  ],
                  request: "set-aside",
                })
                .pipe(Effect.orDie);
              yield* until(
                () => client.run({ runId }).pipe(Effect.orDie),
                (view) => Arr.some(view?.waiting ?? [], (one) => one.superseded != null),
              );
            }
            yield* fs.writeFileString(file, "ready").pipe(Effect.orDie);
          }
          yield* collie(world, ["settings", "set", "recovery.resume", "true"]);
          const free = ids[4]!;
          yield* until(
            () => client.run({ runId: free }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          yield* Effect.sleep("2 seconds");
          for (const runId of ids.slice(0, 4)) {
            const view = yield* client.run({ runId }).pipe(Effect.orDie);
            expect(view?.status.status).toBe("suspended");
            expect(Arr.every(view?.waiting ?? [], (one) => one.answer === null)).toBe(true);
            expect(
              Arr.filter(
                yield* readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
                (line) => line.operation === "resume" || line.operation === "answer",
              ),
            ).toEqual([]);
          }
          expect((yield* client.run({ runId: ids[0]! }).pipe(Effect.orDie))?.controls).toContain(
            "hold",
          );
          expect((yield* client.run({ runId: ids[1]! }).pipe(Effect.orDie))?.controls).toContain(
            "stop",
          );
          expect(
            (yield* client.run({ runId: ids[3]! }).pipe(Effect.orDie))?.waiting[0]?.superseded,
          ).not.toBeNull();
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "three failed recheck rounds raise one News item which a successful round clears",
  () =>
    proves(
      "collie-recovery-failing-",
      (world) =>
        Effect.gen(function* () {
          yield* exec(
            ["git", "remote", "add", "origin", "https://gitlab.example.com/mk/project.git"],
            { cwd: world.project },
          );
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const model = {
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [],
            httpFault: { status: 503 },
          };
          const forge = yield* forgeOnPath(bin, "gitlab", model);
          const COLLIE_FORGE_API = yield* serveForges(forge);
          const socket = `${world.home}/herdr.sock`;
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=forge-unavailable",
              "--input",
              "mr=",
              "--input",
              `file=${world.home}/fact`,
            ],
            {
              PATH: `${bin.dir}:/usr/bin:/bin`,
              COLLIE_FORGE_API,
              HERDR_SOCKET_PATH: socket,
              COLLIE_RECOVERY_EVERY: "100 millis",
            },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const runId = yield* idOf(started.envelope.data);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const file = yield* newsPath(world.state, yield* herdOf(socket).pipe(Effect.orDie));
          const failed = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.filter(lines, (line) => line.action === "rechecked" && line.outcome === "error")
                .length >= 4,
          );
          expect(Arr.filter(failed, (line) => line.action === "resumed")).toEqual([]);
          const news = yield* readNews(file);
          expect(
            Arr.filter(
              news,
              (line) => line.kind === "item" && Str.startsWith("recovery-failing:")(line.key),
            ),
          ).toHaveLength(1);
          expect(
            Arr.some(pending(news).items, (item) => Str.startsWith("recovery-failing:")(item.key)),
          ).toBe(true);
          yield* forge.set({
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [],
          });
          yield* (yield* FileSystem.FileSystem)
            .writeFileString(`${world.home}/fact`, "ready")
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          yield* until(
            () => readNews(file),
            (lines) =>
              !Arr.some(pending(lines).items, (item) =>
                Str.startsWith("recovery-failing:")(item.key),
              ),
          );
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "uncleared rechecks back off and the shared off setting still records checks",
  () =>
    proves(
      "collie-recovery-backoff-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${world.project}/dirty`, "waiting").pipe(Effect.orDie);
          const off = yield* collie(world, ["settings", "set", "recovery.resume", "false"], {
            COLLIE_RECOVERY_EVERY: "100 millis",
          });
          expect(off.envelope).toMatchObject({ ok: true });
          const started = yield* collie(world, [
            "run",
            "start",
            "rechecks",
            "--input",
            "cause=checkout-dirty-collie",
            "--input",
            "mr=",
            "--input",
            `file=${world.home}/fact`,
          ]);
          const runId = yield* idOf(started.envelope.data);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const lines = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) => Arr.filter(lines, (line) => line.action === "rechecked").length >= 3,
          );
          const reads = Arr.filter(lines, (line) => line.action === "rechecked");
          expect(Arr.map(reads.slice(0, 3), (line) => line.value)).toEqual([100, 200, 400]);
          expect(epochMs(reads[1]!.at) - epochMs(reads[0]!.at)).toBeGreaterThanOrEqual(200);
          expect(epochMs(reads[2]!.at) - epochMs(reads[1]!.at)).toBeGreaterThanOrEqual(400);
          yield* fs.remove(`${world.project}/dirty`).pipe(Effect.orDie);
          yield* fs.writeFileString(`${world.home}/fact`, "ready").pipe(Effect.orDie);
          yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(lines, (line) => line.action === "rechecked" && line.outcome === "cleared"),
          );
          expect(
            Arr.filter(
              yield* client.runMetrics({ runId }).pipe(Effect.orDie),
              (line) => line.action === "resumed",
            ),
          ).toEqual([]);
          const on = yield* collie(world, ["settings", "set", "recovery.resume", "true"]);
          expect(on.envelope).toMatchObject({ ok: true });
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "ten cleared parks wait for memory and at most two resumes are in flight",
  () =>
    proves(
      "collie-recovery-memory-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const proc = `${world.home}/proc`;
          yield* fs.makeDirectory(proc).pipe(Effect.orDie);
          yield* fs
            .writeFileString(`${proc}/meminfo`, "MemTotal: 1000000 kB\nMemAvailable: 1000 kB\n")
            .pipe(Effect.orDie);
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=checkout-dirty-collie",
              "--input",
              "mr=",
              "--input",
              `file=${world.home}/fact-0`,
            ],
            { COLLIE_RECOVERY_EVERY: "100 millis", COLLIE_PROC: proc },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const ids = [yield* idOf(started.envelope.data)];
          for (let i = 1; i < 10; i++)
            ids.push(
              (yield* client
                .start({
                  project: world.project,
                  id: "rechecks",
                  request: `start-${i}`,
                  input: {
                    cause: "checkout-dirty-collie",
                    mr: "",
                    file: `${world.home}/fact-${i}`,
                  },
                })
                .pipe(Effect.orDie)).runId,
            );
          for (const runId of ids)
            yield* until(
              () => client.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) => Arr.some(lines, (line) => line.action === "rechecked"),
            );
          for (const runId of ids)
            expect(
              Arr.filter(
                yield* client.runMetrics({ runId }).pipe(Effect.orDie),
                (line) => line.action === "resumed",
              ),
            ).toEqual([]);
          for (let i = 0; i < 10; i++)
            yield* fs.writeFileString(`${world.home}/fact-${i}`, "ready").pipe(Effect.orDie);
          yield* fs
            .writeFileString(`${proc}/meminfo`, "MemTotal: 1000000 kB\nMemAvailable: 500000 kB\n")
            .pipe(Effect.orDie);
          for (const runId of ids)
            yield* until(
              () => client.run({ runId }).pipe(Effect.orDie),
              (view) => view?.status.status === "complete",
            );
          const events: Array<{ at: string; delta: number }> = [];
          for (const runId of ids) {
            const lines = yield* until(
              () => client.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) =>
                Arr.some(lines, (line) => line.action === "resumed" && line.outcome === "resumed"),
            );
            const claims = Arr.filter(
              lines,
              (line) => line.action === "resumed" && line.outcome === "claimed",
            );
            const ends = Arr.filter(
              lines,
              (line) => line.action === "resumed" && line.outcome === "resumed",
            );
            expect(claims).toHaveLength(1);
            expect(ends).toHaveLength(1);
            events.push({ at: claims[0]!.at, delta: 1 }, { at: ends[0]!.at, delta: -1 });
          }
          let active = 0;
          let maximum = 0;
          for (const event of events.sort(
            (a, b) => Str.localeCompare(b.at)(a.at) || a.delta - b.delta,
          )) {
            active += event.delta;
            maximum = Math.max(maximum, active);
          }
          expect(maximum).toBeGreaterThan(0);
          expect(maximum).toBeLessThanOrEqual(2);
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "the fourth park needs you and names the three automatic tries",
  () =>
    proves(
      "collie-recovery-bound-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=checkout-dirty-collie",
              "--input",
              "mr=",
              "--input",
              `file=${world.home}/fact`,
            ],
            { COLLIE_RECOVERY_EVERY: "100 millis" },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const runId = yield* idOf(started.envelope.data);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.filter(lines, (line) => line.action === "resumed" && line.outcome === "resumed")
                .length >= 3,
          );
          const parked = yield* client.run({ runId }).pipe(Effect.orDie);
          expect(parked?.park?.kind).toBe("needs-you");
          expect(
            Arr.filter(parked?.park?.history ?? [], (line) => Str.includes("resumed")(line)),
          ).toHaveLength(3);
          const audit = Arr.filter(
            yield* readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
            (line) => line.operation === "resume",
          );
          expect(audit).toHaveLength(3);
          const shown = yield* collie(world, ["board"]);
          expect(asJson(shown.envelope.data)).toContain("rechecked");
          const notices = yield* (yield* FileSystem.FileSystem)
            .readFileString(`${world.state}/notified.${runId}`)
            .pipe(Effect.orDie);
          expect(
            Arr.filter(Str.split(notices, "\n"), (line) => Str.includes("parked:")(line)),
          ).toEqual(["needs-you:parked:checkout-dirty-collie"]);
          const report = yield* collie(world, ["run", "report"]);
          expect(report.envelope.data).toMatchObject({
            measures: {
              recoveries: {
                byCause: expect.arrayContaining([
                  {
                    cause: "checkout-dirty-collie",
                    action: "resumed",
                    count: 3,
                    runs: [runId],
                    recovered: 0,
                    falseRecoveries: 3,
                    toRecover: null,
                  },
                ]),
              },
            },
          });
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

for (const point of ["claimed", "recovery-park-cleared", "recovery-entered"] as const)
  test(
    `a host killed at ${point} completes the same resume on restart`,
    () =>
      proves(
        "collie-recovery-crash-",
        (world) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.writeFileString(`${world.project}/dirty`, "waiting").pipe(Effect.orDie);
            const extra = {
              COLLIE_RECOVERY_EVERY: "250 millis",
              ...(point === "claimed"
                ? { COLLIE_RECOVERY_CRASH_AT: point }
                : { COLLIE_HOST_CRASH_AT: point }),
            };
            const started = yield* collie(
              world,
              [
                "run",
                "start",
                "rechecks",
                "--input",
                "cause=checkout-dirty-collie",
                "--input",
                "mr=",
                "--input",
                `file=${world.home}/fact`,
              ],
              extra,
            );
            expect(started.envelope).toMatchObject({ ok: true });
            const runId = yield* idOf(started.envelope.data);
            const client = yield* connect(world.state).pipe(Effect.orDie);
            yield* until(
              () => client.run({ runId }).pipe(Effect.orDie),
              (view) => view?.parked !== null,
            );
            yield* fs.writeFileString(`${world.home}/fact`, "ready").pipe(Effect.orDie);
            yield* fs.remove(`${world.project}/dirty`).pipe(Effect.orDie);
            yield* until(
              () =>
                ownerOf(world.state).pipe(
                  Effect.flatMap((owner) =>
                    owner === null ? Effect.succeed(false) : holderLives(owner),
                  ),
                ),
              (alive) => !alive,
            );
            const restarted = yield* collie(world, ["run", "show", runId], {
              COLLIE_RECOVERY_EVERY: "250 millis",
            });
            expect(restarted.envelope.ok).toBe(true);
            const again = yield* connect(world.state).pipe(Effect.orDie);
            const done = yield* until(
              () => again.run({ runId }).pipe(Effect.orDie),
              (view) => view?.status.status === "complete",
            );
            expect(done?.status.status).toBe("complete");
            const lines = yield* again.runMetrics({ runId }).pipe(Effect.orDie);
            const claims = Arr.filter(
              lines,
              (line) => line.action === "resumed" && line.outcome === "claimed",
            );
            expect(claims).toHaveLength(1);
            const reconciled = yield* until(
              () => again.runMetrics({ runId }).pipe(Effect.orDie),
              (lines) =>
                Arr.some(lines, (line) => line.action === "resumed" && line.outcome !== "claimed"),
            );
            expect(
              Arr.filter(
                reconciled,
                (line) => line.action === "resumed" && line.outcome !== "claimed",
              ),
            ).toEqual([
              expect.objectContaining({ recoveryId: claims[0]?.recoveryId, outcome: "resumed" }),
            ]);
            const audit = yield* until(
              () => readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
              (lines) => Arr.filter(lines, (line) => line.operation === "resume").length === 1,
            );
            expect(Arr.filter(audit, (line) => line.operation === "resume")[0]?.request).toBe(
              claims[0]?.recoveryId,
            );
          }),
        ["rechecks.workflow.ts"],
      ),
    120_000,
  );

test(
  "a CI park waits for its job at the parked head and records the recheck on its card",
  () =>
    proves(
      "collie-recovery-ci-",
      (world) =>
        Effect.gen(function* () {
          yield* exec(
            [
              "git",
              "-c",
              "user.name=t",
              "-c",
              "user.email=t@example.test",
              "commit",
              "-qm",
              "initial",
              "--allow-empty",
            ],
            { cwd: world.project },
          );
          const head = Str.trim(
            (yield* exec(["git", "rev-parse", "HEAD"], { cwd: world.project })).stdout,
          );
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const model = {
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [
              {
                project: "gitlab.example.com/mk/project",
                iid: "7",
                state: "open" as const,
                head,
                jobs: [],
              },
              {
                project: "gitlab.example.com/mk/project",
                iid: "8",
                state: "open" as const,
                head,
                jobs: [],
              },
            ],
          };
          const forge = yield* forgeOnPath(bin, "gitlab", model);
          const COLLIE_FORGE_API = yield* serveForges(forge);
          yield* collie(world, ["board"], {
            PATH: `${bin.dir}:/usr/bin:/bin`,
            COLLIE_FORGE_API,
            COLLIE_RECOVERY_EVERY: "250 millis",
          });
          yield* Effect.sleep("200 millis");
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=ci-job-absent",
              "--input",
              `file=${world.home}/fact`,
              "--input",
              "mr=https://gitlab.example.com/mk/project/-/merge_requests/7",
              "--verify",
              asJson({ name: "check", executable: "bun", argv: ["test"], cwd: ".", ci: "test" }),
            ],
            {
              PATH: `${bin.dir}:/usr/bin:/bin`,
              COLLIE_FORGE_API,
              COLLIE_RECOVERY_EVERY: "250 millis",
            },
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const runId = yield* idOf(started.envelope.data);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.filter(lines, (line) => line.action === "rechecked" && line.value === 250)
                .length >= 2,
          );
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.status.status).toBe(
            "suspended",
          );
          const other = yield* client
            .start({
              project: world.project,
              id: "rechecks",
              request: "stays-parked",
              input: {
                cause: "ci-job-absent",
                file: `${world.home}/other`,
                mr: "https://gitlab.example.com/mk/project/-/merge_requests/8",
              },
              verify: [{ name: "check", executable: "bun", argv: ["test"], cwd: ".", ci: "test" }],
            })
            .pipe(Effect.orDie);
          const otherReads = yield* until(
            () => client.runMetrics({ runId: other.runId }).pipe(Effect.orDie),
            (lines) => Arr.some(lines, (line) => line.action === "rechecked" && line.value > 250),
          );
          expect(Arr.filter(otherReads, (line) => line.action === "resumed")).toEqual([]);
          yield* forge.set({
            ...model,
            mrs: [{ ...model.mrs[0]!, jobs: [{ name: "test", state: "passed" }] }, model.mrs[1]!],
          });
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toEqual({ status: "complete", value: "CI gate passed" });
          const metrics = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(lines, (line) => line.action === "resumed" && line.outcome === "resumed"),
          );
          expect(metrics).toContainEqual(
            expect.objectContaining({
              cause: "ci-job-absent",
              action: "rechecked",
              outcome: "cleared",
              note: expect.stringContaining("test"),
            }),
          );
          expect(metrics).toContainEqual(
            expect.objectContaining({ action: "resumed", outcome: "resumed" }),
          );
          const audit = Arr.filter(
            yield* readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
            (line) => line.operation === "resume",
          );
          expect(audit).toHaveLength(1);
          expect(audit[0]?.actor.origin).toBe("host");
          const card = yield* collie(world, ["board"]);
          expect(asJson(card.envelope.data)).toContain("rechecked");
          expect(asJson(card.envelope.data)).toContain("resumed");
          const report = yield* collie(world, ["run", "report"]);
          expect(report.envelope.data).toMatchObject({
            measures: {
              recoveries: {
                byCause: expect.arrayContaining([
                  {
                    cause: "ci-job-absent",
                    action: "resumed",
                    count: 1,
                    runs: [runId],
                    recovered: 1,
                    falseRecoveries: 0,
                    toRecover: expect.any(Number),
                  },
                ]),
              },
            },
          });
          expect(
            (yield* client.run({ runId: other.runId }).pipe(Effect.orDie))?.status.status,
          ).toBe("suspended");
          expect(
            Arr.filter(
              yield* client.runMetrics({ runId: other.runId }).pipe(Effect.orDie),
              (line) => line.action === "resumed",
            ),
          ).toEqual([]);
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

test(
  "a red pipeline park is rechecked at the head that failed and resumed by the host once the forge moves on, with no Heal",
  () =>
    proves(
      "collie-recovery-red-",
      (world) =>
        Effect.gen(function* () {
          yield* exec(
            [
              "git",
              "-c",
              "user.name=t",
              "-c",
              "user.email=t@example.test",
              "commit",
              "-qm",
              "initial",
              "--allow-empty",
            ],
            { cwd: world.project },
          );
          const head = Str.trim(
            (yield* exec(["git", "rev-parse", "HEAD"], { cwd: world.project })).stdout,
          );
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${world.home}/bin`), (bin) =>
            bin.restore(),
          );
          const red = {
            project: "gitlab.example.com/mk/project",
            iid: "7",
            state: "open" as const,
            head,
            checks: [{ name: "test", state: "failed" as const }],
          };
          const model = {
            installed: true,
            loggedIn: ["gitlab.example.com"],
            login: "me",
            mrs: [red],
          };
          const forge = yield* forgeOnPath(bin, "gitlab", model);
          const env = {
            PATH: `${bin.dir}:/usr/bin:/bin`,
            COLLIE_FORGE_API: yield* serveForges(forge),
            COLLIE_RECOVERY_EVERY: "250 millis",
          };
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "rechecks",
              "--input",
              "cause=ci-failed",
              "--input",
              `file=${world.home}/fact`,
              "--input",
              "mr=https://gitlab.example.com/mk/project/-/merge_requests/7",
            ],
            env,
          );
          expect(started.envelope).toMatchObject({ ok: true });
          const runId = yield* idOf(started.envelope.data);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const healed = (lines: ReadonlyArray<{ readonly action?: string }>) =>
            Arr.filter(lines, (line) => line.action === "healed");
          const rechecked = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.filter(
                lines,
                (line) => line.action === "rechecked" && line.outcome === "uncleared",
              ).length >= 2,
          );
          expect(healed(rechecked)).toEqual([]);
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.park?.cause).toBe("ci-failed");
          yield* forge.set({
            ...model,
            mrs: [
              {
                ...red,
                head: pipe("c", Str.repeat(40)),
                checks: [{ name: "test", state: "passed" }],
              },
            ],
          });
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toEqual({ status: "complete", value: "CI no longer failed" });
          expect(done?.parked).toBeNull();
          const metrics = yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) =>
              Arr.some(lines, (line) => line.action === "resumed" && line.outcome === "resumed"),
          );
          expect(metrics).toContainEqual(
            expect.objectContaining({
              cause: "ci-failed",
              action: "rechecked",
              outcome: "cleared",
            }),
          );
          expect(healed(metrics)).toEqual([]);
          const resumes = Arr.filter(
            yield* readAudit(`${world.state}/runs/${runId}`).pipe(Effect.orDie),
            (line) => line.operation === "resume",
          );
          expect(Arr.map(resumes, (line) => line.actor.origin)).toEqual(["host"]);
        }),
      ["rechecks.workflow.ts"],
    ),
  120_000,
);

const RED_MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;
const RED_HEAD = pipe("a", Str.repeat(40));

/** The `ci-failed` recheck of a park whose pipeline failed at `RED_HEAD`, the forge as `now` says. */
const failedCiRecheck = (now: Partial<FakeMr>, { recorded = true, unreadable = false } = {}) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ci-failed-" });
      const forge = fakeForge("gitlab", {
        installed: true,
        loggedIn: [FORGE_HOST.gitlab],
        login: "me",
        mrs: [{ project: PROJECT.gitlab, iid: "31", state: "open", head: RED_HEAD, ...now }],
        ...(unreadable && { httpFault: { status: 503 } }),
      });
      if (recorded)
        yield* rememberFailedCi(`${root}/runs/r1`, {
          head: RED_HEAD,
          name: "build",
          mr: RED_MR,
          cwd: root,
        });
      return yield* recheckPark(
        {
          runId: "r1",
          cwd: root,
          branch: "feature",
          mr: RED_MR,
          park: { cause: "ci-failed", kind: "rechecks" },
        },
        root,
        { sessionList: () => Effect.die("CI rechecks must not ask herdr") },
      ).pipe(Effect.provide(forge.layer));
    }),
  );

const RED = [{ name: "build", state: "failed" }] as const;
const PASSED = [{ name: "build", state: "passed" }] as const;

test("a ci-failed park clears once the forge shows another head", () =>
  failedCiRecheck({ head: pipe("b", Str.repeat(40)), checks: RED }).then((said) =>
    expect(said).toMatchObject({ cleared: true, error: false }),
  ));

test("a ci-failed park clears once the pipeline at its head no longer failed", () =>
  failedCiRecheck({ checks: PASSED }).then((said) =>
    expect(said).toMatchObject({ cleared: true, error: false }),
  ));

test("a ci-failed park clears once its merge request is merged", () =>
  failedCiRecheck({ state: "merged", checks: RED }).then((said) =>
    expect(said).toMatchObject({ cleared: true, error: false }),
  ));

test("a ci-failed park stays while its head's pipeline is still failed", () =>
  failedCiRecheck({ checks: RED }).then((said) =>
    expect(said).toMatchObject({ cleared: false, error: false }),
  ));

test("a ci-failed recheck that cannot read the forge is an error", () =>
  failedCiRecheck({ checks: RED }, { unreadable: true }).then((said) =>
    expect(said).toMatchObject({ cleared: false, error: true }),
  ));

test("a ci-failed park with no failed head recorded stays, saying so", () =>
  failedCiRecheck({ checks: PASSED }, { recorded: false }).then((said) =>
    expect(said).toMatchObject({
      cleared: false,
      error: false,
      note: expect.stringContaining("no failed pipeline recorded"),
    }),
  ));
