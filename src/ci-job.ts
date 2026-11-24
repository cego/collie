import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Clock, Duration, Effect, Option } from "effect";
import { mrRefOf } from "./board-model";
import { checkProof } from "./check-proof";
import { forgeOf } from "./forge/forge";
import type { FailedAttempt, FailedJob, JobState } from "./forge/forge";
import type { MrRef } from "./board-model";
import { noteVerification } from "./metrics";
import { shell } from "./mr";
import type { Runner } from "./mr";
import { appendLog } from "./oversight";
import { conflictsWithTarget } from "./review-wait";
import { epochMs, nowIso } from "./time";
import { rememberCiTarget } from "./park-recheck";
import { branchChange, ownTests } from "./own-tests";
import type { BranchChange, FailedTest } from "./own-tests";
import { appendVerification, encodeVerifying, fingerprint, readVerifications } from "./verify";
import type { CheckCommand, Verification } from "./verify";
import type { VerifySpec } from "./verify-spec";
import type { Control } from "./controls";

export const CI_POLL = Duration.seconds(30);
// WARNING: matches the default Output budget; change them together.
export const CI_BOUND = Duration.hours(2);

export type CiJob =
  | {
      readonly proved: Verification;
      readonly retried?: true;
    }
  | {
      readonly unproved: string;
      readonly state: JobState | null;
      readonly url: string | null;
      readonly log: string | null;
      readonly before?: {
        readonly at: string;
        readonly url: string | null;
        readonly branch?: string;
        readonly jobs: ReadonlyArray<string>;
      };
      readonly conflicts?: true;
    };

// WARNING: only the job itself may name no failed test, and only beside others (#460).
const sharedJobs = (job: string, head: FailedAttempt, base: FailedAttempt) => {
  const here = head.jobs;
  if (here === null || base.jobs === null || here.length === 0) {
    return null;
  }
  const others = Arr.filter(here, (one) => one.name !== job);
  const there = Arr.filter(base.jobs, (failed) =>
    Arr.some(here, (one) => one.name === failed.name),
  );
  if (Arr.some(there, (one) => one.tests === null)) {
    return null;
  }
  const failedThere = Arr.flatMap(there, (one) => one.tests ?? []);
  const shared = (one: FailedJob) =>
    one.tests !== null &&
    (one.name === job
      ? one.tests.length > 0 || others.length > 0
      : one.tests.length > 0 && Arr.some(there, (failed) => failed.name === one.name)) &&
    Arr.every(one.tests, (test) =>
      Arr.some(failedThere, (failed) => failed.name === test.name && failed.file === test.file),
    );
  if (!Arr.every(here, shared)) {
    return null;
  }
  return others.length === 0 ? [job] : Arr.map(others, (one) => one.name);
};

export interface TargetFailure {
  readonly job: string;
  readonly branch: string;
  readonly at: string;
  readonly url: string | null;
  readonly tests: ReadonlyArray<FailedTest>;
  readonly jobs: ReadonlyArray<string> | null;
}

const sameTestExactly = (one: FailedTest, other: FailedTest) =>
  one.name === other.name && one.file === other.file;

const sameTest = (one: FailedTest, other: FailedTest) =>
  one.name === other.name && (one.file === null || other.file === null || one.file === other.file);

export const targetFailure = Effect.fn("CiJob.targetFailure")(function* <R>(
  ref: MrRef,
  job: string,
  failed: string | null,
  cwd: string,
  run: Runner<R>,
) {
  const forge = forgeOf(ref);
  const there = yield* forge.targetJob(ref, job, cwd, run);
  if (!there.ok || there.state !== "failed" || there.at === null) {
    return null;
  }
  const unread: FailedAttempt = { url: null, tests: [], jobs: null };
  const mine = failed === null ? unread : yield* forge.failedAttempt(ref, failed, cwd, run);
  const theirs = there.id === null ? unread : yield* forge.failedAttempt(ref, there.id, cwd, run);
  return {
    job,
    branch: there.branch,
    at: there.at,
    url: there.url,
    tests: Arr.filter(mine.tests, (one) => Arr.some(theirs.tests, (other) => sameTest(one, other))),
    jobs: sharedJobs(job, mine, theirs),
  } satisfies TargetFailure;
});

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
    if (!read.ok) {
      return null;
    }
    if (read.state !== "failed") {
      continue;
    }
    const target = yield* targetFailure(ref, job, read.id, cwd, run);
    if (target === null || target.jobs === null) {
      return null;
    }
    shared ??= target;
  }
  return shared;
});

export type TakeTarget =
  | { readonly _tag: "Moved"; readonly head: string }
  | { readonly _tag: "Retried" }
  | { readonly _tag: "Take" };

export const takeTarget = Effect.fn("CiJob.takeTarget")(function* <R>(
  ref: MrRef,
  jobs: ReadonlyArray<string>,
  head: string,
  cwd: string,
  run: Runner<R>,
) {
  const forge = forgeOf(ref);
  const failed: Array<string> = [];
  let newest: string | null = null;
  for (const job of jobs) {
    const read = yield* forge.job(ref, job, cwd, run);
    if (!read.ok) {
      return { _tag: "Take" } satisfies TakeTarget;
    }
    if (read.head !== head) {
      return { _tag: "Moved", head: read.head } satisfies TakeTarget;
    }
    if (read.state === "failed" && read.id !== null) {
      failed.push(read.id);
    }
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
  if (!taken) {
    return { _tag: "Take" } satisfies TakeTarget;
  }
  for (const id of failed) {
    yield* forge.retryJob(ref, id, cwd, run);
  }
  return { _tag: "Retried" } satisfies TakeTarget;
});

export const ciJob = Effect.fn("CiJob.read")(function* <R>(asked: {
  readonly runId: string;
  readonly runDir: string;
  readonly journal: string;
  readonly cwd: string;
  readonly spec: VerifySpec;
  readonly command: CheckCommand;
  readonly mr: string | null;
  readonly wait: boolean;
  readonly settle?: boolean;
  readonly bound?: Duration.Input;
  readonly poll?: Duration.Input;
  readonly verifying: Control;
  readonly run: Runner<R>;
}) {
  const { spec, cwd } = asked;
  const job = spec.ci ?? "";
  // WARNING: the tree is read again before a pass is recorded, so it binds to the tree it ran on.
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
  if (head === "") {
    return {
      unproved: `${spec.name} is left to CI and unproved: job ${job} was never read: ${cwd}'s HEAD could not be read`,
      state: null,
      url: null,
      log: null,
    } satisfies CiJob;
  }
  const ref = mrRefOf(asked.mr);
  if (ref === null) {
    return recorded === undefined
      ? unproved("was never read: this Run has no merge request")
      : { proved: recorded };
  }
  const forge = forgeOf(ref);
  const began = yield* Clock.currentTimeMillis;
  const bound = Duration.toMillis(asked.bound ?? CI_BOUND);
  const poll = asked.poll ?? CI_POLL;
  let waiting = false;
  let retried: string | null = null;
  let reread = false;
  return yield* Effect.gen(function* () {
    for (;;) {
      const read = yield* forge.job(ref, job, cwd, asked.run);
      if (!read.ok) {
        return unproved(`could not be read: ${read.reason}`);
      }
      // WARNING: pending may mean the forge has not seen the push or retry yet, or the MR moved on without this checkout.
      let state =
        read.head !== head ||
        (retried !== null && read.state === "missing") ||
        (read.id === retried && read.state === "failed")
          ? "pending"
          : read.state;
      const log = read.id === null ? null : forge.jobLog(ref, read.id);
      if (state === "failed" && asked.settle === true && retried === null) {
        const target = yield* targetFailure(ref, job, read.id, cwd, asked.run);
        if (target !== null && target.jobs !== null) {
          return {
            ...unproved("is failed", state, read.url, log),
            before: { at: target.at, url: target.url, branch: target.branch, jobs: target.jobs },
          } satisfies CiJob;
        }
        if (target !== null && target.tests.length > 0) {
          alsoTarget = `; of its failed tests, ${Arr.join(
            Arr.map(target.tests, (one) => `"${one.name}"`),
            ", ",
          )} also ${target.tests.length === 1 ? "fails" : "fail"} on ${target.branch} at ${pipe_(target.at, Str.slice(0, 12))}`;
        }
        const base = yield* forge.baseJob(ref, job, cwd, asked.run);
        if (base.ok && base.state === "failed" && base.id !== null && read.id !== null) {
          const jobs = sharedJobs(
            job,
            yield* forge.failedAttempt(ref, read.id, cwd, asked.run),
            yield* forge.failedAttempt(ref, base.id, cwd, asked.run),
          );
          if (jobs !== null) {
            const before: CiJob = {
              ...unproved("is failed", state, read.url, log),
              before: { at: base.at, url: base.url, jobs },
            };
            return before;
          }
        }
        if (read.id !== null && (yield* forge.retryJob(ref, read.id, cwd, asked.run)).ok) {
          retried = read.id;
          yield* appendLog(asked.runDir, `ci: retried job ${job} for ${spec.name} on ${head}`).pipe(
            Effect.ignore,
          );
          continue;
        }
        // WARNING: a refused retry is often a rerun someone else already started; read again before calling it failed.
        if (read.id !== null && !reread) {
          reread = true;
          continue;
        }
      }
      if (state === "passed") {
        const now = yield* fingerprint(cwd);
        if (now.head_sha !== head || now.fingerprint !== tree.fingerprint) {
          return unproved(`passed, but ${cwd} has moved off it since`);
        }
        const status = yield* shell("git", ["status", "--porcelain", "--untracked-files=all"], cwd);
        if (status.code !== 0 || Str.trim(status.stdout) !== "") {
          return unproved(`passed, but ${cwd} has changes it never saw`);
        }
        const attempts = Arr.dedupe([...read.retryOf, ...(retried === null ? [] : [retried])]);
        let change: BranchChange | undefined;
        const flaked: Array<{ name: string; file: string | null; attempts: number }> = [];
        for (const attempt of attempts) {
          const failed = yield* forge.failedAttempt(ref, attempt, cwd, asked.run);
          const own =
            failed.tests.length === 0 || read.target === null
              ? []
              : ownTests(failed.tests, (change ??= yield* branchChange(cwd, read.target)));
          if (own.length > 0) {
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
          for (const test of Arr.dedupeWith(failed.tests, sameTestExactly)) {
            const seen = Arr.findFirst(flaked, (one) => sameTestExactly(one, test));
            if (Option.isSome(seen)) {
              seen.value.attempts++;
            } else {
              flaked.push({ name: test.name, file: test.file, attempts: 1 });
            }
          }
        }
        const flake = attempts.length === 0 ? {} : { retried: true as const };
        if (recorded !== undefined && retried === null) {
          return { proved: recorded, ...flake };
        }
        const at = yield* nowIso;
        const ran =
          attempts.length === 0
            ? { name: job, url: read.url }
            : { name: job, url: read.url, flaked };
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
      // WARNING: a forge with no pipeline for the head says pending, without a job.
      const absent =
        state === "missing" ||
        (state === "pending" && read.head === head && read.id === null && read.url === null);
      if (absent && retried === null) {
        const review = yield* forge.readReview(ref, cwd, asked.run);
        const mergeable = review.ok ? review.mergeable : null;
        if (conflictsWithTarget(mergeable)) {
          return {
            unproved: `${spec.name} is left to CI and unproved: the merge request conflicts with its target branch at ${pipe_(head, Str.slice(0, 12))}, and its branch must take the target`,
            state,
            url: read.url,
            log,
            conflicts: true,
          } satisfies CiJob;
        }
        // WARNING: the forge runs no pipeline until it has said whether it can merge.
        if (mergeable?.state === "unknown") {
          state = "pending";
        }
      }
      if (state !== "pending" && state !== "running") {
        return unproved(
          state === "missing" ? "is not in its pipeline" : `is ${state}`,
          state,
          read.url,
          log,
        );
      }
      if (!asked.wait && retried === null) {
        return unproved(`is ${state}`, state, read.url, log);
      }
      if ((yield* Clock.currentTimeMillis) - began >= bound) {
        return unproved(`is still ${state} after 2 hours`, state, read.url, log);
      }
      if (!waiting) {
        waiting = true;
        yield* appendLog(
          asked.runDir,
          `ci: waiting on job ${job} for ${spec.name} on ${head}`,
        ).pipe(Effect.ignore);
        yield* asked.verifying.set(
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
        );
      }
      yield* Effect.sleep(poll);
    }
  }).pipe(
    Effect.ensuring(Effect.suspend(() => (waiting ? asked.verifying.set(null) : Effect.void))),
  );
});
