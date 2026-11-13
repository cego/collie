// ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Duration, Effect, FileSystem } from "effect";
import { mrRefOf } from "./board-model";
import { checkProof } from "./check-proof";
import { forgeOf, type JobState } from "./forge/forge";
import type { MrRef } from "./board-model";
import { noteVerification } from "./metrics";
import { shell, type Runner } from "./mr";
import { appendLog } from "./oversight";
import { conflictsWithTarget } from "./review-wait";
import { epochMs, nowIso } from "./time";
import { rememberCiTarget } from "./park-recheck";
import { branchChange, ownTests, type BranchChange, type FailedTest } from "./own-tests";
import {
  appendVerification,
  encodeVerifying,
  fingerprint,
  readVerifications,
  VERIFYING_FILE,
  type CheckCommand,
  type Verification,
} from "./verify";
import type { VerifySpec } from "./verify-spec";

/** How often a job still pending or running is read again. */
export const CI_POLL = Duration.seconds(30);
/** How long a Run waits on one, matching the default Output budget. */
export const CI_BOUND = Duration.hours(2);

/** What became of a check left to CI: its recorded pass, or why it is unproved. */
export type CiJob =
  | {
      readonly proved: Verification;
      /** It failed in no test of the branch's own, and passed when retried: a Flake. */
      readonly retried?: true;
    }
  | {
      readonly unproved: string;
      /** The job's state where the forge said one, else null. */
      readonly state: JobState | null;
      readonly url: string | null;
      /** The command that prints its log, where there is such a job. */
      readonly log: string | null;
      /**
       * It failed where the branch leaves its target too, or with `branch` on that target
       * branch's newest commit: not this Run's to fix.
       */
      readonly before?: {
        readonly at: string;
        readonly url: string | null;
        readonly branch?: string;
      };
      /** Missing because the merge request conflicts with its target branch. */
      readonly conflicts?: true;
    };

/** The same job failed on the target branch's newest commit, and which of `failed`'s tests failed there too. */
export interface TargetFailure {
  readonly job: string;
  readonly branch: string;
  readonly at: string;
  readonly url: string | null;
  readonly tests: ReadonlyArray<FailedTest>;
  /** Every test `failed` names failed there too, or it names none: the failure is the target's. */
  readonly shared: boolean;
}

const sameTest = (one: FailedTest, other: FailedTest) =>
  one.name === other.name && (one.file === null || other.file === null || one.file === other.file);

/** Job `job`, failed in attempt `failed`, compared with the target's newest commit; null where it did not fail there. */
export const targetFailure = Effect.fn("CiJob.targetFailure")(function* <R>(
  ref: MrRef,
  job: string,
  failed: string | null,
  cwd: string,
  run: Runner<R>,
) {
  const forge = forgeOf(ref);
  const there = yield* forge.targetJob(ref, job, cwd, run);
  if (!there.ok || there.state !== "failed" || there.at === null) return null;
  const mine = failed === null ? [] : (yield* forge.failedAttempt(ref, failed, cwd, run)).tests;
  const theirs =
    mine.length === 0 || there.id === null
      ? []
      : (yield* forge.failedAttempt(ref, there.id, cwd, run)).tests;
  const tests = Arr.filter(mine, (one) => Arr.some(theirs, (other) => sameTest(one, other)));
  return {
    job,
    branch: there.branch,
    at: there.at,
    url: there.url,
    tests,
    shared: tests.length === mine.length,
  } satisfies TargetFailure;
});

/**
 * The failure of `jobs` on the merge request's head, where every one of them that failed there
 * failed on the target branch's newest commit too, test by test; else null.
 */
export const sharedFailure = Effect.fn("CiJob.sharedFailure")(function* <R>(
  ref: MrRef,
  jobs: ReadonlyArray<string>,
  cwd: string,
  run: Runner<R>,
) {
  const forge = forgeOf(ref);
  let shared: TargetFailure | null = null;
  for (const job of jobs) {
    const read = yield* forge.job(ref, job, cwd, run);
    if (!read.ok) return null;
    if (read.state !== "failed") continue;
    const target = yield* targetFailure(ref, job, read.id, cwd, run);
    if (target?.shared !== true) return null;
    shared ??= target;
  }
  return shared;
});

/** What a Release parked on a failure its target shared does once that target passes. */
export type TakeTarget =
  | { readonly _tag: "Moved"; readonly head: string }
  /** The source branch has the target's newest commit already, so its failed jobs were retried. */
  | { readonly _tag: "Retried" }
  | { readonly _tag: "Take" };

/** `head`, where the failure was the target's: moved since, or the target to take, or retried where taken. */
export const takeTarget = Effect.fn("CiJob.takeTarget")(function* <R>(
  ref: MrRef,
  jobs: ReadonlyArray<string>,
  head: string,
  cwd: string,
  run: Runner<R>,
) {
  const forge = forgeOf(ref);
  const failed: string[] = [];
  let newest: string | null = null;
  for (const job of jobs) {
    const read = yield* forge.job(ref, job, cwd, run);
    if (!read.ok) return { _tag: "Take" } satisfies TakeTarget;
    if (read.head !== head) return { _tag: "Moved", head: read.head } satisfies TakeTarget;
    if (read.state === "failed" && read.id !== null) failed.push(read.id);
    if (newest === null) {
      const there = yield* forge.targetJob(ref, job, cwd, run);
      if (there.ok && there.at !== null) {
        yield* shell("git", ["fetch", "-q", "origin", there.branch], cwd);
        newest = there.at;
      }
    }
  }
  const taken =
    newest !== null &&
    (yield* shell("git", ["merge-base", "--is-ancestor", newest, head], cwd)).code === 0;
  if (!taken) return { _tag: "Take" } satisfies TakeTarget;
  for (const id of failed) yield* forge.retryJob(ref, id, cwd, run);
  return { _tag: "Retried" } satisfies TakeTarget;
});

export const ciJob = Effect.fn("CiJob.read")(function* <R>(asked: {
  readonly runId: string;
  readonly runDir: string;
  readonly journal: string;
  readonly cwd: string;
  readonly spec: VerifySpec;
  readonly command: CheckCommand;
  /** The merge request the Run recorded, however it was found. */
  readonly mr: string | null;
  /** Read again while the job is pending or running, up to `CI_BOUND`. */
  readonly wait: boolean;
  /**
   * A failed job is read where the branch leaves its target, and retried once and waited on
   * where it did not fail there too (ADR-0034).
   */
  readonly settle?: boolean;
  readonly run: Runner<R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { spec, cwd } = asked;
  const job = spec.ci ?? "";
  // The tree a pass is bound to, read again before it is recorded.
  const tree = yield* fingerprint(cwd);
  const head = tree.head_sha;
  yield* rememberCiTarget(asked.runDir, { head, job, mr: asked.mr, cwd }).pipe(Effect.orDie);
  let alsoTarget = "";
  const unproved = (
    why: string,
    state: JobState | null = null,
    url: string | null = null,
    log: string | null = null,
  ) =>
    ({
      unproved: `${spec.name} is left to CI and unproved: job ${job} on ${pipe_(head, Str.slice(0, 12))} ${why}${alsoTarget}`,
      state,
      url,
      log,
    }) satisfies CiJob;
  const journal = () => readVerifications(asked.journal).pipe(Effect.orElseSucceed(() => []));
  const recorded = checkProof(
    { verifications: yield* journal(), final: tree, commands: [asked.command] },
    spec.name,
  ).last;
  if (head === "")
    return {
      unproved: `${spec.name} is left to CI and unproved: job ${job} was never read: ${cwd}'s HEAD could not be read`,
      state: null,
      url: null,
      log: null,
    } satisfies CiJob;
  const ref = mrRefOf(asked.mr);
  if (ref === null)
    return recorded === undefined
      ? unproved("was never read: this Run has no merge request")
      : { proved: recorded };
  const forge = forgeOf(ref);
  const marker = `${asked.runDir}/${VERIFYING_FILE}`;
  const began = yield* Clock.currentTimeMillis;
  let waiting = false;
  let retried: string | null = null;
  return yield* Effect.gen(function* () {
    for (;;) {
      const read = yield* forge.job(ref, job, cwd, asked.run);
      if (!read.ok) return unproved(`could not be read: ${read.reason}`);
      // The forge has not seen the push or the retry yet, or the merge request moved on without this checkout.
      let state =
        read.head !== head ||
        (retried !== null && read.state === "missing") ||
        (read.id === retried && read.state === "failed")
          ? "pending"
          : read.state;
      const log = read.id === null ? null : forge.jobLog(ref, read.id);
      if (state === "failed" && asked.settle === true && retried === null) {
        const target = yield* targetFailure(ref, job, read.id, cwd, asked.run);
        if (target?.shared === true)
          return {
            ...unproved("is failed", state, read.url, log),
            before: { at: target.at, url: target.url, branch: target.branch },
          } satisfies CiJob;
        if (target !== null && target.tests.length > 0)
          alsoTarget = `; of its failed tests, ${Arr.join(
            Arr.map(target.tests, (one) => `"${one.name}"`),
            ", ",
          )} also ${target.tests.length === 1 ? "fails" : "fail"} on ${target.branch} at ${pipe_(target.at, Str.slice(0, 12))}`;
        const base = yield* forge.baseJob(ref, job, cwd, asked.run);
        if (base.ok && base.state === "failed") {
          const before: CiJob = {
            ...unproved("is failed", state, read.url, log),
            before: { at: base.at, url: base.url },
          };
          return before;
        }
        if (read.id !== null && (yield* forge.retryJob(ref, read.id, cwd, asked.run)).ok) {
          retried = read.id;
          yield* appendLog(asked.runDir, `ci: retried job ${job} for ${spec.name} on ${head}`).pipe(
            Effect.ignore,
          );
          continue;
        }
      }
      if (state === "passed") {
        const now = yield* fingerprint(cwd);
        if (now.head_sha !== head || now.fingerprint !== tree.fingerprint)
          return unproved(`passed, but ${cwd} has moved off it since`);
        const status = yield* shell("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
        if (status.code !== 0 || Str.trim(status.stdout) !== "")
          return unproved(`passed, but ${cwd} has changes it never saw`);
        const attempts = Arr.dedupe([...read.retryOf, ...(retried === null ? [] : [retried])]);
        let change: BranchChange | undefined;
        for (const attempt of attempts) {
          const failed = yield* forge.failedAttempt(ref, attempt, cwd, asked.run);
          const own =
            failed.tests.length === 0 || read.target === null
              ? []
              : ownTests(failed.tests, (change ??= yield* branchChange(cwd, read.target)));
          if (own.length > 0)
            return unproved(
              `failed in this branch's own ${own.length === 1 ? "test" : "tests"} ${Arr.join(
                Arr.map(own, (one) => `"${one.name}"`),
                ", ",
              )}, and passed only when retried`,
              "failed",
              failed.url,
              forge.jobLog(ref, attempt),
            );
        }
        const flake = attempts.length === 0 ? {} : { retried: true as const };
        if (recorded !== undefined && retried === null) return { proved: recorded, ...flake };
        const at = yield* nowIso;
        const ran = { name: job, url: read.url };
        const proof: Verification = {
          id: `${asked.runId}-${spec.name}-${epochMs(at)}`,
          run: asked.runId,
          name: spec.name,
          executable: asked.command.executable ?? spec.executable,
          argv: [...spec.argv],
          cwd: asked.command.cwd,
          start: tree,
          end: tree,
          exit: 0,
          seconds: 0,
          tail: { stdout: read.url ?? "", stderr: "" },
          expect: "pass",
          result: "pass",
          at,
          by: "collie",
          pass: "ci",
          job: read.merge === null ? ran : { ...ran, merge: read.merge },
        };
        yield* appendVerification(asked.journal, proof).pipe(Effect.orDie);
        yield* noteVerification(asked.journal, proof);
        yield* appendLog(
          asked.runDir,
          `ci: ${spec.name} proved by job ${job} on ${head}${read.merge === null ? "" : ` (merged-results pipeline at ${read.merge})`}: ${read.url ?? "no URL"}`,
        ).pipe(Effect.ignore);
        return { proved: proof, ...flake };
      }
      // A forge with no pipeline for the head says pending, without a job.
      const absent =
        state === "missing" ||
        (state === "pending" && read.head === head && read.id === null && read.url === null);
      if (absent && retried === null) {
        const review = yield* forge.readReview(ref, cwd, asked.run);
        const mergeable = review.ok ? review.mergeable : null;
        if (conflictsWithTarget(mergeable))
          return {
            unproved: `${spec.name} is left to CI and unproved: the merge request conflicts with its target branch at ${pipe_(head, Str.slice(0, 12))}, and its branch must take the target`,
            state,
            url: read.url,
            log,
            conflicts: true,
          } satisfies CiJob;
        // The forge runs no pipeline until it has said whether it can merge.
        if (mergeable?.state === "unknown") state = "pending";
      }
      if (state !== "pending" && state !== "running")
        return unproved(
          state === "missing" ? "is not in its pipeline" : `is ${state}`,
          state,
          read.url,
          log,
        );
      if (!asked.wait && retried === null) return unproved(`is ${state}`, state, read.url, log);
      if ((yield* Clock.currentTimeMillis) - began >= Duration.toMillis(CI_BOUND))
        return unproved(`is still ${state} after 2 hours`, state, read.url, log);
      if (!waiting) {
        waiting = true;
        yield* appendLog(
          asked.runDir,
          `ci: waiting on job ${job} for ${spec.name} on ${head}`,
        ).pipe(Effect.ignore);
        yield* fs
          .writeFileString(
            marker,
            encodeVerifying({
              name: spec.name,
              executable: spec.executable,
              argv: spec.argv,
              pass: "ci",
              round: null,
              revision: head,
              base: null,
              started: yield* nowIso,
              job,
            }),
          )
          .pipe(Effect.ignore);
      }
      yield* Effect.sleep(CI_POLL);
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => (waiting ? fs.remove(marker).pipe(Effect.ignore) : Effect.void)),
    ),
  );
});
