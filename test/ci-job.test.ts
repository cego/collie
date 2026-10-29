// A check left to CI waits on its job through the forge, and says what it waits on while it
// does (ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schedule } from "effect";
import { ciJob } from "../src/ci-job";
import type { MrForge } from "../src/board-model";
import type { Runner } from "../src/mr";
import type { FetchLike } from "forges";
import { readVerifications, verifyingIn, type CheckCommand } from "../src/verify";
import type { VerifySpec } from "../src/verify-spec";
import { exec } from "./support/command";
import { fastForward, runEffect } from "./support/effect";
import { forgeHttpTest } from "../src/forge/http";
import {
  FORGE_HOST,
  PROJECT,
  fakeForge,
  type FakeJob,
  type FakeMr,
  type FakeRequest,
} from "./support/forge";

const NUXI: VerifySpec = {
  name: "nuxi",
  executable: "bunx",
  argv: ["nuxi", "typecheck"],
  cwd: ".",
  ci: "nuxi-typecheck",
};
const MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;

/** A Run's directories, a checkout at one commit, and a forge whose merge request is on `head`. */
const waiting = Effect.fn("ciJob.waiting")(function* (
  state: FakeJob["state"],
  mr: string | null = MR,
  head?: string,
  over: Partial<FakeMr> = {},
  name: MrForge = "gitlab",
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
  ])
    yield* exec(["git", ...args], { cwd });
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

/** `ciJob` asking the fake forge, its credential reads through the Run's runner. */
const read = (
  asked: Parameters<typeof ciJob>[0] & { readonly run: Runner },
  forge: { readonly fetch: FetchLike },
) => ciJob(asked).pipe(Effect.provide(forgeHttpTest(asked.run, forge.fetch)));

/** Its runner, committing in the checkout on every call, as a commit made while the job is read. */
const committing =
  (asked: { readonly cwd: string; readonly run: Runner }): Runner =>
  (cmd, args, where) =>
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
        verifyingIn(asked.runDir).pipe(Effect.filterOrFail((one) => one !== null)),
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
      // As a merge stops the Run while it waits.
      yield* Fiber.interrupt(fiber);
      expect(yield* verifyingIn(asked.runDir)).toBeNull();
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
        // Every 30 s, so about 240 reads.
        expect(
          Arr.filter(forge.requests, (one) => pipe_(one.url, Str.includes("/jobs"))).length,
        ).toBeGreaterThan(200);
        expect(yield* verifyingIn(asked.runDir)).toBeNull();
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
      // Its job rerun and failed on the same commit: the job's state now, the proof kept as it was.
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
      // However git is set to show untracked files.
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
      const { asked, at, forge } = yield* waiting("failed", MR, undefined, {
        base: { at: BASE, jobs: [{ name: "nuxi-typecheck", state: "failed" }] },
      });
      expect(yield* read({ ...asked, settle: true }, forge)).toEqual({
        unproved: `nuxi is left to CI and unproved: job nuxi-typecheck on ${pipe_(at, Str.slice(0, 12))} is failed`,
        state: "failed",
        url: `https://${PROJECT.gitlab}/-/jobs/1`,
        log: LOG,
        before: { at: BASE, url: `https://${PROJECT.gitlab}/-/jobs/1001` },
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
          // The retry's own job.
          url: `https://${PROJECT.gitlab}/-/jobs/101`,
          log: `glab ci trace 101 --repo ${PROJECT.gitlab}`,
        });
        expect(retries(forge.requests)).toHaveLength(1);
      }
      // Without `settle`, a failure is only read.
      const { asked, forge } = yield* waiting("failed");
      expect(yield* read(asked, forge)).toMatchObject({ state: "failed", log: LOG });
      expect(
        Arr.some(forge.requests, (one) => pipe_(one.url, Str.includes("pipelines?sha="))),
      ).toBe(false);
      expect(retries(forge.requests)).toEqual([]);
    }),
  ));

const PULL = `https://${PROJECT.github}/pull/31`;
const GATE: VerifySpec = { ...NUXI, ci: "test" };

/** `now`'s forge for the first read of the job, `later`'s from the next. */
const thenLater = (now: { readonly fetch: FetchLike }, later: { readonly fetch: FetchLike }) => {
  let reads = 0;
  const fetch: FetchLike = (input, init) => {
    if (pipe_(input, Str.endsWith("/pulls/31"))) reads++;
    return (reads > 1 ? later : now).fetch(input, init);
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
      1_000,
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
