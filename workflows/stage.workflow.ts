// One open merge request's head put on stage for testing, unmerged, until the human is done
// with it. Nothing here waits on its review: staging ships nothing, and its rollback takes it
// back (ADR-draft-an-open-merge-request-is-staged-by-a-run-of-its-own).

import {
  Host,
  HoldersSchema,
  ReviewHeadSchema,
  ReviewStandingSchema,
  Run,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  forgeOfRef,
  mrUrlOf,
  readMrRef,
  type Holders,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import { IMPLEMENTER } from "./reviewing.ts";
import {
  Assessed,
  RolledBack,
  StagedMergeRequest,
  claiming,
  nth,
  plays,
  quoted,
  short,
  staging,
} from "./staging.ts";
import onGitlab from "./stage.gitlab.md" with { type: "text" };
import onGithub from "./stage.github.md" with { type: "text" };

const text = Schema.String;

/** What every step of a Stage Run is told, under the names its content asks for them by. */
export const StageInput = Schema.Struct({
  inputs: Schema.Struct({ mr: text }),
  run: Schema.Struct({ dir: text, id: text }),
  repository: text,
  /** The merge request's head a step puts on stage or takes off it. */
  head: text,
  /** The stage deploy jobs of the merge request's pipeline, as the assessment named them. */
  stage_jobs: text,
  /** Why stage comes off. */
  failure: text,
});

const stepsOf = (markdown: string) => {
  const content = contentOf(markdown);
  return {
    assess: content.template("assess", StageInput.fields),
    stage: content.template("stage", StageInput.fields),
    unstage: content.template("unstage", StageInput.fields),
  };
};

/** The shipped content per forge: the procedure differs, not only the commands (ADR-0050 D1). */
export const STAGE_ON = { gitlab: stepsOf(onGitlab), github: stepsOf(onGithub) };

const CLEARANCE_CHARS = 400;

const naming =
  (clears: (url: string, jobs: string) => string[]) =>
  (url: string, jobs: ReadonlyArray<string>) => {
    const named = clears(url, quoted(jobs));
    return named.join("; ").length <= CLEARANCE_CHARS
      ? named
      : clears(url, `the ${jobs.length} stage jobs its task names`);
  };

export const STAGE_CLEARS = {
  stage: naming((url, jobs) => [
    `playing, retrying and watching ${jobs} of ${url}'s merge request pipeline, and the stage check jobs (e2e-stage, smoke or the like) that follow them`,
    `rolling back only the stage environments those jobs deploy to on ${url}, to the newest release production carries`,
    "never a production job",
  ]),
  unstage: naming((url, jobs) => [
    `rolling back only the stage environments ${jobs} deployed to on ${url}, to the newest release production carries, never a production job`,
  ]),
};

/** One agent for the whole Run, which each step continues. */
export const STAGER = "stage";

const STAGED = { done: "Done", again: "Stage again", leave: "Leave it on stage" } as const;
const CLAIMS = { wait: "Wait for all", free: "Stage what is free", finish: "Finish" } as const;

type Read = Extract<Holders, { readonly _tag: "Read" }>;

const named = (holders: ReadonlyMap<string, string>) =>
  [...holders].map(([slug, holder]) => `${slug} (${holder})`).join(", ");

const holding = (read: Read, held: ReadonlySet<string>) =>
  read.applications
    .filter((one) => one.needs.every((slug) => held.has(slug)))
    .map((one) => one.name);

/** Jobs without an application require every application. */
const jobsOf = (read: Read, jobs: ReadonlyArray<string>, applications: ReadonlyArray<string>) =>
  jobs.filter((job) => {
    const named = read.jobs.find((one) => one.name === job)?.applications ?? [];
    const owners = named.length > 0 ? named : read.applications.map((one) => one.name);
    return owners.every((owner) => applications.includes(owner));
  });

const freeDeploys = (
  read: Read,
  jobs: ReadonlyArray<string>,
  others: ReadonlyMap<string, string>,
) => {
  const applications = holding(
    read,
    new Set(read.projects.map((one) => one.slug).filter((slug) => !others.has(slug))),
  );
  return { applications, jobs: jobsOf(read, jobs, applications) };
};

const UNCLAIMED = {
  again: "Try again",
  without: "Stage without a Helle claim",
  finish: "Finish",
} as const;

export default defineWorkflow({
  id: "stage",
  title: "stage — put an open merge request on stage for testing, unmerged",
  description:
    "Puts one open merge request's head on stage for testing, unmerged, and does nothing more: it asks for no approval, answered comments, passed pipeline or Go, and never merges, tags, posts or deploys to production. It claims the Helle projects stage deploys under, plays the merge request pipeline's stage jobs, proves every stage environment carries the head, and holds stage until the human says Done, which rolls it back, Stage again, or Leave it on stage.",
  input: Schema.Struct({
    mr: Schema.String.annotate({ description: "The merge request or pull request to stage" }),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER } },
  hints: { mr: "diff-target" },
  followUps: [
    {
      id: "stage-again",
      title: "Stage again",
      workflow: "self",
      when: "failed",
      inputs: { mr: "started-with" },
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const fail = (reason: string) => new WorkflowError({ reason });
      const park = (reason: string) =>
        Effect.gen(function* () {
          const why = `${reason}. Repair it, then resume ${runId}.`;
          yield* host.record(runId, why);
          yield* host.parked(runId, why);
          return yield* Workflow.suspend(yield* WorkflowInstance);
        });

      const ref = readMrRef(asked.mr);
      const mr = ref === null ? null : mrUrlOf(ref);
      if (ref === null || mr === null)
        return yield* fail(`${asked.mr || "an empty mr"} is not a merge request this Run can find`);
      yield* host.mergeRequest(runId, mr);
      const checkout = yield* Activity.make({
        name: "checkout",
        success: Schema.Union([
          Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
          Schema.Struct({ refused: Schema.String }),
        ]),
        execute: host.checkoutReviewed(runId),
      });
      if ("refused" in checkout)
        return yield* fail(`${mr} has no checkout to stage from: ${checkout.refused}`);
      const cwd = checkout.cwd;
      const place = yield* host.place(runId);
      const steps = STAGE_ON[forgeOfRef(ref)];
      const url = `https://${ref.project ?? ""}`;
      const input = {
        inputs: { mr },
        run: { dir: place.dir, id: runId },
        repository: url,
        head: "",
        stage_jobs: "",
        failure: "",
      };
      const as = (operation: string) => ({
        operation,
        agent: STAGER,
        role: "implementer",
        input,
      });

      // Judged against no proved head, so an open merge request answers with its head.
      const start = yield* Activity.make({
        name: "start",
        success: ReviewStandingSchema,
        error: WorkflowError,
        execute: host.review({ runId, cwd, proved: "", seen: [] }),
      });
      if (start._tag === "Unreadable")
        return yield* fail(`${mr} could not be read: ${start.reason}`);
      if (start._tag === "Merged")
        return yield* fail(`${mr} is merged, so its stage is its release's: nothing was staged`);
      if (start._tag === "Closed") return yield* fail(`${mr} is closed, so nothing was staged`);

      const assessed = yield* agentWork({
        ...as("assess"),
        instructions: steps.assess,
        output: Assessed,
      });
      const evidence = assessed.kind_evidence ? `: ${assessed.kind_evidence}` : "";
      if (assessed.is_package)
        return yield* fail(`${mr} is a package, so there is nothing to stage${evidence}`);
      const jobs = assessed.stage_jobs?.merge_request ?? [];
      if (jobs.length === 0)
        return yield* fail(
          `${mr} is an application with no stage deploy job on its merge request's pipeline, so nothing was staged${evidence}`,
        );

      const moveTo = (name: string, head: string) =>
        Activity.make({
          name,
          success: Schema.String,
          execute: Effect.gen(function* () {
            const moved = yield* host.fastForward({ runId, cwd, head });
            if (moved._tag === "Refused") return yield* park(moved.why);
            return moved.head;
          }),
        });
      yield* moveTo("fast-forward", "head" in start ? start.head : "");

      const deploys = { applications: assessed.applications ?? [], jobs };
      const claimed = claiming({
        runId,
        cwd,
        deploys,
        park,
        words: {
          adopt: "You already hold or are queued for a claim this stage needs. Take it over?",
          unclaimed: (why, retaining) =>
            retaining
              ? `${mr} cannot refresh its Helle claims: ${why}. Its existing claims stay held. ${UNCLAIMED.again} tries the refresh again; ${UNCLAIMED.without} stages only the applications it already holds; ${UNCLAIMED.finish} rolls stage back before giving its claims back.`
              : `${mr} cannot hold the Helle claims its stage needs: ${why}. Nothing goes on stage without them. ${UNCLAIMED.again} claims them again; ${UNCLAIMED.without} goes on holding none; ${UNCLAIMED.finish} stops here.`,
          ...UNCLAIMED,
          went: (why, retaining) =>
            retaining
              ? `staged with existing Helle claims only on the human's say: ${why}`
              : `staged without a Helle claim on the human's say: ${why}`,
        },
      });

      // Read first so waiting on another holder needs the human's say.
      const holders = yield* Activity.make({
        name: "holders",
        success: HoldersSchema,
        error: WorkflowError,
        execute: host.holders({ runId, cwd, deploys }),
      }).pipe(Effect.result);
      const read =
        holders._tag === "Success" && holders.success._tag === "Read" ? holders.success : null;
      const others = new Map<string, string>(
        (read?.projects ?? []).flatMap((one) =>
          one.holder === null ? [] : [[one.slug, one.holder] as const],
        ),
      );
      const freeNow = read === null ? null : freeDeploys(read, jobs, others);
      let free = false;
      if (freeNow !== null && others.size > 0) {
        const offered = freeNow.jobs.length > 0;
        const answer = yield* ask({
          name: "claims-1",
          prompt: `${mr}'s stage needs Helle projects someone else holds: ${named(others)}. ${CLAIMS.wait} queues for every project and stages everything once all are handed over${offered ? `; ${CLAIMS.free} takes only what is free and stages only ${freeNow.applications.join(", ")}, leaving every other application's stage as it is` : ""}; ${CLAIMS.finish} stops here, claiming nothing.`,
          options: [CLAIMS.wait, ...(offered ? [CLAIMS.free] : []), CLAIMS.finish],
        });
        if (answer === CLAIMS.finish) return `${mr} was not staged`;
        free = answer === CLAIMS.free;
      }

      const first = yield* claimed(
        "claim",
        free && freeNow !== null ? { deploys: freeNow, free: true } : {},
      );
      if (first === null) return `${mr} was not staged`;
      // An explicit waiver permits staging every application.
      if (first.left === undefined) free = false;
      const held = new Set(first.slugs);
      const take = (claim: { readonly left?: ReadonlyArray<{ slug: string; holder: string }> }) => {
        for (const one of claim.left ?? []) others.set(one.slug, one.holder);
        for (const slug of held) others.delete(slug);
      };
      take(first);
      const staged = () => (free && read !== null ? holding(read, held) : deploys.applications);
      const playing = () => (free && read !== null ? jobsOf(read, jobs, staged()) : jobs);
      const giveBack = Effect.suspend(() =>
        held.size === 0
          ? Effect.void
          : Activity.make({
              name: "give-back",
              execute: Effect.flatMap(host.release(runId), (kept) =>
                kept.length === 0
                  ? Effect.void
                  : park(
                      `Helle would not take back ${kept.join(", ")}, which this Run still holds`,
                    ),
              ),
            }),
      );
      if (playing().length === 0) {
        yield* giveBack;
        return `${mr} was not staged: someone else took every project it was to stage`;
      }

      const stage = staging({
        runId,
        cwd,
        jobs,
        stage: (name, head, only) =>
          agentWork({
            ...as(name),
            input: { ...input, head, stage_jobs: quoted(only) },
            clears: STAGE_CLEARS.stage(url, only),
            instructions: steps.stage,
            output: StagedMergeRequest,
          }),
        unstage: (name, head, failure, played) =>
          agentWork({
            ...as(name),
            input: { ...input, head, failure, stage_jobs: quoted(played) },
            clears: STAGE_CLEARS.unstage(url, played),
            instructions: steps.unstage,
            output: RolledBack,
          }),
      });
      let asks = 0;
      for (let n = 1; ; n++) {
        // Hours may have passed since the head was read, waiting on the claims or the human.
        const now = yield* Activity.make({
          name: `head.${n}`,
          success: ReviewHeadSchema,
          execute: host
            .reviewHead({ runId, cwd, commits: [] })
            .pipe(Effect.catch((failed) => park(failed.reason))),
        });
        const head = yield* moveTo(`fast-forward.${n}`, now.head);
        const { read: onStage } = yield* stage.put(nth("stage", n), head, playing());
        if (onStage._tag === "Moved") {
          yield* host.record(
            runId,
            `the head moved from ${short(head)} to ${short(onStage.head)} before stage was proved, so that head is staged instead`,
          );
          continue;
        }
        if (onStage._tag === "Failed") {
          const failed = `stage of ${mr} at ${short(head)} failed: ${onStage.why}`;
          yield* stage.off(nth("unstage", n), onStage.why, failed);
          yield* giveBack;
          return yield* fail(`${failed}; stage is back on what production carries`);
        }
        asks += 1;
        const leftApps = deploys.applications.filter((app) => !staged().includes(app));
        const leftOff =
          leftApps.length === 0
            ? ""
            : ` Left off stage: ${leftApps.join(", ")}. Their Helle projects are held by others: ${named(others)}.`;
        const holds =
          held.size === 0
            ? "This Run holds no Helle claim."
            : `This Run holds the Helle claims of ${[...held].join(", ")}.`;
        const answer = yield* ask({
          name: `staged-${asks}`,
          prompt: `Stage carries ${mr} at \`${short(head)}\` for testing, unmerged: ${plays(onStage.jobs)}.${leftOff} ${holds} Test it there, then: ${STAGED.done} rolls stage back and gives the claims back; ${STAGED.again} stages the merge request's head as it is then, keeping the claims${leftApps.length === 0 ? "" : " and taking any left-off project that is free by then"}; ${STAGED.leave} gives the claims back and leaves stage as it is.`,
          options: [STAGED.done, STAGED.again, STAGED.leave],
        });
        if (answer === STAGED.again) {
          if (leftApps.length > 0 && read !== null) {
            const more = yield* claimed(`staged-${asks}.claim`, {
              deploys,
              free: true,
              retaining: true,
            });
            if (more === null) {
              yield* stage.off(
                nth("unstage", n),
                `the human finished testing ${mr}`,
                `${mr} was staged at ${short(head)} for testing`,
              );
              yield* giveBack;
              return `${mr} was staged at ${short(head)} for testing; stage is rolled back`;
            }
            if (more.left !== undefined) {
              for (const slug of more.slugs) held.add(slug);
              take(more);
            }
          }
          continue;
        }
        if (answer === STAGED.leave) {
          yield* giveBack;
          return `stage carries ${mr} at ${short(head)}, unmerged`;
        }
        yield* stage.off(
          nth("unstage", n),
          `the human is done testing ${mr}`,
          `${mr} was staged at ${short(head)} for testing`,
        );
        yield* giveBack;
        return `${mr} was staged at ${short(head)} for testing; stage is rolled back`;
      }
    }),
});
