// Holding a merge request's Helle claims and putting its head on stage, shared by `release`
// and `stage` so a merge request is claimed, staged and rolled back the same way either way.
// Each caller asks in its own words.

import {
  ClaimedSchema,
  FindingSchema,
  Host,
  RollbackReadSchema,
  StageReadSchema,
  WorkflowError,
  ask,
  type JobLink,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export const short = (sha: string) => sha.slice(0, 8);

/** A step or question a Run may take more than once: the first by its name, then numbered. */
export const nth = (name: string, n: number) => (n === 1 ? name : `${name}-${n}`);

export const quoted = (jobs: ReadonlyArray<string>) => jobs.map((job) => `\`${job}\``).join(", ");

export const plays = (jobs: ReadonlyArray<JobLink>) =>
  jobs.map((job) => `\`${job.name}\` at ${job.url}`).join(", ");

/** The step gate's limit on a joined Clearance, counted as it counts. */
const CLEARANCE_CHARS = 400;

export const fitting = (...forms: ReadonlyArray<ReadonlyArray<string>>) =>
  forms.find((form) => Array.from(form.join("; ")).length <= CLEARANCE_CHARS) ?? forms.at(-1)!;

const verdict = {
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
};

export const Assessed = Schema.Struct({
  ...verdict,
  is_package: Schema.Boolean.annotate({
    description: "true where this repository publishes from its tag pipeline and deploys nowhere",
  }),
  kind_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "what said it is a package or an application",
  }),
  stage_jobs: Schema.optionalKey(
    Schema.Struct({
      merge_request: Schema.Array(Schema.String),
      tag: Schema.Array(Schema.String),
    }),
  ).annotate({
    description: "an application's stage deploy jobs, of a merge request's pipeline and a tag's",
  }),
  applications: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "every application this release deploys, by the name its deploy jobs give it (spilnu for stage:spilnu); empty for a package",
  }),
});

export const StagedMergeRequest = Schema.Struct({
  ...verdict,
  stage_jobs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "the stage deploy and stage check jobs of the merge request's pipeline you played or checked",
  }),
});

export const RolledBack = Schema.Struct({
  ...verdict,
  stage: Schema.optionalKey(Schema.String).annotate({ description: "the release stage runs now" }),
});

/** Why a claim waits on the adopt question, which is asked outside the claim's Activity. */
const ADOPTING = "the claim is already the operator's own";

/** What a caller's claim questions and record say. */
export interface ClaimWords {
  readonly adopt: string;
  readonly unclaimed: (why: string, retaining: boolean) => string;
  readonly again: string;
  readonly without: string;
  readonly finish: string;
  /** The record line for going on without a claim, on the human's say. */
  readonly went: (why: string, retaining: boolean) => string;
}

export interface Deploys {
  readonly applications: ReadonlyArray<string>;
  readonly jobs: ReadonlyArray<string>;
}

/**
 * Every Helle claim `deploys` needs, taken under the step `name`: none only on the human's
 * say, and null where they finished instead. `free` takes only what nobody else has, and
 * says what it left. `park` stops the Run where Helle would not take back a claim it no
 * longer wants.
 */
export const claiming =
  <R>(options: {
    readonly runId: string;
    readonly cwd: string;
    readonly deploys: Deploys;
    readonly words: ClaimWords;
    readonly park: (reason: string) => Effect.Effect<never, never, R>;
  }) =>
  (
    name: string,
    how: { readonly deploys?: Deploys; readonly free?: boolean; readonly retaining?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { runId, cwd, words } = options;
      const deploys = how.deploys ?? options.deploys;
      // A claim given back mid-Run must not be taken again when the Run replays, so it is
      // journaled, and the adopt question is asked outside the Activity.
      const attempt = (at: string, n: number) =>
        Effect.gen(function* () {
          const take = (step: string, adopting: Effect.Effect<boolean, WorkflowError>) =>
            Activity.make({
              name: step,
              success: ClaimedSchema,
              error: WorkflowError,
              execute: host.claim({
                runId,
                cwd,
                adopting,
                deploys,
                free: how.free ?? false,
                say: (line) => host.record(runId, line),
              }),
            });
          const first = yield* take(at, Effect.fail(new WorkflowError({ reason: ADOPTING }))).pipe(
            Effect.result,
          );
          if (first._tag === "Success") return first.success;
          if (first.failure.reason !== ADOPTING) return { unresolved: first.failure.reason };
          const adopt = yield* ask({
            name: nth("adopt-claim", n),
            prompt: words.adopt,
            options: ["yes", "no"],
          });
          return yield* take(`${at}.adopt`, Effect.succeed(adopt === "yes")).pipe(
            Effect.catch((failed) => Effect.succeed({ unresolved: failed.reason })),
          );
        });
      for (let n = 1; ; n++) {
        const at = nth(name, n);
        const held = yield* attempt(at, n);
        if ("slugs" in held) return held;
        const answer = yield* ask({
          name: `${at}.unclaimed`,
          prompt: words.unclaimed(held.unresolved, how.retaining ?? false),
          options: [words.again, words.without, words.finish],
        });
        if (answer === words.again) continue;
        if (how.retaining !== true)
          yield* Activity.make({
            name: `${at}.give-back`,
            execute: Effect.flatMap(host.release(runId), (kept) =>
              kept.length === 0
                ? Effect.void
                : options.park(
                    `Helle would not take back ${kept.join(", ")}, which this Run still holds, so it neither finishes nor goes on without its claims`,
                  ),
            ),
          });
        if (answer === words.finish) return null;
        yield* host.record(runId, words.went(held.unresolved, how.retaining ?? false));
        return { slugs: [] };
      }
    });

/**
 * A merge request's head put on stage by a step of the caller's, proved from the forge, and
 * taken off again. Every head it staged, and every stage environment one reached, is read
 * by the rollback, which is told every job it played.
 */
export const staging = <R1, R2>(options: {
  readonly runId: string;
  readonly cwd: string;
  /** The stage deploy jobs the assessment named. */
  readonly jobs: ReadonlyArray<string>;
  readonly stage: (
    name: string,
    head: string,
    jobs: ReadonlyArray<string>,
  ) => Effect.Effect<typeof StagedMergeRequest.Type, WorkflowError, R1>;
  readonly unstage: (
    name: string,
    head: string,
    failure: string,
    jobs: ReadonlyArray<string>,
  ) => Effect.Effect<unknown, WorkflowError, R2>;
}) => {
  const { runId, cwd } = options;
  let reached: ReadonlyArray<string> = [];
  let undiscovered = false;
  const heads: string[] = [];
  const played = new Set<string>();
  return {
    /**
     * Stages `head` under the step `name` with `only` of the jobs, all where not given, and
     * the forge's read of it with the jobs it read.
     */
    put: (name: string, head: string, only: ReadonlyArray<string> = options.jobs) =>
      Effect.gen(function* () {
        const host = yield* Host;
        const staged = yield* options.stage(name, head, only);
        heads.push(head);
        for (const job of only) played.add(job);
        const jobs = [...new Set([...only, ...(staged.stage_jobs ?? [])])];
        const read = yield* Activity.make({
          name: `${name}.read`,
          success: StageReadSchema,
          execute: host.readStage({ runId, cwd, head, jobs }),
        });
        const named = read.environments;
        if (named === undefined) undiscovered = true;
        else reached = [...new Set([...reached, ...named])];
        return { read, jobs };
      }),
    /** Takes stage off under the step `name`, or fails as `failing` where the forge cannot show it. */
    off: (name: string, failure: string, failing: string) =>
      Effect.gen(function* () {
        const host = yield* Host;
        yield* options.unstage(name, heads.at(-1) ?? "", failure, [...played]);
        if (undiscovered)
          return yield* new WorkflowError({
            reason: `${failing}. Its rollback is not shown: stage environments could not be discovered`,
          });
        const back = yield* Activity.make({
          name: `${name}.read`,
          success: RollbackReadSchema,
          execute: host.readRollback({ runId, cwd, off: [...heads], environments: reached }),
        });
        if (back._tag === "Unshown")
          return yield* new WorkflowError({
            reason: `${failing}. Its rollback is not shown: ${back.why}`,
          });
      }),
  };
};
