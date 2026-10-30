// ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job

import { Clock, Duration, Effect, FileSystem } from "effect";
import { mrRefOf } from "./board-model";
import { checkProof } from "./check-proof";
import { forgeOf, type JobState } from "./forge/forge";
import { noteVerification } from "./metrics";
import { shell, type Runner } from "./mr";
import { appendLog } from "./oversight";
import { epochMs, nowIso } from "./time";
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
      /** It failed, and passed when retried: a Flake. */
      readonly retried?: true;
    }
  | {
      readonly unproved: string;
      /** The job's state where the forge said one, else null. */
      readonly state: JobState | null;
      readonly url: string | null;
      /** The command that prints its log, where there is such a job. */
      readonly log: string | null;
      /** It failed where the branch leaves its target too: not this Run's to fix. */
      readonly before?: { readonly at: string; readonly url: string | null };
    };

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
  const unproved = (
    why: string,
    state: JobState | null = null,
    url: string | null = null,
    log: string | null = null,
  ) =>
    ({
      unproved: `${spec.name} is left to CI and unproved: job ${job} on ${head.slice(0, 12)} ${why}`,
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
      const state =
        read.head !== head ||
        (retried !== null && read.state === "missing") ||
        (read.id === retried && read.state === "failed")
          ? "pending"
          : read.state;
      const log = read.id === null ? null : forge.jobLog(ref, read.id);
      if (state === "failed" && asked.settle === true && retried === null) {
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
        if (status.code !== 0 || status.stdout.trim() !== "")
          return unproved(`passed, but ${cwd} has changes it never saw`);
        if (recorded !== undefined && retried === null) return { proved: recorded };
        const at = yield* nowIso();
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
        return retried === null ? { proved: proof } : { proved: proof, retried: true as const };
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
              started: yield* nowIso(),
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
