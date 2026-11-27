import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import * as Rec from "effect/Record";
import { Effect, Fiber, FileSystem, Path, Schedule } from "effect";
import { ciJob, takeTarget } from "../src/ci-job";
import { mrRefOf } from "../src/board-model";
import { recheckPark, rememberCiTarget, rememberSettledClear } from "../src/park-recheck";
import type { MrForge } from "../src/board-model";
import type { Runner } from "../src/mr";
import type { FetchLike } from "forges";
import { readVerifications, VERIFYING, verifyingOf } from "../src/verify";
import type { CheckCommand } from "../src/verify";
import { controlOf } from "../src/controls";
import { RunRecords } from "../src/run-records";
import type { VerifySpec } from "../src/verify-spec";
import { exec } from "./support/command";
import { fastForward, runEffect } from "./support/effect";
import { forgeHttpTest } from "../src/forge/http";
import { FORGE_HOST, PROJECT, fakeForge } from "./support/forge";
import type { FakeJob, FakeMr, FakeRequest, ForgeModel } from "./support/forge";

const NUXI: VerifySpec = {
  name: "nuxi",
  executable: "bunx",
  argv: ["nuxi", "typecheck"],
  cwd: ".",
  ci: "nuxi-typecheck",
};
const MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;

const waiting = Effect.fn("ciJob.waiting")(function* (
  state: FakeJob["state"],
  mr: string | null = MR,
  head?: string,
  over: Partial<FakeMr> = {},
  name: MrForge = "gitlab",
  adds: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ci-job-" });
  const cwd = `${root}/checkout`;
  yield* fs.makeDirectory(cwd);
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "one",
      "--allow-empty",
    ],
  ]) {
    yield* exec(["git", ...args], { cwd });
  }
  if (!Rec.isEmptyRecord(adds)) {
    const path = yield* Path.Path;
    yield* exec(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
    for (const [file, text] of Rec.toEntries(adds)) {
      yield* fs.makeDirectory(path.dirname(`${cwd}/${file}`), { recursive: true });
      yield* fs.writeFileString(`${cwd}/${file}`, text);
    }
    yield* exec(["git", "add", "-A"], { cwd });
    yield* exec(
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "branch"],
      { cwd },
    );
  }
  const at = Str.trim((yield* exec(["git", "rev-parse", "HEAD"], { cwd })).stdout);
  const forge = forgeOn(name, head ?? at, { jobs: [{ name: "nuxi-typecheck", state }], ...over });
  const run: Runner = (cmd, args, where) =>
    cmd === "git" && Arr.join(args, " ") === "rev-parse HEAD"
      ? Effect.succeed({ code: 0, stdout: `${at}\n` })
      : forge.run(cmd, args, where);
  const command: CheckCommand = { ...NUXI, executable: "/usr/bin/bunx", cwd };
  const asked = {
    runId: "r1",
    runDir: `${root}/run`,
    journal: `${root}/evidence`,
    cwd,
    spec: NUXI,
    command,
    mr,
    wait: true,
    verifying: controlOf(yield* RunRecords, VERIFYING, "r1"),
    run,
  };
  return { asked, at, root, forge };
});

const forgeOn = (name: MrForge, head: string, over: Partial<FakeMr>) =>
  fakeForge(name, {
    installed: true,
    loggedIn: [FORGE_HOST[name]],
    login: "me",
    mrs: [
      {
        project: PROJECT[name],
        iid: "31",
        state: "open",
        head,
        targetBranch: "main",
        ...over,
      },
    ],
  });

const read = (
  asked: Parameters<typeof ciJob>[0] & { readonly run: Runner },
  forge: { readonly fetch: FetchLike },
) => ciJob(asked).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));

test("a CI park rechecks jobs at its latest recorded head rather than an earlier gate", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("passed");
      const dir = `${root}/runs/r1`;
      yield* rememberCiTarget(dir, { head: "older", job: "old-job", mr: MR, cwd: asked.cwd });
      yield* rememberCiTarget(dir, { head: at, job: "nuxi-typecheck", mr: MR, cwd: asked.cwd });
      const result = yield* recheckPark(
        {
          runId: "r1",
          cwd: asked.cwd,
          branch: "main",
          mr: MR,
          park: { cause: "ci-job-absent", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("CI rechecks must not ask core") },
      ).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));
      expect(result).toMatchObject({ cleared: true, error: false });
      expect(result.note).toContain("nuxi-typecheck");
      expect(result.note).not.toContain("old-job");
    }),
  ));

test("a CI park with no pipeline stays uncleared until the named job exists", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("pending", MR, undefined, {
        jobs: undefined,
      });
      yield* rememberCiTarget(`${root}/runs/r1`, {
        head: at,
        job: "nuxi-typecheck",
        mr: MR,
        cwd: asked.cwd,
      });
      const result = yield* recheckPark(
        {
          runId: "r1",
          cwd: asked.cwd,
          branch: "main",
          mr: MR,
          park: { cause: "ci-job-absent", kind: "rechecks" },
        },
        root,
        { agentList: () => Effect.die("CI rechecks must not ask core") },
      ).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));
      expect(result).toMatchObject({ cleared: false, error: false });
    }),
  ));

test("a CI park clears once every recorded job at the parked head has settled, cancelled and skipped included", () =>
  runEffect(
    Effect.gen(function* () {
      const recheck = (state: FakeJob["state"]) =>
        Effect.gen(function* () {
          const { asked, at, root, forge } = yield* waiting(state);
          yield* rememberCiTarget(`${root}/runs/r1`, {
            head: at,
            job: "nuxi-typecheck",
            mr: MR,
            cwd: asked.cwd,
          });
          return yield* recheckPark(
            {
              runId: "r1",
              cwd: asked.cwd,
              branch: "main",
              mr: MR,
              park: { cause: "ci-job-absent", kind: "rechecks" },
            },
            root,
            { agentList: () => Effect.die("CI rechecks must not ask core") },
          ).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));
        });
      const cancelled = yield* recheck("cancelled");
      expect(cancelled).toMatchObject({ cleared: true, error: false });
      expect(cancelled.note).toContain("settled");
      expect((yield* recheck("skipped")).cleared).toBe(true);
      expect((yield* recheck("running")).cleared).toBe(false);
      expect((yield* recheck("pending")).cleared).toBe(false);
    }),
  ));

const cancelledRecheck = (
  asked: Parameters<typeof recheckPark>[0],
  root: string,
  run: Runner,
  forge: { readonly fetch: FetchLike },
) =>
  recheckPark({ ...asked, park: { cause: "ci-job-absent", kind: "rechecks" } }, root, {
    agentList: () => Effect.die("CI rechecks must not ask core"),
  }).pipe(Effect.provide(forgeHttpTest(run, forge.fetch)));

test("a CI park clears while nothing is recorded, and a recorded read clears no more until the forge says something new", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [{ name: "nuxi-typecheck", state: "cancelled", id: 1 }],
      });
      yield* rememberCiTarget(`${root}/runs/r1`, {
        head: at,
        job: "nuxi-typecheck",
        mr: MR,
        cwd: asked.cwd,
      });
      const view = {
        runId: "r1",
        cwd: asked.cwd,
        branch: "main",
        mr: MR,
      };
      const recheck = () => cancelledRecheck(view, root, asked.run, forge);
      const first = yield* recheck();
      expect(first).toMatchObject({ cleared: true, error: false });
      expect(yield* recheck()).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(`${root}/runs/r1`, first.reads ?? "");
      const refused = yield* recheck();
      expect(refused).toMatchObject({ cleared: false, error: false });
      expect(refused.note).toContain("nuxi-typecheck");
      const before = forge.model();
      forge.set({
        ...before,
        mrs: Arr.map(before.mrs ?? [], (mr) => ({
          ...mr,
          jobs: [{ name: "nuxi-typecheck", state: "cancelled", id: 2 }],
        })),
      });
      expect(yield* recheck()).toMatchObject({ cleared: true, error: false });
    }),
  ));

test("a job newly settling clears a parked head while another job stays cancelled there", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "cancelled", id: 1 },
          { name: "lint", state: "failed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      yield* rememberCiTarget(dir, { head: at, job: "nuxi-typecheck", mr: MR, cwd: asked.cwd });
      yield* rememberCiTarget(dir, { head: at, job: "lint", mr: MR, cwd: asked.cwd });
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const recheck = () => cancelledRecheck(view, root, asked.run, forge);
      const first = yield* recheck();
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      const before = forge.model();
      forge.set({
        ...before,
        mrs: Arr.map(before.mrs ?? [], (mr) => ({
          ...mr,
          jobs: [
            { name: "nuxi-typecheck", state: "cancelled", id: 1 },
            { name: "lint", state: "passed", id: 2 },
          ],
        })),
      });
      expect(yield* recheck()).toMatchObject({ cleared: true, error: false });
    }),
  ));

test("a green read clears a fresh park at the same head even after a green snapshot was recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("passed");
      yield* rememberCiTarget(`${root}/runs/r1`, {
        head: at,
        job: "nuxi-typecheck",
        mr: MR,
        cwd: asked.cwd,
      });
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const recheck = () => cancelledRecheck(view, root, asked.run, forge);
      const first = yield* recheck();
      expect(first).toMatchObject({ cleared: true, error: false });
      if (first.reads !== undefined) {
        yield* rememberSettledClear(`${root}/runs/r1`, first.reads);
      }
      expect(yield* recheck()).toMatchObject({ cleared: true, error: false });
    }),
  ));

test("a healthy read of a mixed head the forge could not be read for still reaches the fixer", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "passed", id: 1 },
          { name: "lint", state: "failed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      yield* rememberCiTarget(dir, { head: at, job: "nuxi-typecheck", mr: MR, cwd: asked.cwd });
      yield* rememberCiTarget(dir, {
        head: at,
        job: "lint",
        mr: MR,
        cwd: asked.cwd,
        observed: "unreadable",
      });
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      yield* rememberCiTarget(dir, {
        head: at,
        job: "lint",
        mr: MR,
        cwd: asked.cwd,
        observed: "unreadable",
      });
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: true,
        error: false,
      });
    }),
  ));

test("an unchanged failed job beside a cancelled one reissues no recovery for the park that read them", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("cancelled", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "cancelled", id: 1 },
          { name: "lint", state: "failed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      yield* rememberCiTarget(dir, {
        head: at,
        job: "nuxi-typecheck",
        mr: MR,
        cwd: asked.cwd,
        observed: "cancelled",
      });
      yield* rememberCiTarget(dir, { head: at, job: "lint", mr: MR, cwd: asked.cwd });
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: false,
        error: false,
      });
    }),
  ));

test("a refusal recorded at an earlier head never clears a park at the current one", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("cancelled", MR, undefined, {
        jobs: [{ name: "nuxi-typecheck", state: "cancelled", id: 1 }],
      });
      const dir = `${root}/runs/r1`;
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const healthy: ForgeModel = forge.model();
      forge.set({ ...healthy, httpFault: { status: 503 } });
      expect("unproved" in (yield* read({ ...asked, runDir: dir }, forge))).toBe(true);
      const committed = yield* exec(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "commit",
          "-qm",
          "two",
          "--allow-empty",
        ],
        { cwd: asked.cwd },
      );
      expect(committed.exitCode).toBe(0);
      const moved = Str.trim(
        (yield* exec(["git", "rev-parse", "HEAD"], { cwd: asked.cwd })).stdout,
      );
      expect(moved).not.toBe(at);
      forge.set({ ...healthy, mrs: Arr.map(healthy.mrs, (one) => ({ ...one, head: moved })) });
      expect("unproved" in (yield* read({ ...asked, runDir: dir }, forge))).toBe(true);
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: false,
        error: false,
      });
    }),
  ));

test("a refusal from an earlier pass through Prove does not clear the park made after it", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, root, forge } = yield* waiting("cancelled", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "cancelled", id: 1 },
          { name: "lint", state: "failed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      const nuxi = { ...asked, runDir: dir };
      const lint = {
        ...nuxi,
        spec: { ...NUXI, name: "lint", ci: "lint" },
        command: { ...nuxi.command, ci: "lint" },
      };
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const healthy: ForgeModel = forge.model();
      forge.set({ ...healthy, httpFault: { status: 503 } });
      expect("unproved" in (yield* read(lint, forge))).toBe(true);
      forge.set(healthy);
      expect("unproved" in (yield* read(nuxi, forge))).toBe(true);
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: false,
        error: false,
      });
    }),
  ));

test("a refused read keeps its reason when a later check in the round fails", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, root, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "failed", id: 1 },
          { name: "lint", state: "failed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      const nuxi = { ...asked, runDir: dir };
      const lint = {
        ...nuxi,
        spec: { ...NUXI, name: "lint", ci: "lint" },
        command: { ...nuxi.command, ci: "lint" },
      };
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const healthy: ForgeModel = forge.model();
      const down: ForgeModel = { ...healthy, httpFault: { status: 503 } };
      const round = Effect.gen(function* () {
        forge.set(down);
        expect("unproved" in (yield* read(nuxi, forge))).toBe(true);
        forge.set(healthy);
        expect("unproved" in (yield* read(lint, forge))).toBe(true);
      });
      yield* round;
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      yield* round;
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: true,
        error: false,
      });
    }),
  ));

test("a refused read that parks a run keeps its reason when a later check in the round passes", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, root, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [
          { name: "nuxi-typecheck", state: "failed", id: 1 },
          { name: "lint", state: "passed", id: 2 },
        ],
      });
      const dir = `${root}/runs/r1`;
      const nuxi = { ...asked, runDir: dir };
      const lint = {
        ...nuxi,
        spec: { ...NUXI, name: "lint", ci: "lint" },
        command: { ...nuxi.command, ci: "lint" },
      };
      const view = { runId: "r1", cwd: asked.cwd, branch: "main", mr: MR };
      const healthy: ForgeModel = forge.model();
      const down: ForgeModel = { ...healthy, httpFault: { status: 503 } };
      const round = Effect.gen(function* () {
        forge.set(down);
        expect("unproved" in (yield* read(nuxi, forge))).toBe(true);
        forge.set(healthy);
        expect("proved" in (yield* read(lint, forge))).toBe(true);
      });
      yield* round;
      const first = yield* cancelledRecheck(view, root, asked.run, forge);
      expect(first).toMatchObject({ cleared: true, error: false });
      yield* rememberSettledClear(dir, first.reads ?? "");
      yield* round;
      expect(yield* cancelledRecheck(view, root, asked.run, forge)).toMatchObject({
        cleared: true,
        error: false,
      });
    }),
  ));

test("a target-red park clears only once every recorded job passed on the target branch's newest commit", () =>
  runEffect(
    Effect.gen(function* () {
      const recheck = (state: FakeJob["state"]) =>
        Effect.gen(function* () {
          const { asked, at, root, forge } = yield* waiting("failed", MR, undefined, {
            target: {
              at: pipe_("c", Str.repeat(40)),
              jobs: [
                { name: "nuxi-typecheck", state },
                { name: "lint", state: "passed" },
              ],
            },
          });
          yield* rememberCiTarget(`${root}/runs/r1`, {
            head: at,
            job: "nuxi-typecheck",
            mr: MR,
            cwd: asked.cwd,
          });
          return yield* recheckPark(
            {
              runId: "r1",
              cwd: asked.cwd,
              branch: "feature",
              mr: MR,
              park: { cause: "target-red", kind: "rechecks" },
            },
            root,
            { agentList: () => Effect.die("CI rechecks must not ask core") },
          ).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));
        });
      for (const state of ["failed", "pending", "running"] as const) {
        expect(yield* recheck(state)).toMatchObject({ cleared: false, error: false });
      }
      const cleared = yield* recheck("passed");
      expect(cleared).toMatchObject({ cleared: true, error: false });
      expect(cleared.note).toContain("main");
    }),
  ));

test("a Release parked on its target's failure takes the target, retries where its head has it already, and does neither where its head moved", () =>
  runEffect(
    Effect.gen(function* () {
      const decide = (tip: (at: string) => string, head?: string) =>
        Effect.gen(function* () {
          const { asked, at, forge } = yield* waiting("failed", MR, head, {
            target: { at: "", jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
          });
          const model = forge.model();
          forge.set({
            ...model,
            mrs: Arr.map(model.mrs, (one) => ({
              ...one,
              target: { at: tip(at), jobs: one.target?.jobs ?? [] },
            })),
          });
          const took = yield* takeTarget(
            mrRefOf(MR)!,
            ["nuxi-typecheck"],
            at,
            asked.cwd,
            asked.run,
          ).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));
          return { took, retried: retries(forge.requests).length };
        });
      expect(yield* decide(() => TIP)).toEqual({ took: { _tag: "Take" }, retried: 0 });
      expect(yield* decide((at) => at)).toEqual({ took: { _tag: "Retried" }, retried: 1 });
      expect(yield* decide((at) => at, "elsewhere")).toEqual({
        took: { _tag: "Moved", head: "elsewhere" },
        retried: 0,
      });
    }),
  ));

const committing: (asked: { readonly cwd: string; readonly run: Runner }) => Runner =
  (asked) => (cmd, args, where) =>
    Effect.andThen(
      exec(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "commit",
          "-qm",
          "two",
          "--allow-empty",
        ],
        { cwd: asked.cwd },
      ).pipe(Effect.scoped, Effect.orDie),
      asked.run(cmd, args, where),
    );

test("a job still running is waited on, saying which check, job and commit, and a stop records nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { asked, at, forge } = yield* waiting("running");
      const fiber = yield* Effect.forkChild(read(asked, forge));
      const marker = yield* Effect.retry(
        verifyingOf(asked.runId).pipe(Effect.filterOrFail((one) => one !== null)),
        { schedule: Schedule.spaced("20 millis"), times: 250 },
      );
      expect(marker).toMatchObject({
        name: "nuxi",
        pass: "ci",
        job: "nuxi-typecheck",
        revision: at,
      });
      expect(yield* fs.readFileString(`${asked.runDir}/log.txt`)).toContain(
        `ci: waiting on job nuxi-typecheck for nuxi on ${at}`,
      );
      yield* Fiber.interrupt(fiber);
      expect(yield* verifyingOf(asked.runId)).toBeNull();
      expect(yield* readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []))).toEqual(
        [],
      );
    }),
  ));

test("a job not finished after 2 hours leaves its check unproved, saying so", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting("pending");
        expect(yield* read(asked, forge)).toEqual({
          unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is still pending after 2 hours`,
          state: "pending",
          url: `https://${PROJECT.gitlab}/-/jobs/1`,
          log: LOG,
        });
        expect(
          Arr.filter(forge.requests, (one) => pipe_(one.url, Str.includes("/jobs"))).length,
        ).toBeGreaterThan(200);
        expect(yield* verifyingOf(asked.runId)).toBeNull();
      }),
      60_000,
    ),
  ));

test("a merge request whose head is not yet this checkout's is waited on, and its pass then recorded once", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting("passed", MR, "an-older-head");
      expect(yield* read({ ...asked, wait: false }, forge)).toMatchObject({ state: "pending" });
      const { asked: here, at, forge: there } = yield* waiting("passed");
      const proved = yield* read(here, there);
      expect(proved).toMatchObject({ proved: { pass: "ci", name: "nuxi" } });
      expect(yield* read(here, there)).toEqual(proved);
      expect(yield* readVerifications(here.journal)).toHaveLength(1);
      const { asked: rerun, forge: rerunForge } = yield* waiting("failed", MR, at);
      expect(yield* read({ ...here, run: rerun.run, wait: false }, rerunForge)).toMatchObject({
        state: "failed",
      });
      expect(yield* readVerifications(here.journal)).toHaveLength(1);
    }),
  ));

test("a job that passes for a commit the checkout has left while it was waited on proves nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting("passed");
      expect(yield* read({ ...asked, run: committing(asked) }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} passed, but ${asked.cwd} has moved off it since`,
        state: null,
        url: null,
        log: null,
      });
      expect(yield* readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []))).toEqual(
        [],
      );
    }),
  ));

test("a recorded pass is not returned for a checkout that moves while the job is read", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting("passed");
      expect(yield* read(asked, forge)).toMatchObject({ proved: { pass: "ci" } });
      expect(yield* read({ ...asked, run: committing(asked) }, forge)).toMatchObject({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} passed, but ${asked.cwd} has moved off it since`,
      });
      expect(yield* readVerifications(asked.journal)).toHaveLength(1);
    }),
  ));

test("a job that passes for a checkout with changes it never saw proves nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { asked, at, forge } = yield* waiting("passed");
      // WARNING: Overrides the operator's status.showUntrackedFiles so the checkout reads the same whatever git is set to.
      yield* exec(["git", "config", "status.showUntrackedFiles", "no"], { cwd: asked.cwd });
      yield* fs.writeFileString(`${asked.cwd}/unseen.txt`, "x");
      expect(yield* read(asked, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} passed, but ${asked.cwd} has changes it never saw`,
        state: null,
        url: null,
        log: null,
      });
      expect(yield* readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []))).toEqual(
        [],
      );
    }),
  ));

test("a Run with no merge request has its check left to CI unproved, and the forge is not asked", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting("passed", null);
      expect(yield* read(asked, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} was never read: this Run has no merge request`,
        state: null,
        url: null,
        log: null,
      });
      expect(forge.calls).toEqual([]);
      expect(forge.requests).toEqual([]);
    }),
  ));

const BASE = pipe_("b", Str.repeat(40));
const LOG = `glab ci trace 1 --repo ${PROJECT.gitlab}`;
const retries = (requests: ReadonlyArray<FakeRequest>) =>
  Arr.filter(requests, (one) => pipe_(one.url, Str.includes("/retry")));

test("a failed job that also fails where the branch leaves its target is reported, and not retried", () =>
  runEffect(
    Effect.gen(function* () {
      const failing = trace(["test/old-thing.test.ts", "an old thing works"]);
      const { asked, at, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [{ name: "nuxi-typecheck", state: "failed", trace: failing }],
        base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "failed", trace: failing }] },
      });
      expect(yield* read({ ...asked, settle: true }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is failed`,
        state: "failed",
        url: `https://${PROJECT.gitlab}/-/jobs/1`,
        log: LOG,
        before: {
          at: BASE,
          url: `https://${PROJECT.gitlab}/-/jobs/1001`,
          jobs: ["nuxi-typecheck"],
        },
      });
      expect(retries(forge.requests)).toEqual([]);
    }),
  ));

test("a failed job green where the branch leaves its target is retried once, and its pass is a Flake recorded as the proof", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "passed" }],
        base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
      });
      expect(yield* read({ ...asked, settle: true }, forge)).toMatchObject({
        proved: { pass: "ci", name: "nuxi" },
        retried: true,
      });
      expect(retries(forge.requests)).toHaveLength(1);
      expect(yield* readVerifications(asked.journal)).toHaveLength(1);
    }),
  ));

test("a failed job that fails its retry, or with no base to compare, is the Run's own, with the command for its log", () =>
  runEffect(
    Effect.gen(function* () {
      for (const over of [
        { base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" as const }] } },
        {},
      ]) {
        const { asked, at, forge } = yield* waiting("failed", MR, undefined, {
          jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "failed" }],
          ...over,
        });
        expect(yield* read({ ...asked, settle: true }, forge)).toEqual({
          unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is failed`,
          state: "failed",
          url: `https://${PROJECT.gitlab}/-/jobs/101`,
          log: `glab ci trace 101 --repo ${PROJECT.gitlab}`,
        });
        expect(retries(forge.requests)).toHaveLength(1);
      }
      const { asked, forge } = yield* waiting("failed");
      expect(yield* read(asked, forge)).toMatchObject({ state: "failed", log: LOG });
      expect(
        Arr.some(forge.requests, (one) => pipe_(one.url, Str.includes("pipelines?sha="))),
      ).toBe(false);
      expect(retries(forge.requests)).toEqual([]);
    }),
  ));

const trace = (...files: ReadonlyArray<readonly [string, string]>) =>
  Arr.join(
    [
      "\u001b[0Ksection_start:1700000000:step_script\r\u001b[0K\u001b[36;1mExecuting step_script\u001b[0;m",
      "bun test v1.4.4",
      ...Arr.flatMap(files, ([file, failed]) => [
        "",
        `${file}:`,
        "\u001b[0m\u001b[32m(pass)\u001b[0m a test beside it \u001b[0m\u001b[2m[0.20ms]\u001b[0m",
        `\u001b[0m\u001b[31m(fail)\u001b[0m ${failed} \u001b[0m\u001b[2m[1.00ms]\u001b[0m`,
      ]),
      "\u001b[0Ksection_end:1700000001:step_script\r\u001b[0K",
    ],
    "\r\n",
  );
const TIP = pipe_("c", Str.repeat(40));
const TARGET_JOB = `https://${PROJECT.gitlab}/-/jobs/2001`;
const SHARED = "a shared thing works";

test("a failed job whose every failed test fails on the target branch's newest commit too is the target's, and not retried", () =>
  runEffect(
    Effect.gen(function* () {
      {
        const { asked, at, forge } = yield* waiting("failed", MR, undefined, {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "failed",
              retried: "passed",
              trace: trace(["test/a.test.ts", SHARED]),
            },
          ],
          base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
          target: {
            at: TIP,
            jobs: [
              {
                name: "nuxi-typecheck",
                state: "failed",
                trace: trace(["test/a.test.ts", SHARED], ["test/a.test.ts", "another"]),
              },
            ],
          },
        });
        expect(yield* read({ ...asked, settle: true }, forge)).toEqual({
          unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is failed`,
          state: "failed",
          url: `https://${PROJECT.gitlab}/-/jobs/1`,
          log: LOG,
          before: { at: TIP, url: TARGET_JOB, branch: "main", jobs: ["nuxi-typecheck"] },
        });
        expect(retries(forge.requests)).toEqual([]);
      }
    }),
  ));

test("a failed job naming no failed test, or beside a job the target branch's newest commit passes, is not the target's and is retried", () =>
  runEffect(
    Effect.gen(function* () {
      const shared = trace(["test/a.test.ts", SHARED]);
      for (const jobs of [
        [{ name: "nuxi-typecheck", state: "failed" as const, retried: "passed" as const }],
        [
          {
            name: "nuxi-typecheck",
            state: "failed" as const,
            retried: "passed" as const,
            trace: shared,
          },
          { name: "lint", state: "failed" as const, trace: trace(["test/c.test.ts", "own"]) },
        ],
      ]) {
        const { asked, forge } = yield* waiting("failed", MR, undefined, {
          jobs,
          target: {
            at: TIP,
            jobs: [
              { name: "nuxi-typecheck", state: "failed", trace: shared },
              { name: "lint", state: "passed" },
            ],
          },
        });
        expect(yield* read({ ...asked, settle: true }, forge)).toMatchObject({
          proved: { pass: "ci", name: "nuxi" },
          retried: true,
        });
        expect(retries(forge.requests)).toHaveLength(1);
      }
    }),
  ));

test("a failed job whose failed tests the target branch shares only in part is retried as before, and names the target's tests", () =>
  runEffect(
    Effect.gen(function* () {
      const own = trace(["test/a.test.ts", SHARED], ["test/c.test.ts", "this branch's thing"]);
      const partly = yield* waiting("failed", MR, undefined, {
        jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "failed", trace: own }],
        target: {
          at: TIP,
          jobs: [
            { name: "nuxi-typecheck", state: "failed", trace: trace(["test/a.test.ts", SHARED]) },
          ],
        },
      });
      const result = yield* read({ ...partly.asked, settle: true }, partly.forge);
      expect(result).toMatchObject({ state: "failed" });
      expect("before" in result).toBe(false);
      expect("unproved" in result ? result.unproved : "").toContain(
        `"${SHARED}" also fails on main at ${pipe_(TIP, Str.slice(0, 12))}`,
      );
      expect(retries(partly.forge.requests)).toHaveLength(1);
    }),
  ));

test("a failed job whose job on the target branch is pending, running or missing is retried as before", () =>
  runEffect(
    Effect.gen(function* () {
      const own = trace(["test/a.test.ts", SHARED]);
      for (const there of [
        [{ name: "nuxi-typecheck", state: "pending" as const }],
        [{ name: "nuxi-typecheck", state: "running" as const }],
        [{ name: "lint", state: "failed" as const }],
      ]) {
        const { asked, forge } = yield* waiting("failed", MR, undefined, {
          jobs: [{ name: "nuxi-typecheck", state: "failed", retried: "passed", trace: own }],
          target: { at: TIP, jobs: there },
        });
        expect(yield* read({ ...asked, settle: true }, forge)).toMatchObject({
          proved: { pass: "ci", name: "nuxi" },
          retried: true,
        });
        expect(retries(forge.requests)).toHaveLength(1);
      }
    }),
  ));

const OWN_FILE = "test/new-thing.test.ts";
const SCENARIO = "a retried pass of the branch's own scenario is a failed job";
const BRANCH = {
  [OWN_FILE]: "export {};\n",
  "test/support/scenarios.ts": `scenario("${SCENARIO}", () => {});\n`,
};
const journalOf = (asked: { readonly journal: string }) =>
  readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []));

test("a job that passes its retry, after a failed attempt naming a test in a file the branch adds, is failed and proves nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting(
        "failed",
        MR,
        undefined,
        {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "failed",
              retried: "passed",
              trace: trace([OWN_FILE, "a new thing works"]),
            },
          ],
          base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
        },
        "gitlab",
        BRANCH,
      );
      expect(yield* read({ ...asked, settle: true }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} failed in this branch's own test "a new thing works", and passed only when retried`,
        state: "failed",
        url: `https://${PROJECT.gitlab}/-/jobs/1`,
        log: LOG,
      });
      expect(retries(forge.requests)).toHaveLength(1);
      expect(yield* journalOf(asked)).toEqual([]);
    }),
  ));

test("a job the forge says passed on a retry this Run never made, after a failed attempt naming a scenario the branch adds, is failed", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        MR,
        undefined,
        {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "passed",
              id: 101,
              attempts: [
                {
                  id: 1,
                  state: "failed",
                  trace: trace(
                    ["test/baseline-03.test.ts", `${SCENARIO} [unrelated 4]`],
                    ["test/baseline-07.test.ts", "an older scenario nobody touched"],
                  ),
                },
              ],
            },
          ],
        },
        "gitlab",
        BRANCH,
      );
      const result = yield* read({ ...asked, settle: true }, forge);
      expect(result).toMatchObject({
        state: "failed",
        url: `https://${PROJECT.gitlab}/-/jobs/1`,
        log: LOG,
      });
      expect("unproved" in result ? result.unproved : "").toContain(
        `this branch's own test "${SCENARIO} [unrelated 4]", and passed only when retried`,
      );
      expect(retries(forge.requests)).toEqual([]);
      expect(yield* journalOf(asked)).toEqual([]);
    }),
  ));

test("a retried pass whose failed attempt names only a test the branch does not touch proves the check, marked retried", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        MR,
        undefined,
        {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "passed",
              id: 101,
              attempts: [
                {
                  id: 1,
                  state: "failed",
                  trace: trace(["test/old-thing.test.ts", "an old thing works"]),
                },
              ],
            },
          ],
        },
        "gitlab",
        BRANCH,
      );
      expect(yield* read(asked, forge)).toMatchObject({
        proved: { pass: "ci", name: "nuxi" },
        retried: true,
      });
      expect(yield* journalOf(asked)).toHaveLength(1);
    }),
  ));

const OLD_FILE = "test/old-thing.test.ts";

test("a pass on Collie's retry of a failed attempt naming a test records that test as flaked once", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting("failed", MR, undefined, {
        jobs: [
          {
            name: "nuxi-typecheck",
            state: "failed",
            retried: "passed",
            trace: trace([OLD_FILE, "an old thing works"]),
          },
        ],
        base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "passed" }] },
      });
      const flaked = [{ name: "an old thing works", file: OLD_FILE, attempts: 1 }];
      expect(yield* read({ ...asked, settle: true }, forge)).toMatchObject({
        proved: { job: { flaked } },
        retried: true,
      });
      expect(yield* journalOf(asked)).toMatchObject([{ job: { flaked } }]);
    }),
  ));

test("a GitLab retried pass counts, for each test, the failed attempts in its pipeline that named it", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        MR,
        undefined,
        {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "passed",
              id: 101,
              attempts: [
                {
                  id: 1,
                  state: "failed",
                  trace: trace([OLD_FILE, "an old thing works"], [OLD_FILE, "it flakes once"]),
                },
                { id: 2, state: "failed", trace: trace([OLD_FILE, "an old thing works"]) },
              ],
            },
          ],
        },
        "gitlab",
        BRANCH,
      );
      const result = yield* read(asked, forge);
      expect("proved" in result ? result.proved.job?.flaked : undefined).toEqual([
        { name: "an old thing works", file: OLD_FILE, attempts: 2 },
        { name: "it flakes once", file: OLD_FILE, attempts: 1 },
      ]);
    }),
  ));

test("a GitLab aggregate job's retried pass counts each failed suite once, for the attempt it failed", () =>
  runEffect(
    Effect.gen(function* () {
      const failedAt = (id: number, minute: number, failed?: string) => ({
        id,
        state: "failed" as const,
        finished: `2026-11-17T08:0${minute}:00Z`,
        trace: failed === undefined ? "" : trace([OLD_FILE, failed]),
      });
      const { asked, forge } = yield* waiting(
        "passed",
        MR,
        undefined,
        {
          jobs: [
            {
              name: "nuxi-typecheck",
              state: "passed",
              id: 101,
              attempts: [failedAt(2, 2), failedAt(5, 6)],
            },
            {
              name: "suite-t",
              state: "passed",
              id: 102,
              attempts: [failedAt(1, 1, "an old thing works")],
            },
            {
              name: "suite-u",
              state: "passed",
              id: 103,
              attempts: [failedAt(4, 5, "it flakes once")],
            },
          ],
        },
        "gitlab",
        BRANCH,
      );
      const result = yield* read(asked, forge);
      expect("proved" in result ? result.proved.job?.flaked : undefined).toEqual([
        { name: "it flakes once", file: OLD_FILE, attempts: 1 },
        { name: "an old thing works", file: OLD_FILE, attempts: 1 },
      ]);
    }),
  ));

test("a pass with no failed attempt records no flaked tests", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting("passed");
      const result = yield* read(asked, forge);
      expect(result).toMatchObject({ proved: { pass: "ci", job: { name: "nuxi-typecheck" } } });
      expect("proved" in result ? result.proved.job : undefined).not.toHaveProperty("flaked");
    }),
  ));

const PULL = `https://${PROJECT.github}/pull/31`;
const GATE: VerifySpec = { ...NUXI, ci: "test" };

const thenLater = (...stages: ReadonlyArray<{ readonly fetch: FetchLike }>) => {
  let reads = 0;
  const fetch: FetchLike = (input, init) => {
    if (pipe_(input, Str.endsWith("/pulls/31"))) {
      reads++;
    }
    return stages[Math.min(Math.max(reads, 1), stages.length) - 1]!.fetch(input, init);
  };
  return { fetch };
};

test("a GitHub job not yet created while its pipeline still runs is waited on, and its pass proves the check", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting(
          "running",
          PULL,
          undefined,
          { jobs: [{ name: "static", state: "running" }] },
          "github",
        );
        const later = forgeOn("github", at, {
          jobs: [
            { name: "static", state: "passed" },
            { name: "test", state: "passed" },
          ],
        });
        expect(yield* read({ ...asked, spec: GATE }, thenLater(forge, later))).toMatchObject({
          proved: { pass: "ci", name: "nuxi", job: { name: "test" } },
        });
      }),
      1000,
    ),
  ));

test("a GitHub job absent from a head whose check runs have all completed is not in its pipeline, and is not waited on", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        { jobs: [{ name: "static", state: "passed" }] },
        "github",
      );
      expect(yield* read({ ...asked, spec: GATE }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job test on ${pipe_(at, Str.slice(0, 12))} is not in its pipeline`,
        state: "missing",
        url: null,
        log: null,
      });
    }),
  ));

test("a GitHub head with no check runs yet reads as pending", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        { jobs: [] },
        "github",
      );
      expect(yield* read({ ...asked, spec: GATE, wait: false }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job test on ${pipe_(at, Str.slice(0, 12))} is pending`,
        state: "pending",
        url: null,
        log: null,
      });
    }),
  ));

test("a GitHub job absent from a head whose first hundred check runs completed waits on a later one still running", () =>
  runEffect(
    Effect.gen(function* () {
      const completed = Array.from({ length: 100 }, (_, n) => ({
        name: `shard-${n}`,
        state: "passed" as const,
      }));
      const { asked, at, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        { jobs: [...completed, { name: "static", state: "running" }] },
        "github",
      );
      expect(yield* read({ ...asked, spec: GATE, wait: false }, forge)).toMatchObject({
        unproved: `nuxi is left to CI and unproved: job test on ${pipe_(at, Str.slice(0, 12))} is pending`,
        state: "pending",
      });
    }),
  ));

test("a GitHub job missing right after its retry is waited on, and its pass is a Flake proving the check", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting(
          "failed",
          PULL,
          undefined,
          {
            jobs: [
              { name: "static", state: "passed" },
              { name: "test", state: "failed" },
            ],
            base: { at: BASE, jobs: [{ name: "test", state: "passed" }] },
          },
          "github",
        );
        const rerunning = forgeOn("github", at, { jobs: [{ name: "static", state: "passed" }] });
        const rerun = forgeOn("github", at, {
          jobs: [
            { name: "static", state: "passed" },
            { name: "test", state: "passed" },
          ],
        });
        const stages = thenLater(forge, forge, forge, rerunning, rerun);
        expect(yield* read({ ...asked, spec: GATE, settle: true }, stages)).toMatchObject({
          proved: { pass: "ci", name: "nuxi", job: { name: "test" } },
          retried: true,
        });
        expect(
          Arr.flatMap([forge, rerunning, rerun], (one) =>
            Arr.filter(one.requests, (request) =>
              pipe_(request.url, Str.endsWith("/rerun-failed-jobs")),
            ),
          ),
        ).toHaveLength(1);
      }),
      1000,
    ),
  ));

test("a GitHub job whose rerun the forge refuses is read again, and a rerun already going is its pass", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting(
          "failed",
          PULL,
          undefined,
          {
            jobs: [{ name: "test", state: "failed" }],
            workflowRun: { attempt: 1, status: "in_progress" },
            rerunRefused: "403 Already running",
          },
          "github",
        );
        const stage = (over: Partial<FakeMr>) =>
          ({
            installed: true,
            loggedIn: [FORGE_HOST.github],
            login: "me",
            mrs: [{ project: PROJECT.github, iid: "31", state: "open", head: at, ...over }],
          }) satisfies ForgeModel;
        let refused = false;
        let reread = 0;
        const fetch: FetchLike = (input, init) => {
          const answered = forge.fetch(input, init);
          if (pipe_(input, Str.endsWith("/rerun-failed-jobs"))) {
            return answered.then((response) => {
              refused = true;
              forge.set(
                stage({
                  jobs: [{ name: "test", state: "failed" }],
                  workflowRun: { attempt: 2, status: "in_progress" },
                }),
              );
              return response;
            });
          }
          if (refused && pipe_(input, Str.includes("check_name=test"))) {
            return answered.then((response) => {
              reread += 1;
              return response;
            });
          }
          if (refused && reread > 0 && pipe_(input, Str.endsWith("/pulls/31"))) {
            return answered.then((response) => {
              reread = 0;
              forge.set(
                stage({
                  jobs: [
                    {
                      name: "test",
                      state: "passed",
                      id: 101,
                      attempts: [{ id: 1, state: "failed" }],
                    },
                  ],
                }),
              );
              return response;
            });
          }
          return answered;
        };
        expect(yield* read({ ...asked, spec: GATE, settle: true }, { fetch })).toMatchObject({
          proved: { pass: "ci", name: "nuxi", job: { name: "test" } },
          retried: true,
        });
        expect(
          Arr.filter(forge.requests, (request) =>
            pipe_(request.url, Str.endsWith("/rerun-failed-jobs")),
          ),
        ).toHaveLength(1);
      }),
      1000,
    ),
  ));

test("a rerun the forge refuses twice is written once, and the job stays failed", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, forge } = yield* waiting(
          "failed",
          PULL,
          undefined,
          {
            jobs: [{ name: "test", state: "failed" }],
            workflowRun: { attempt: 1, status: "in_progress" },
            rerunRefused: "403 Already running",
          },
          "github",
        );
        const refused = yield* read({ ...asked, spec: GATE, settle: true }, forge);
        expect("proved" in refused).toBe(false);
        expect("unproved" in refused && refused.state).toBe("failed");
        expect(reruns(forge.requests)).toHaveLength(1);
      }),
      1000,
    ),
  ));

const githubLog = (columns: string, ...failed: ReadonlyArray<string>) =>
  Arr.join(
    Arr.map(
      [
        "##[group]Run bun test --parallel=4",
        "bun test v1.4.4",
        "##[group]test/old-thing.test.ts:",
        "##[group]test/new-thing.test.ts:",
        "\u001b[0m\u001b[32m(pass)\u001b[0m an old thing works \u001b[0m\u001b[2m[0.20ms]\u001b[0m",
        ...Arr.flatMap(failed, (name) => [
          `\u001b[0m\u001b[31m(fail)\u001b[0m ${name} \u001b[0m\u001b[2m[1.00ms]\u001b[0m`,
          "##[error]error: expect(received).toBe(expected)",
        ]),
        "##[endgroup]",
      ],
      (line, n) => `${columns}2026-11-11T10:00:${10 + n}.1234567Z ${line}`,
    ),
    "\r\n",
  );
const NEW_TEST = "a new thing settles on its first try";
const GITHUB_BRANCH = { ...BRANCH, [OWN_FILE]: `test("${NEW_TEST}", () => {});\n` };
const ATTEMPT = `https://${PROJECT.github}/actions/runs/4031/job/2`;
const GH_LOG = "gh run view 4031 --log-failed --repo owner/repo";
const reruns = (requests: ReadonlyArray<FakeRequest>) =>
  Arr.filter(requests, (one) => pipe_(one.url, Str.endsWith("/rerun-failed-jobs")));

const notExcused = (name: MrForge, head: ReadonlyArray<FakeJob>, base: ReadonlyArray<FakeJob>) =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "failed",
        name === "gitlab" ? MR : PULL,
        undefined,
        {
          jobs: Arr.map(head, (job) => ({ ...job, retried: "failed" as const })),
          base: { at: BASE, jobs: base },
        },
        name,
      );
      const spec = name === "gitlab" ? NUXI : GATE;
      const result = yield* read({ ...asked, spec, settle: true }, forge);
      expect(result).toMatchObject({ state: "failed" });
      expect("before" in result).toBe(false);
      expect((name === "gitlab" ? retries : reruns)(forge.requests)).toHaveLength(1);
    }),
  );
const OLD_TEST = ["test/old-thing.test.ts", "an old thing works"] as const;
const AGGREGATE = { name: "test", state: "failed", trace: githubLog("") } as const;
const CHECKED = { name: "nuxi-typecheck", state: "failed", trace: trace() } as const;

test("a GitHub failure whose run has a failed job that passes where the branch leaves its target is the Run's own", () =>
  notExcused(
    "github",
    [
      AGGREGATE,
      { name: "suite (1)", state: "failed", trace: githubLog("", NEW_TEST) },
      { name: "desktop-rune", state: "failed", trace: githubLog("", "the rune types are current") },
    ],
    [
      AGGREGATE,
      { name: "suite (1)", state: "failed", trace: githubLog("", NEW_TEST) },
      { name: "desktop-rune", state: "passed" },
    ],
  ));

test("a failure whose failed jobs name no test is the Run's own, though the same jobs fail where the branch leaves its target", () => {
  const jobs = [
    CHECKED,
    { name: "static", state: "failed", trace: "error: format differs\n" },
  ] as const;
  return notExcused("gitlab", jobs, jobs);
});

test("a failure naming a test that does not fail where the branch leaves its target is the Run's own", () =>
  notExcused(
    "gitlab",
    [CHECKED, { name: "suite (1)", state: "failed", trace: trace(OLD_TEST, [OWN_FILE, NEW_TEST]) }],
    [CHECKED, { name: "suite (1)", state: "failed", trace: trace(OLD_TEST) }],
  ));

test("a checked job that failed alone naming no test is the Run's own, though it fails where the branch leaves its target", () =>
  notExcused(
    "gitlab",
    [CHECKED],
    [CHECKED, { name: "suite (1)", state: "failed", trace: trace(OLD_TEST) }],
  ));

test("a failure naming a test that fails where the branch leaves its target only in a job that passes here is the Run's own", () =>
  notExcused(
    "gitlab",
    [CHECKED, { name: "suite (1)", state: "failed", trace: trace(OLD_TEST) }],
    [
      CHECKED,
      {
        name: "suite (1)",
        state: "failed",
        trace: trace(["test/other.test.ts", "another thing works"]),
      },
      { name: "suite (2)", state: "failed", trace: trace(OLD_TEST) },
    ],
  ));

test("a GitHub failure whose shared job's log cannot be read where the branch leaves its target is the Run's own", () =>
  notExcused(
    "github",
    [
      AGGREGATE,
      { name: "suite (1)", state: "failed", trace: githubLog("", "an old thing settles") },
      { name: "suite (2)", state: "failed", trace: githubLog("", "an old thing settles") },
    ],
    [
      AGGREGATE,
      { name: "suite (1)", state: "failed" },
      { name: "suite (2)", state: "failed", trace: githubLog("", "an old thing settles") },
    ],
  ));

test("a failure in a job that failed where the branch leaves its target only in an attempt retried there to a pass is the Run's own", () =>
  notExcused(
    "gitlab",
    [CHECKED, { name: "suite (1)", state: "failed", trace: trace(OLD_TEST) }],
    [
      CHECKED,
      {
        name: "suite (1)",
        state: "passed",
        attempts: [{ id: 902, state: "failed", trace: trace(OLD_TEST) }],
      },
    ],
  ));

test("a GitHub failure whose tests fail in other shards where the branch leaves its target is reported, and not rerun", () =>
  runEffect(
    Effect.gen(function* () {
      const one = { name: "suite (1)", state: "failed" } as const;
      const two = { name: "suite (2)", state: "failed" } as const;
      const { asked, at, forge } = yield* waiting(
        "failed",
        PULL,
        undefined,
        {
          jobs: [
            AGGREGATE,
            { ...one, trace: githubLog("", NEW_TEST) },
            { ...two, trace: githubLog("", "an old thing settles") },
          ],
          base: {
            at: BASE,
            jobs: [
              AGGREGATE,
              { ...one, trace: githubLog("", "an old thing settles") },
              { ...two, trace: githubLog("", NEW_TEST) },
            ],
          },
        },
        "github",
      );
      expect(yield* read({ ...asked, spec: GATE, settle: true }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job test on ${pipe_(at, Str.slice(0, 12))} is failed`,
        state: "failed",
        url: `https://${PROJECT.github}/actions/runs/4031/job/1`,
        log: GH_LOG,
        before: {
          at: BASE,
          url: `https://${PROJECT.github}/actions/runs/5031/job/1001`,
          jobs: ["suite (1)", "suite (2)"],
        },
      });
      expect(reruns(forge.requests)).toEqual([]);
    }),
  ));

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} retried pass of an own test in an explicitly selected Bun file proves nothing`, () =>
    runEffect(
      Effect.gen(function* () {
        const { asked, forge } = yield* waiting(
          "passed",
          name === "gitlab" ? MR : PULL,
          undefined,
          {
            jobs: [
              {
                name: "nuxi-typecheck",
                state: "passed",
                id: 101,
                attempts: [{ id: 1, state: "failed", trace: "test/smoke.ts:\n(fail) works\n" }],
              },
            ],
          },
          name,
          { "test/smoke.ts": 'test("works", () => {});\n' },
        );
        const result = yield* read(asked, forge);
        expect(result).toMatchObject({ state: "failed" });
        expect("unproved" in result ? result.unproved : "").toContain('own test "works"');
        expect(yield* journalOf(asked)).toEqual([]);
      }),
    ));
}

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} job passing twice still fails when its earlier attempt named an own test`, () =>
    runEffect(
      Effect.gen(function* () {
        const { asked, forge } = yield* waiting(
          "passed",
          name === "gitlab" ? MR : PULL,
          undefined,
          {
            jobs: [
              {
                name: "nuxi-typecheck",
                state: "passed",
                id: 201,
                attempts: [
                  { id: 1, state: "failed", trace: `${OWN_FILE}:\n(fail) works\n` },
                  { id: 101, state: "passed" },
                ],
              },
            ],
          },
          name,
          BRANCH,
        );
        const result = yield* read({ ...asked, settle: true }, forge);
        expect(result).toMatchObject({ state: "failed" });
        expect("unproved" in result ? result.unproved : "").toContain('own test "works"');
        expect(yield* journalOf(asked)).toEqual([]);
      }),
    ));
}

test("a GitHub infrastructure failure between an own-test failure and a pass cannot prove the check", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        {
          jobs: [
            {
              name: "test",
              state: "passed",
              id: 201,
              attempts: [
                { id: 1, state: "failed" },
                { id: 101, state: "failed", trace: "runner could not start" },
              ],
            },
            {
              name: "suite (1)",
              state: "passed",
              id: 202,
              attempts: [
                { id: 2, state: "failed", trace: `${OWN_FILE}:\n(fail) works\n` },
                { id: 102, state: "failed", trace: "runner could not start" },
              ],
            },
          ],
        },
        "github",
        BRANCH,
      );
      const result = yield* read({ ...asked, spec: GATE, settle: true }, forge);
      expect(result).toMatchObject({
        state: "failed",
        url: `https://${PROJECT.github}/actions/runs/4031/job/1`,
        log: GH_LOG,
      });
      expect("unproved" in result ? result.unproved : "").toContain('own test "works"');
      expect(yield* journalOf(asked)).toEqual([]);
      expect(reruns(forge.requests)).toEqual([]);
    }),
  ));

for (const name of ["gitlab", "github"] as const) {
  test(`a ${name} failed own test keeps its file when another job names an untouched test the same`, () =>
    runEffect(
      Effect.gen(function* () {
        const { asked, forge } = yield* waiting(
          "passed",
          name === "gitlab" ? MR : PULL,
          undefined,
          {
            jobs: [
              {
                name: "nuxi-typecheck",
                state: "passed",
                id: 201,
                attempts: [{ id: 1, state: "failed" }],
              },
              {
                name: "suite (old)",
                state: "passed",
                id: 203,
                attempts: [
                  { id: 3, state: "failed", trace: "test/old-thing.test.ts:\n(fail) works\n" },
                ],
              },
              {
                name: "suite (new)",
                state: "passed",
                id: 202,
                attempts: [{ id: 2, state: "failed", trace: `${OWN_FILE}:\n(fail) works\n` }],
              },
            ],
          },
          name,
          BRANCH,
        );
        const result = yield* read({ ...asked, settle: true }, forge);
        expect(result).toMatchObject({ state: "failed" });
        expect("unproved" in result ? result.unproved : "").toContain('own test "works"');
        expect(yield* journalOf(asked)).toEqual([]);
      }),
    ));
}

test("a GitHub job that passes its rerun, after a failed suite job named a test the branch adds, is failed", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting(
        "failed",
        PULL,
        undefined,
        {
          jobs: [
            { name: "static", state: "passed" },
            { name: "test", state: "failed", retried: "passed", trace: githubLog("") },
            {
              name: "suite (2)",
              state: "failed",
              retried: "passed",
              trace: githubLog("", NEW_TEST),
            },
          ],
          base: { at: BASE, jobs: [{ name: "test", state: "passed" }] },
        },
        "github",
        GITHUB_BRANCH,
      );
      expect(yield* read({ ...asked, spec: GATE, settle: true }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job test on ${pipe_(at, Str.slice(0, 12))} failed in this branch's own test "${NEW_TEST}", and passed only when retried`,
        state: "failed",
        url: ATTEMPT,
        log: GH_LOG,
      });
      expect(reruns(forge.requests)).toHaveLength(1);
      expect(yield* journalOf(asked)).toEqual([]);
    }),
  ));

test("a GitHub job whose newest check run passed after an older one failed, in a scenario the branch adds, is failed", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        {
          jobs: [
            { name: "static", state: "passed" },
            { name: "test", state: "passed", id: 102, attempts: [{ id: 2, state: "failed" }] },
            {
              name: "suite (2)",
              state: "passed",
              id: 103,
              attempts: [
                {
                  id: 3,
                  state: "failed",
                  trace: githubLog("suite (2)\tRun bun test\t", `${SCENARIO} [unrelated 4]`),
                },
              ],
            },
          ],
        },
        "github",
        GITHUB_BRANCH,
      );
      const result = yield* read({ ...asked, spec: GATE, settle: true }, forge);
      expect(result).toMatchObject({ state: "failed", url: ATTEMPT, log: GH_LOG });
      expect("unproved" in result ? result.unproved : "").toContain(
        `this branch's own test "${SCENARIO} [unrelated 4]", and passed only when retried`,
      );
      expect(reruns(forge.requests)).toEqual([]);
      expect(yield* journalOf(asked)).toEqual([]);
    }),
  ));

test("a GitHub retried pass whose failed attempt's job logs cannot be read proves the check, marked retried with no flaked test", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, forge } = yield* waiting(
        "passed",
        PULL,
        undefined,
        {
          jobs: [
            { name: "test", state: "passed", id: 102, attempts: [{ id: 2, state: "failed" }] },
          ],
        },
        "github",
        GITHUB_BRANCH,
      );
      expect(yield* read({ ...asked, spec: GATE }, forge)).toMatchObject({
        proved: { pass: "ci", name: "nuxi", job: { name: "test", flaked: [] } },
        retried: true,
      });
      expect(yield* journalOf(asked)).toHaveLength(1);
    }),
  ));

const CONFLICT = (at: string) =>
  `nuxi is left to CI and unproved: the merge request conflicts with its target branch at ${pipe_(at, Str.slice(0, 12))}, and its branch must take the target`;
const jobReads = (requests: ReadonlyArray<FakeRequest>) =>
  Arr.filter(requests, (one) => /check-runs\?check_name=|\/pipelines\/\d+\/jobs/.test(one.url));

for (const [name, mr, spec] of [
  ["github", PULL, GATE],
  ["gitlab", MR, NUXI],
] as const) {
  test(`a ${name} job missing from a merge request that conflicts with its target says so, and is not waited on`, () =>
    runEffect(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting(
          "passed",
          mr,
          undefined,
          {
            jobs: [{ name: "static", state: "passed" }],
            mergeable: "conflict",
          },
          name,
        );
        expect(yield* read({ ...asked, spec }, forge)).toEqual({
          unproved: CONFLICT(at),
          state: "missing",
          url: null,
          log: null,
          conflicts: true,
        });
        expect(jobReads(forge.requests)).toHaveLength(1);
      }),
    ));
}

for (const [name, mr, spec, none] of [
  ["github", PULL, GATE, { jobs: [] }],
  ["gitlab", MR, NUXI, { jobs: undefined }],
] as const) {
  test(`a ${name} merge request with no pipeline that conflicts with its target says so, and is not waited on`, () =>
    runEffect(
      fastForward(
        Effect.gen(function* () {
          const { asked, at, forge } = yield* waiting(
            "passed",
            mr,
            undefined,
            { ...none, mergeable: "conflict" },
            name,
          );
          expect(yield* read({ ...asked, spec }, forge)).toMatchObject({
            unproved: CONFLICT(at),
            conflicts: true,
          });
        }),
        600_000,
      ),
    ));
}

test("a job running in its pipeline while its merge request conflicts is still the job's to finish", () =>
  runEffect(
    Effect.gen(function* () {
      const { asked, at, forge } = yield* waiting("running", MR, undefined, {
        mergeable: "conflict",
      });
      const got = yield* read({ ...asked, wait: false }, forge);
      expect(got).toMatchObject({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is running`,
        state: "running",
      });
      expect(got).not.toHaveProperty("conflicts");
    }),
  ));

test("a job missing while the forge has not said whether it can merge is waited on, and its pass proves the check", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const { asked, at, forge } = yield* waiting(
          "passed",
          PULL,
          undefined,
          {
            jobs: [{ name: "static", state: "passed" }],
            mergeable: "checking",
          },
          "github",
        );
        const later = forgeOn("github", at, {
          jobs: [
            { name: "static", state: "passed" },
            { name: "test", state: "passed" },
          ],
        });
        let reads = 0;
        const fetch: FetchLike = (input, init) => {
          if (pipe_(input, Str.includes("check-runs?check_name="))) {
            reads++;
          }
          return (reads < 2 ? forge : later).fetch(input, init);
        };
        expect(yield* read({ ...asked, spec: GATE }, { fetch })).toMatchObject({
          proved: { pass: "ci", name: "nuxi", job: { name: "test" } },
        });
      }),
      1000,
    ),
  ));
