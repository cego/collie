import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Schema, flow, Result } from "effect";
import { connect, frontDoor, ownerOf, socketOf } from "../src/host";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import { Database } from "bun:sqlite";
import type { Metric } from "../src/metrics";
import { stopHost, until } from "./support/host";
import { readAudit } from "../src/audit";
import { recordsReadLayer } from "../src/records";
import { NOTIFIED, RunRecords } from "../src/run-records";
import { FakeBin } from "./support/bin";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  forgeHttpOnPath,
  forgeOnPath,
  serveForges,
} from "./support/forge";
import type { FakeMr } from "./support/forge";
import { exec } from "./support/command";
import { holderLives } from "../src/lock";
import { herdOf } from "../src/steering";
import { newsPath, pending, read as readNews } from "../src/news";
import { epochMs } from "../src/time";
import { CommandLine } from "effect/process";
import { pipe } from "effect/Function";
import { runEffect } from "./support/effect";
import {
  recheckPark,
  rememberFailedCi,
  rememberNotQuiet,
  rememberStaleHandOver,
  rememberUnsettled,
} from "../src/park-recheck";
import { appendLine } from "../src/steering";
import { writeEvent } from "../src/compactors";
import { controlDir } from "../src/compaction";
import { processOf, startedOf } from "../src/processes";
import { SURVIVES_HANGUP, paneTree } from "./support/pane-tree";

const idOf = flow(
  Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String })),
  Effect.map((one) => one.runId),
  Effect.orDie,
);
const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const quote = (word: string) => Result.getOrThrow(CommandLine.quote(word));

test("a clean checkout whose head origin does not carry stays parked, and resumes by itself once it is pushed", () =>
  proves(
    "collie-recovery-clean-",
    (world) =>
      Effect.gen(function* () {
        const git = (...args: Array<string>) => exec(["git", ...args], { cwd: world.project });
        const commit = (...args: Array<string>) =>
          git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", ...args);
        yield* commit("initial", "--allow-empty");
        const origin = `${world.home}/origin.git`;
        yield* git("init", "-q", "--bare", origin);
        const branch = Str.trim((yield* git("rev-parse", "--abbrev-ref", "HEAD")).stdout);
        yield* git("remote", "add", "origin", origin);
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        yield* commit("unpushed", "--allow-empty");
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
        const rechecked = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) => Arr.some(lines, (line) => line.action === "rechecked"),
        );
        expect(
          Arr.map(
            Arr.filter(rechecked, (line) => line.action === "rechecked"),
            (line) => line.outcome,
          )[0],
        ).toBe("uncleared");
        expect(Arr.some(rechecked, (line) => line.action === "resumed")).toBe(false);
        const seen = () => client.runMetrics({ runId }).pipe(Effect.orDie);
        const before = (yield* seen()).length;
        yield* git("remote", "set-url", "origin", `${world.home}/gone.git`);
        const unread = yield* until(
          seen,
          (lines) =>
            Arr.filter(lines, (line) => line.action === "rechecked").length >=
            Arr.filter(rechecked, (line) => line.action === "rechecked").length + 2,
        );
        const fresh = Arr.drop(unread, before);
        expect(
          Arr.some(
            Arr.filter(fresh, (line) => line.action === "rechecked"),
            (line) => line.outcome === "error" || line.outcome === "uncleared",
          ),
        ).toBe(true);
        expect(Arr.some(fresh, (line) => line.outcome === "cleared")).toBe(false);
        expect(Arr.some(fresh, (line) => line.action === "resumed")).toBe(false);
        yield* git("remote", "set-url", "origin", origin);
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${world.home}/fact`, "ready")
          .pipe(Effect.orDie);
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status.status).toBe("complete");
        const audit = yield* until(
          () =>
            readAudit(`${world.state}/runs/${runId}`).pipe(
              Effect.provide(recordsReadLayer(world.state)),
              Effect.orDie,
            ),
          (lines) => Arr.some(lines, (line) => line.operation === "resume"),
        );
        const resumes = Arr.filter(audit, (line) => line.operation === "resume");
        expect(resumes).toHaveLength(1);
        expect(resumes[0]).toMatchObject({
          request: expect.stringMatching(/^recover:/),
          actor: { origin: "host" },
        });
        const healed = yield* client.runMetrics({ runId }).pipe(Effect.orDie);
        expect(Arr.filter(healed, (line) => line.action === "healed")).toEqual([]);
      }),
    ["rechecks.workflow.ts"],
  ));

test("a checkout park does not clear while origin's branch it was pushed to is gone", () =>
  proves(
    "collie-recovery-pruned-",
    (world) =>
      Effect.gen(function* () {
        const git = (...args: Array<string>) => exec(["git", ...args], { cwd: world.project });
        const commit = (...args: Array<string>) =>
          git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", ...args);
        yield* commit("initial", "--allow-empty");
        const origin = `${world.home}/origin.git`;
        yield* git("init", "-q", "--bare", origin);
        const branch = Str.trim((yield* git("rev-parse", "--abbrev-ref", "HEAD")).stdout);
        yield* git("remote", "add", "origin", origin);
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
          { COLLIE_RECOVERY_EVERY: "2 seconds" },
        );
        expect(started.envelope).toMatchObject({ ok: true });
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
        const runId = runs[0]!.runId;
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.parked !== null,
        );
        // WARNING: the branch is pushed and then deleted at origin, so this checkout's remote ref is a lie.
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        yield* git("--git-dir", origin, "update-ref", "-d", `refs/heads/${branch}`);
        const rechecked = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) => Arr.filter(lines, (line) => line.action === "rechecked").length >= 2,
        );
        expect(Arr.some(rechecked, (line) => line.outcome === "cleared")).toBe(false);
        expect(Arr.some(rechecked, (line) => line.action === "resumed")).toBe(false);
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${world.home}/fact`, "ready")
          .pipe(Effect.orDie);
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status.status).toBe("complete");
      }),
    ["rechecks.workflow.ts"],
  ));

test("a checkout park does not clear on a remote-tracking ref this checkout's fetch never maps", () =>
  proves(
    "collie-recovery-unmapped-",
    (world) =>
      Effect.gen(function* () {
        const git = (...args: Array<string>) => exec(["git", ...args], { cwd: world.project });
        const commit = (...args: Array<string>) =>
          git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", ...args);
        yield* commit("initial", "--allow-empty");
        const origin = `${world.home}/origin.git`;
        yield* git("init", "-q", "--bare", origin);
        const branch = Str.trim((yield* git("rev-parse", "--abbrev-ref", "HEAD")).stdout);
        yield* git("remote", "add", "origin", origin);
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
          { COLLIE_RECOVERY_EVERY: "2 seconds" },
        );
        expect(started.envelope).toMatchObject({ ok: true });
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
        const runId = runs[0]!.runId;
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.parked !== null,
        );
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        yield* git("fetch", "-q", "origin");
        yield* git("push", "-q", "origin", `HEAD:refs/heads/other`);
        // WARNING: the fetch is narrowed after that ref exists, so --prune can no longer drop it.
        yield* git("config", "remote.origin.fetch", "+refs/heads/other:refs/remotes/origin/other");
        yield* git("--git-dir", origin, "update-ref", "-d", `refs/heads/${branch}`);
        const rechecked = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) => Arr.filter(lines, (line) => line.action === "rechecked").length >= 2,
        );
        expect(Arr.some(rechecked, (line) => line.outcome === "cleared")).toBe(false);
        expect(Arr.some(rechecked, (line) => line.action === "resumed")).toBe(false);
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${world.home}/fact`, "ready")
          .pipe(Effect.orDie);
        yield* git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status.status).toBe("complete");
      }),
    ["rechecks.workflow.ts"],
  ));

test("an automatically resumed mr Step repeats neither its push nor its merge request", () =>
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
        expect(Str.trim(yield* fs.readFileString(effects).pipe(Effect.orDie))).toBe("push\nopened");
        expect((yield* forge.model()).mrs).toHaveLength(1);
        expect(yield* client.launches({ run: runId }).pipe(Effect.orDie)).toHaveLength(1);
      }),
    ["recover-mr.workflow.ts"],
  ));

test("a core park stays parked while core cannot list its agents, though it answers, and resumes once it can", () =>
  proves(
    "collie-recovery-core-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        core.refuse("terminal.list", "server_not_running", "core cannot list its terminals");
        const on = yield* collie(world, ["settings", "set", "recovery.resume", "true"], {
          COLLIE_RECOVERY_EVERY: "100 millis",
        });
        expect(on.envelope).toMatchObject({ ok: true });
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const { runId } = yield* client
          .start({
            project: world.project,
            id: "rechecks",
            request: "start",
            input: { cause: "herdr-unavailable", mr: "", file: `${world.home}/fact` },
          })
          .pipe(Effect.orDie);
        const rechecked = <L extends { readonly action?: string }>(lines: ReadonlyArray<L>) =>
          Arr.filter(lines, (line) => line.action === "rechecked");
        const down5 = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) =>
            rechecked(lines).length >= 5 || Arr.some(lines, (line) => line.action === "resumed"),
        );
        for (const line of rechecked(down5)) {
          expect(line.outcome).not.toBe("cleared");
          expect(line.note).toContain("core cannot list its terminals");
        }
        expect(Arr.some(down5, (line) => line.action === "resumed")).toBe(false);
        expect(
          Arr.filter(
            yield* client.runs({ task: null }).pipe(Effect.orDie),
            (view) => view.heals !== undefined,
          ),
        ).toEqual([]);
        yield* fs.writeFileString(`${world.home}/fact`, "ready").pipe(Effect.orDie);
        core.restore("terminal.list");
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        const lines = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) =>
            Arr.some(lines, (line) => line.action === "resumed" && line.outcome === "resumed"),
        );
        expect(
          Arr.map(
            Arr.filter(lines, (line) => line.action === "resumed"),
            (line) => line.outcome,
          ),
        ).toEqual(["claimed", "resumed"]);
      }),
    ["rechecks.workflow.ts", "mender.workflow.ts"],
  ));

test("clearing rechecks never answer Decisions, release Holds or Stops, or resume superseded work", () =>
  proves(
    "collie-recovery-human-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs
          .writeFileString(outputs, asJson([{ verdict: "done" }, { verdict: "done" }]))
          .pipe(Effect.orDie);
        const off = yield* collie(world, ["settings", "set", "recovery.resume", "false"], {
          COLLIE_RECOVERY_EVERY: "100 millis",
          COLLIE_HOST_SUPERSEDE_GRACE_MS: "600000",
        });
        expect(off.envelope).toMatchObject({ ok: true });
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const ids: Array<string> = [];
        for (const kind of ["hold", "stop", "decision", "superseded", "free"]) {
          const file = `${world.home}/${kind}`;
          if (kind === "decision" || kind === "superseded") {
            yield* fs.writeFileString(file, "decision").pipe(Effect.orDie);
          }
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "rechecks",
              request: kind,
              input: { cause: "herdr-unavailable", file, mr: "" },
            })
            .pipe(Effect.orDie);
          ids.push(runId);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "suspended" && view.parked !== null,
          );
          if (kind === "hold" || kind === "stop") {
            yield* client
              .control({ runId, control: kind, set: true, request: `control-${kind}` })
              .pipe(Effect.orDie);
          }
          if (kind === "superseded") {
            const [launch] = yield* client.launches({ run: runId }).pipe(Effect.orDie);
            core.reportedOnly([launch!.agent]);
            yield* core.report(launch!.agent, "working");
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
              yield* readAudit(`${world.state}/runs/${runId}`).pipe(
                Effect.provide(recordsReadLayer(world.state)),
                Effect.orDie,
              ),
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
  ));

test("three failed recheck rounds raise one News item which a successful round clears", () =>
  proves(
    "collie-recovery-failing-",
    (world, core) =>
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
            HC_SOCKET: core.socketPath,
            COLLIE_RECOVERY_EVERY: "100 millis",
          },
        );
        expect(started.envelope).toMatchObject({ ok: true });
        const runId = yield* idOf(started.envelope.data);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const file = yield* newsPath(
          world.state,
          yield* herdOf(core.socketPath).pipe(Effect.orDie),
        );
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
  ));

test("uncleared rechecks back off and the shared off setting still records checks", () =>
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
          "cause=herdr-unavailable",
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
  ));

test("ten cleared parks wait for memory and at most two resumes are in flight", () =>
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
            "cause=herdr-unavailable",
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
        for (let i = 1; i < 10; i++) {
          ids.push(
            (yield* client
              .start({
                project: world.project,
                id: "rechecks",
                request: `start-${i}`,
                input: {
                  cause: "herdr-unavailable",
                  mr: "",
                  file: `${world.home}/fact-${i}`,
                },
              })
              .pipe(Effect.orDie)).runId,
          );
        }
        for (const runId of ids) {
          yield* until(
            () => client.runMetrics({ runId }).pipe(Effect.orDie),
            (lines) => Arr.some(lines, (line) => line.action === "rechecked"),
          );
        }
        for (const runId of ids) {
          expect(
            Arr.filter(
              yield* client.runMetrics({ runId }).pipe(Effect.orDie),
              (line) => line.action === "resumed",
            ),
          ).toEqual([]);
        }
        for (let i = 0; i < 10; i++) {
          yield* fs.writeFileString(`${world.home}/fact-${i}`, "ready").pipe(Effect.orDie);
        }
        yield* fs
          .writeFileString(`${proc}/meminfo`, "MemTotal: 1000000 kB\nMemAvailable: 500000 kB\n")
          .pipe(Effect.orDie);
        for (const runId of ids) {
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
        }
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
  ));

test("the fourth park needs you and names the three automatic tries", () =>
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
            "cause=herdr-unavailable",
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
          yield* readAudit(`${world.state}/runs/${runId}`).pipe(
            Effect.provide(recordsReadLayer(world.state)),
            Effect.orDie,
          ),
          (line) => line.operation === "resume",
        );
        expect(audit).toHaveLength(3);
        const shown = yield* collie(world, ["board"]);
        expect(asJson(shown.envelope.data)).toContain("rechecked");
        const notices = yield* RunRecords.use((records) =>
          records.controlsOf(NOTIFIED, runId),
        ).pipe(Effect.provide(recordsReadLayer(world.state)), Effect.orDie);
        expect(
          Arr.filter(
            Arr.map(notices, (row) => row.key),
            (line) => Str.includes("parked:")(line),
          ),
        ).toEqual(["needs-you:parked:herdr-unavailable"]);
        const report = yield* collie(world, ["run", "report"]);
        expect(report.envelope.data).toMatchObject({
          measures: {
            recoveries: {
              byCause: expect.arrayContaining([
                {
                  cause: "herdr-unavailable",
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
  ));

for (const point of ["claimed", "recovery-park-cleared", "recovery-entered"] as const) {
  test(`a host killed at ${point} completes the same resume on restart`, () =>
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
              "cause=herdr-unavailable",
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
            () =>
              readAudit(`${world.state}/runs/${runId}`).pipe(
                Effect.provide(recordsReadLayer(world.state)),
                Effect.orDie,
              ),
            (lines) => Arr.filter(lines, (line) => line.operation === "resume").length === 1,
          );
          expect(Arr.filter(audit, (line) => line.operation === "resume")[0]?.request).toBe(
            claims[0]?.recoveryId,
          );
        }),
      ["rechecks.workflow.ts"],
    ));
}

test("a CI park waits for its job at the parked head and records the recheck on its card", () =>
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
            Arr.filter(lines, (line) => line.action === "rechecked" && line.value === 250).length >=
            2,
        );
        expect((yield* client.run({ runId }).pipe(Effect.orDie))?.status.status).toBe("suspended");
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
          yield* readAudit(`${world.state}/runs/${runId}`).pipe(
            Effect.provide(recordsReadLayer(world.state)),
            Effect.orDie,
          ),
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
        expect((yield* client.run({ runId: other.runId }).pipe(Effect.orDie))?.status.status).toBe(
          "suspended",
        );
        expect(
          Arr.filter(
            yield* client.runMetrics({ runId: other.runId }).pipe(Effect.orDie),
            (line) => line.action === "resumed",
          ),
        ).toEqual([]);
      }),
    ["rechecks.workflow.ts"],
  ));

test("a target-red park waits for the target branch's job, starts no Heal, and resumes once it passed", () =>
  proves(
    "collie-recovery-target-",
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
        const tip = Str.repeat(40)("c");
        const mr = (state: "failed" | "pending" | "passed") => ({
          project: "gitlab.example.com/mk/project",
          iid: "7",
          state: "open" as const,
          head,
          targetBranch: "main",
          jobs: state === "passed" ? [{ name: "test", state: "passed" as const }] : [],
          target: { at: tip, jobs: [{ name: "test", state }] },
        });
        const model = { installed: true, loggedIn: ["gitlab.example.com"], login: "me" };
        const forge = yield* forgeOnPath(bin, "gitlab", { ...model, mrs: [mr("failed")] });
        const COLLIE_FORGE_API = yield* serveForges(forge);
        const env = {
          PATH: `${bin.dir}:/usr/bin:/bin`,
          COLLIE_FORGE_API,
          COLLIE_RECOVERY_EVERY: "100 millis",
        };
        yield* collie(world, ["board"], env);
        const started = yield* collie(
          world,
          [
            "run",
            "start",
            "rechecks",
            "--input",
            "cause=target-red",
            "--input",
            `file=${world.home}/fact`,
            "--input",
            "mr=https://gitlab.example.com/mk/project/-/merge_requests/7",
            "--verify",
            asJson({ name: "check", executable: "bun", argv: ["test"], cwd: ".", ci: "test" }),
          ],
          env,
        );
        expect(started.envelope).toMatchObject({ ok: true });
        const runId = yield* idOf(started.envelope.data);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const uncleared = (lines: ReadonlyArray<{ action?: string; outcome?: string }>) =>
          Arr.filter(lines, (line) => line.action === "rechecked" && line.outcome === "uncleared")
            .length;
        const red = yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) => uncleared(lines) >= 2,
        );
        yield* forge.set({ ...model, mrs: [mr("pending")] });
        yield* until(
          () => client.runMetrics({ runId }).pipe(Effect.orDie),
          (lines) => uncleared(lines) >= uncleared(red) + 2,
        );
        const parked = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(parked?.status.status).toBe("suspended");
        expect(parked?.park).toMatchObject({ cause: "target-red", kind: "rechecks" });
        yield* forge.set({ ...model, mrs: [mr("passed")] });
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({ status: "complete", value: "CI gate passed" });
        const metrics = yield* client.runMetrics({ runId }).pipe(Effect.orDie);
        expect(metrics).toContainEqual(
          expect.objectContaining({
            cause: "target-red",
            action: "rechecked",
            outcome: "cleared",
          }),
        );
        expect(Arr.filter(metrics, (line) => line.action === "healed")).toEqual([]);
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toHaveLength(1);
      }),
    ["rechecks.workflow.ts"],
  ));

test("a red pipeline park is rechecked at the head that failed and resumed by the host once the forge moves on, with no Heal", () =>
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
            Arr.filter(lines, (line) => line.action === "rechecked" && line.outcome === "uncleared")
              .length >= 2,
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
          yield* readAudit(`${world.state}/runs/${runId}`).pipe(
            Effect.provide(recordsReadLayer(world.state)),
            Effect.orDie,
          ),
          (line) => line.operation === "resume",
        );
        expect(Arr.map(resumes, (line) => line.actor.origin)).toEqual(["host"]);
      }),
    ["rechecks.workflow.ts"],
  ));

const RED_MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;
const RED_HEAD = pipe("a", Str.repeat(40));

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
      if (recorded) {
        yield* rememberFailedCi(`${root}/runs/r1`, {
          head: RED_HEAD,
          name: "build",
          mr: RED_MR,
          cwd: root,
        });
      }
      return yield* recheckPark(
        {
          runId: "r1",
          cwd: root,
          branch: "feature",
          mr: RED_MR,
          park: { cause: "ci-failed", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("CI rechecks must not ask core") },
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

test("a delivery-unsettled park clears once the agent's submit hook records the delivery it waits on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-unsettled-" });
      yield* appendLine({
        id: "r1-q-steer-1",
        at: "2026-11-20T10:00:00Z",
        run: "r1",
        incarnation: "term-1",
        agent: "r1-review",
        causal_key: "answer-question",
        request_id: "r1-q-steer",
        cause: { kind: "steer", ref: "q" },
        mode: "now",
        text_hash: "the-answer",
        intent_version: 0,
        attempt: 1,
        state: "unknown",
      });
      yield* rememberUnsettled(`${root}/runs/r1`, { terminal: "term-1", delivery: "r1-q-steer-1" });
      const recheck = () =>
        recheckPark(
          {
            runId: "r1",
            cwd: root,
            branch: null,
            mr: null,
            park: { cause: "delivery-unsettled", kind: "rechecks" },
          },
          root,
          { agentList: () => Effect.die("a delivery's recheck asks core nothing") },
        );

      expect(yield* recheck()).toEqual({
        cleared: false,
        note: "delivery r1-q-steer-1 is unknown",
        error: false,
      });

      yield* writeEvent(yield* controlDir(root, "r1-review"), {
        session: null,
        kind: "submit",
        reason: "collie",
        delivery: "r1-q-steer-1",
        body: "the-answer",
        incarnation: "term-1",
      });

      expect(yield* recheck()).toEqual({
        cleared: true,
        note: "delivery r1-q-steer-1 is acknowledged",
        error: false,
      });
    }).pipe(Effect.scoped, Effect.provide(forgeHttpOnPath)),
  ));

const unsettledRecheck = (root: string) =>
  recheckPark(
    {
      runId: "r1",
      cwd: root,
      branch: null,
      mr: null,
      park: { cause: "delivery-unsettled", kind: "rechecks" },
    },
    root,
    { agentList: () => Effect.die("a delivery's recheck asks core nothing") },
  );

const heldUnknown = (root: string) =>
  Effect.gen(function* () {
    yield* appendLine({
      id: "r1-q-steer-1",
      at: "2026-11-20T10:00:00Z",
      run: "r1",
      incarnation: "term-1",
      agent: "r1-review",
      causal_key: "answer-question",
      request_id: "r1-q-steer",
      cause: { kind: "steer", ref: "q" },
      mode: "now",
      text_hash: "the-answer",
      intent_version: 0,
      attempt: 1,
      state: "unknown",
    });
    yield* rememberUnsettled(`${root}/runs/r1`, { terminal: "term-1", delivery: "r1-q-steer-1" });
  });

const submit = (
  root: string,
  event: { session: string; delivery: string; incarnation: string | null },
) =>
  Effect.gen(function* () {
    yield* writeEvent(yield* controlDir(root, "r1-review"), {
      session: event.session,
      kind: "submit",
      reason: "collie",
      delivery: event.delivery,
      body: "the-answer",
      incarnation: event.incarnation,
    });
  });

test("a delivery-unsettled park settles only on its own delivery and incarnation, even after the agent rebinds its session", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-unsettled-rebind-" });
      yield* heldUnknown(root);
      yield* submit(root, { session: "s1", delivery: "r1-q-steer-2", incarnation: "term-1" });
      yield* submit(root, { session: "s1", delivery: "r1-q-steer-1", incarnation: "term-9" });
      expect(yield* unsettledRecheck(root)).toEqual({
        cleared: false,
        note: "delivery r1-q-steer-1 is unknown",
        error: false,
      });
      yield* submit(root, { session: "s1", delivery: "r1-q-steer-1", incarnation: "term-1" });
      yield* submit(root, { session: "s2", delivery: "r1-q-steer-3", incarnation: "term-2" });
      expect(yield* unsettledRecheck(root)).toEqual({
        cleared: true,
        note: "delivery r1-q-steer-1 is acknowledged",
        error: false,
      });
      expect(yield* unsettledRecheck(root)).toEqual({
        cleared: true,
        note: "delivery r1-q-steer-1 is acknowledged",
        error: false,
      });
    }).pipe(Effect.scoped, Effect.provide(forgeHttpOnPath)),
  ));

test("a checkout park does not clear on a tracked edit git status was told to hide", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outer = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hidden-edit-" });
      const root = `${outer}/checkout`;
      yield* fs.makeDirectory(root, { recursive: true });
      const git = (...args: Array<string>) => exec(["git", ...args], { cwd: root });
      const commit = (...args: Array<string>) =>
        git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", ...args);
      yield* git("init", "-q", "-b", "main");
      yield* commit("initial", "--allow-empty");
      yield* fs.writeFileString(`${root}/one.ts`, "one\n");
      yield* git("add", "one.ts");
      yield* commit("one");
      const origin = `${outer}/origin.git`;
      yield* git("init", "-q", "--bare", origin);
      yield* git("remote", "add", "origin", origin);
      yield* git("push", "-q", "origin", "HEAD:refs/heads/main");
      yield* git("update-index", "--assume-unchanged", "one.ts");
      yield* fs.writeFileString(`${root}/one.ts`, "edited\n");
      const said = yield* recheckPark(
        {
          runId: "r1",
          cwd: root,
          branch: "main",
          mr: null,
          park: { cause: "checkout-dirty-collie", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("a checkout recheck must not ask core") },
      );
      expect(said).toMatchObject({ cleared: false });
      expect(said.note).toContain("one.ts");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        fakeForge("gitlab", { installed: true, loggedIn: [], login: "me", mrs: [] }).layer,
      ),
    ),
  ));

test("a predecessor-not-quiet park clears once nothing its predecessor left is running, and starts no agent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-not-quiet-" });
      const { child: pid } = yield* paneTree(SURVIVES_HANGUP);
      const started = yield* startedOf(pid);
      yield* rememberNotQuiet(`${root}/runs/r1`, {
        agent: "r1-build",
        left: [{ pid, started: started! }],
      });
      const recheck = recheckPark(
        {
          runId: "r1",
          cwd: root,
          branch: null,
          mr: null,
          park: { cause: "predecessor-not-quiet", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("a predecessor's recheck asks core nothing") },
      );
      expect(yield* recheck).toEqual({
        cleared: false,
        note: `r1-build's pid ${pid} is still running`,
        error: false,
      });
      process.kill(pid, "SIGKILL");
      while ((yield* processOf(pid)) !== null) {
        yield* Effect.sleep(10);
      }
      expect(yield* recheck).toEqual({ cleared: true, note: "r1-build is Quiet", error: false });
    }).pipe(Effect.scoped, Effect.provide(forgeHttpOnPath)),
  ));

test("a hand-over-stale park clears once the checkout holds still between two rechecks, and asks core nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-stale-hand-over-" });
      const repo = `${root}/repo`;
      yield* fs.makeDirectory(repo);
      const git = (...args: ReadonlyArray<string>) =>
        Effect.promise(() => Bun.$`git ${args}`.cwd(repo).quiet().text());
      const commit = Effect.gen(function* () {
        yield* git(
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "c",
        );
        return Str.trim(yield* git("rev-parse", "HEAD"));
      });
      yield* git("init", "-q", "-b", "work");
      const parkedAt = yield* commit;
      yield* rememberStaleHandOver(`${root}/runs/r1`, {
        cwd: repo,
        head: parkedAt,
        dir: null,
        plan: null,
      });
      const moved = yield* commit;
      const recheck = recheckPark(
        {
          runId: "r1",
          cwd: repo,
          branch: null,
          mr: null,
          park: { cause: "hand-over-stale", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("a stale hand-over's recheck asks core nothing") },
      );
      expect(yield* recheck).toEqual({
        cleared: false,
        note: `the checkout moved to ${moved} since it was last read`,
        error: false,
      });
      expect(yield* recheck).toEqual({
        cleared: true,
        note: `the checkout held still at ${moved}`,
        error: false,
      });
    }).pipe(Effect.scoped, Effect.provide(forgeHttpOnPath)),
  ));

const MENDED = {
  diagnosis: "Its agent ended its turn without writing its Output.",
  actions: ["read its record"],
  result: "escalate",
  needs_person: "Only you can tell its agent what to write.",
  finding: {
    collie_defect: false,
    key: "output-absent",
    root_cause: "Its agent ended its turn without writing its Output.",
    fix: "None.",
    regression: "None.",
  },
};

const metricsOf = (world: World, runId: string) =>
  connect(world.state).pipe(
    Effect.flatMap((client) => client.runMetrics({ runId })),
    Effect.orDie,
  );

const parksIn = (lines: ReadonlyArray<Metric>) => Arr.filter(lines, (line) => line.kind === "halt");

const healRunsIn = (lines: ReadonlyArray<Metric>) =>
  new Set(Arr.flatMap(lines, (line) => (line.action === "healed" && line.heal ? [line.heal] : [])));

const parkedAgain = (
  world: World,
  heals: ReadonlyArray<unknown>,
  again: (runId: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outputs = `${world.home}/outputs.json`;
    yield* fs.writeFileString(outputs, asJson(heals)).pipe(Effect.orDie);
    const env = { COLLIE_RECOVERY_EVERY: "100 millis", FAKE_HERDR_OUTPUTS: outputs };
    const said = yield* collie(
      world,
      [
        "run",
        "start",
        "parks-for",
        "--input",
        "causes=output-absent,output-absent",
        "--input",
        `entries=${world.home}/entries`,
      ],
      env,
    );
    const runId = yield* idOf(said.envelope.data);
    yield* until(
      () => metricsOf(world, runId),
      (lines) =>
        Arr.some(lines, (line) => line.action === "healed" && line.outcome === "escalated"),
    );
    yield* stopHost(world.state);
    yield* again(runId);
    expect((yield* collie(world, ["run", "resume", runId], env)).envelope).toMatchObject({
      ok: true,
    });
    const parks = parksIn(
      yield* until(
        () => metricsOf(world, runId),
        (lines) => parksIn(lines).length >= 3,
      ),
    );
    return { runId, first: parks[0]!.park, again: parks[2]!.park };
  });

const settle = Effect.sleep("3 seconds");

test("a healed park resumed after a host restart parks again as itself, and its complete Heal starts no second one", () =>
  proves(
    "collie-recovery-identity-",
    (world) =>
      Effect.gen(function* () {
        const { runId, first, again } = yield* parkedAgain(
          world,
          [MENDED, MENDED],
          () => Effect.void,
        );
        yield* settle;
        expect(again).toBe(first);
        expect(healRunsIn(yield* metricsOf(world, runId)).size).toBe(1);
      }),
    ["parks-for.workflow.ts", "mender.workflow.ts"],
  ));

test("a healed park handed over to the engine again parks again as itself, and starts no second Heal", () =>
  proves(
    "collie-recovery-handover-",
    (world) =>
      Effect.gen(function* () {
        const { runId, first, again } = yield* parkedAgain(world, [MENDED, MENDED], (run) =>
          Effect.sync(() => {
            const db = new Database(`${world.state}/host.db`);
            db.run("UPDATE collie_runs SET accepted = NULL WHERE run = ?", [run]);
            db.close();
          }),
        );
        yield* settle;
        expect(again).toBe(first);
        expect(healRunsIn(yield* metricsOf(world, runId)).size).toBe(1);
      }),
    ["parks-for.workflow.ts", "mender.workflow.ts"],
  ));

test("a park whose Heal could not complete its diagnosis gets another Heal when it parks again as itself", () =>
  proves(
    "collie-recovery-incomplete-",
    (world) =>
      Effect.gen(function* () {
        const { runId, first, again } = yield* parkedAgain(
          world,
          [{ ...MENDED, diagnosis_complete: false }, MENDED],
          () => Effect.void,
        );
        expect(again).toBe(first);
        yield* until(
          () => metricsOf(world, runId),
          (lines) => healRunsIn(lines).size === 2,
        );
      }),
    ["parks-for.workflow.ts", "mender.workflow.ts"],
  ));

test("a park entered again once its checkout's head moved is a new park, with a Heal of its own", () =>
  proves(
    "collie-recovery-head-",
    (world) =>
      Effect.gen(function* () {
        const { runId, first, again } = yield* parkedAgain(world, [MENDED, MENDED], () =>
          exec(
            [
              "git",
              "-c",
              "user.name=t",
              "-c",
              "user.email=t@t",
              "commit",
              "--allow-empty",
              "-qm",
              "moved",
            ],
            { cwd: world.project },
          ).pipe(Effect.asVoid, Effect.orDie, Effect.scoped),
        );
        expect(again).not.toBe(first);
        yield* until(
          () => metricsOf(world, runId),
          (lines) => healRunsIn(lines).size === 2,
        );
      }),
    ["parks-for.workflow.ts", "mender.workflow.ts"],
  ));

const resumedThrough = (world: World, steps: string) =>
  Effect.gen(function* () {
    expect((yield* collie(world, ["settings", "set", "recovery.heal", "false"])).envelope.ok).toBe(
      true,
    );
    const said = yield* collie(world, [
      "run",
      "start",
      "parks-in-steps",
      "--input",
      "cause=step-failed",
      "--input",
      `steps=${steps}`,
      "--input",
      `entries=${world.home}/entries`,
    ]);
    const runId = yield* idOf(said.envelope.data);
    yield* until(
      () => metricsOf(world, runId),
      (lines) => parksIn(lines).length >= 1,
    );
    expect((yield* collie(world, ["run", "resume", runId])).envelope.ok).toBe(true);
    return parksIn(
      yield* until(
        () => metricsOf(world, runId),
        (lines) => parksIn(lines).length >= 2,
      ),
    );
  });

test("a park entered again by a resume, in the same step, keeps its identity", () =>
  proves(
    "collie-recovery-resumed-",
    (world) =>
      Effect.gen(function* () {
        const parks = yield* resumedThrough(world, "a,a");
        expect(parks[1]!.park).toBe(parks[0]!.park);
      }),
    ["parks-in-steps.workflow.ts"],
  ));

test("the same cause parked in two steps at one head is two parks", () =>
  proves(
    "collie-recovery-steps-",
    (world) =>
      Effect.gen(function* () {
        const parks = yield* resumedThrough(world, "a,b");
        expect(parks[1]!.park).not.toBe(parks[0]!.park);
      }),
    ["parks-in-steps.workflow.ts"],
  ));
