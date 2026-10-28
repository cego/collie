// One merge request taken the rest of the way on a human's go; its agent's Output is never proof.

import {
  AnswerSchema,
  FindingSchema,
  FixOutputSchema,
  Host,
  MergeOutcomeSchema,
  ProductionReadSchema,
  ReviewStandingSchema,
  RollbackReadSchema,
  Run,
  SettledAnswersSchema,
  TagReadSchema,
  TakeoverSchema,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  forecast,
  forgeOfRef,
  formatFindings,
  mrUrlOf,
  readMrRef,
  renderApproved,
  settleAnswers,
  step,
  stepFailed,
  waitsOnApproval,
  type Finding,
  type JobLink,
  type OpenComment,
  type ReviewStanding,
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
import onGitlab from "./release.gitlab.md" with { type: "text" };
import onGithub from "./release.github.md" with { type: "text" };

const text = Schema.String;

/** What every step of a release is told, under the names its content asks for them by. */
export const ReleaseInput = Schema.Struct({
  inputs: Schema.Struct({ mr: text }),
  run: Schema.Struct({ dir: text, id: text }),
  repository: text,
  /** The merged commit, once there is one. */
  merged: text,
  /** The merge request's head a step puts on stage or takes off it. */
  head: text,
  /** What a Run recovering a release that merged is told of the Run it recovers. */
  recovery: text,
  /** A comment round's comments, and its number. */
  comments: text,
  round: text,
  /** This Run's checks, as a step that commits is held to them. */
  verify: text,
  /** A fix round's number, its bound, and what failed. */
  iteration: text,
  max_iterations: text,
  findings: text,
  /** An application's stage deploy jobs of the pipeline a step stages from, as the assessment named them. */
  stage_jobs: text,
  /** Why stage failed, or comes off. */
  failure: text,
  /** The production jobs a step plays. */
  jobs: text,
  /** The Slack channel a merge request is shared in for approval. */
  channel: text,
});

const stepsOf = (markdown: string) => {
  const content = contentOf(markdown);
  return {
    assess: content.template("assess", ReleaseInput.fields),
    answer: content.template("answer", ReleaseInput.fields),
    fix: content.template("fix", ReleaseInput.fields),
    stageMergeRequest: content.template("stage-merge-request", ReleaseInput.fields),
    unstage: content.template("unstage", ReleaseInput.fields),
    tag: content.template("tag", ReleaseInput.fields),
    tagTested: content.template("tag-tested", ReleaseInput.fields),
    stage: content.template("stage", ReleaseInput.fields),
    rollback: content.template("rollback", ReleaseInput.fields),
    production: content.template("production", ReleaseInput.fields),
    share: content.template("share", ReleaseInput.fields),
  };
};

/** The shipped content per forge: the procedure differs, not only the commands (ADR-0050 D1). */
export const RELEASE_ON = { gitlab: stepsOf(onGitlab), github: stepsOf(onGithub) };

/** What each step that touches anything shared is cleared for, on the repository at `url`. */
const pushing = (url: string) =>
  `committing to the merge request's source branch on ${url} and pushing it with a plain push, never a force push`;

const rollingBack = (url: string) =>
  `rolling ${url}'s stage back to the newest release production carries`;

export const RELEASE_CLEARS = {
  answer: (url: string) => [
    pushing(url),
    `never posting on ${url} or resolving a thread there: Collie replies`,
  ],
  fix: (url: string) => [pushing(url)],
  stageMergeRequest: (url: string) => [
    `playing, retrying and watching ${url}'s stage deploy job and stage check jobs (e2e-stage, smoke or the like) of the merge request's pipeline`,
    rollingBack(url),
    "never a production job",
  ],
  tag: (url: string) => [
    `a release commit to ${url}'s default branch, where the repository makes one`,
    `pushing an annotated version tag of ${url} to origin`,
    `creating its release on ${url}, where the package publishes from its tags`,
    `watching the tag's pipeline on ${url}, never playing a production job`,
  ],
  /** An application's tag step, which stages the tag too. */
  stage: (url: string) => [
    `a release commit to ${url}'s default branch, where it makes one`,
    "pushing an annotated version tag to origin, with no forge release",
    "playing, retrying and watching the tag pipeline's stage deploy and check jobs until only production jobs waiting to be started are left",
    "rolling stage back to the newest release production carries",
    "never a production job",
  ],
  /** An application's tag step after its merge request was tested on stage. */
  tagTested: (url: string) => [
    `a release commit to ${url}'s default branch, where it makes one`,
    "pushing an annotated version tag to origin, with no forge release",
    `watching the tag's pipeline on ${url}, never playing a production job`,
  ],
  rollback: (url: string) => [`${rollingBack(url)}, never a production job`],
  production: (url: string, jobs: ReadonlyArray<JobLink>) => [
    `playing ${plays(jobs)} on ${url}, and no other job`,
  ],
};

/** Not one of RELEASE_CLEARS: it is cleared for a Slack channel, not the repository. */
export const SHARE_CLEARS = (mr: string, channel: string) => [
  `posting one Slack message in ${channel}: ${mr} linked by its title, and nothing else`,
];

const verdict = {
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
};

export const Answered = Schema.Struct({
  ...verdict,
  answers: Schema.Array(AnswerSchema).annotate({
    description: "one entry per comment you answered, by its id",
  }),
});

export const Tagged = Schema.Struct({
  ...verdict,
  tag: Schema.String.annotate({ description: "the tag pushed to origin" }),
  version: Schema.optionalKey(Schema.String),
  pipeline_url: Schema.optionalKey(Schema.String).annotate({
    description: "the URL of the tag's pipeline or workflow run",
  }),
});

export const Staged = Schema.Struct({
  ...Tagged.fields,
  stage_jobs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "the stage deploy and stage check jobs of the tag's pipeline you played or checked",
  }),
  production_jobs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
  ).annotate({
    description:
      "each production job of the tag's pipeline left waiting for somebody to start it, with its URL",
  }),
});

export const Played = Schema.Struct({
  ...verdict,
  played: Schema.Array(Schema.String).annotate({
    description: "the production jobs you played, by name",
  }),
});

export const Shared = Schema.Struct({
  posted: Schema.Boolean.annotate({ description: "true once the one message is posted" }),
  link: Schema.optionalKey(Schema.String).annotate({
    description: "the posted message's permalink",
  }),
  why: Schema.optionalKey(Schema.String).annotate({ description: "why nothing was posted" }),
});

/** One agent for the whole Run, which each step continues. */
export const RELEASER = "release";

const GO = {
  release: "Release",
  test: "Stage the merge request",
  stage: "Merge, tag and stage",
  finish: "Finish",
} as const;
const PRODUCTION = { send: "Send to production", leave: "Leave production to me" } as const;
const UNCLAIMED = { again: "Try again", without: "Release without a Helle claim" } as const;
type ProductionGo = (typeof PRODUCTION)[keyof typeof PRODUCTION];
const SHARE = { post: "Post for approval", wait: "Wait for changes" } as const;
const SHARE_SETTINGS = {
  on: "release.share_for_approval",
  channel: "release.approval_channel",
} as const;

/** Fix rounds in a row before a failing head parks the Run, as implement's gate fixes. */
const ROUNDS = 4;

const checkingOut = step({
  id: "checkout",
  title: "Checkout",
  description: "The merge request's branch, checked out for this Run to work in.",
  kind: "check",
});
const assess = step({
  id: "assess",
  title: "Assess",
  description:
    "Whether the repository is a package or an application, and where it deploys to stage.",
  kind: "agent",
  role: "implementer",
});
const proveHead = step({
  id: "prove",
  title: "Prove the head",
  description:
    "Collie runs the checks on the merge request's head, and a fix round mends a failure.",
  kind: "check",
  produces: "evidence",
});
const reviewWait = step({
  id: "review-wait",
  title: "Review wait",
  description:
    "Collie reads the review until the merge request is approved, answered, green and mergeable.",
  kind: "check",
});
const comments = step({
  id: "comments",
  title: "Comment round",
  description:
    "The agent answers each new review comment: fixed and pushed, or disputed with a reason.",
  kind: "agent",
  role: "implementer",
});
const shareAsk = step({
  id: "share-for-approval",
  title: "Share for approval",
  description: "Whether the merge request, waiting on a teammate's approval, is posted for it.",
  kind: "question",
});
const sharePost = step({
  id: "share",
  title: "Share",
  description: "The agent posts the merge request in the approval channel, linked by its title.",
  kind: "agent",
  role: "implementer",
});
const mergeGo = step({
  id: "go",
  title: "Merge go",
  description: "Whether the merge request is released at the head its review approved.",
  kind: "question",
});
const claim = step({
  id: "claim",
  title: "Helle claim",
  description: "Every Helle claim the release needs, held before anything is merged or tagged.",
  kind: "question",
});
const stageMr = step({
  id: "stage-mr",
  title: "Stage the merge request",
  description: "The merge request's own pipeline deploys its head to stage, unmerged, for testing.",
  kind: "agent",
  role: "implementer",
});
const merge = step({
  id: "merge",
  title: "Merge",
  description: "Collie merges at exactly the head the go named.",
  kind: "check",
});
const tag = step({
  id: "tag",
  title: "Tag",
  description:
    "The agent tags the merge, and Collie reads the tag and its pipeline back on origin.",
  kind: "agent",
  role: "implementer",
});
const stage = step({
  id: "stage",
  title: "Stage",
  description: "The agent tags the merge and stage gets the tag, and Collie reads stage back.",
  kind: "agent",
  role: "implementer",
});
const productionGo = step({
  id: "production-go",
  title: "Production go",
  description: "Whether production is played for you, or left to you.",
  kind: "question",
});
const playProduction = step({
  id: "production",
  title: "Production",
  description: "Production is played where you asked, and Collie waits until it carries the merge.",
  kind: "agent",
  role: "implementer",
});

const commentLines = (comments: ReadonlyArray<OpenComment>) =>
  comments
    .map((one) => {
      const where =
        one.file === null ? "" : ` on ${one.file}${one.line === null ? "" : `:${one.line}`}`;
      const quoted = one.body
        .split("\n")
        .map((line) => `  > ${line}`)
        .join("\n");
      return `- \`${one.id}\` by ${one.author}, ${one.url}${where}:\n${quoted}`;
    })
    .join("\n");

/** What a Release Run goes on from once its merge request is merged. */
interface Landed {
  readonly sha: string;
  readonly slugs: ReadonlyArray<string>;
  readonly recovery: string;
  readonly production: ProductionGo | null;
}

/** Why a standing is not the ready one a go was given for. */
const notReady = (standing: ReviewStanding) => {
  switch (standing._tag) {
    case "Waiting":
      return standing.why.join("; ");
    case "Moved":
      return `its head moved to ${short(standing.head)}`;
    case "Unanswered":
      return `${standing.comments.length} unanswered comment(s)`;
    case "Unreadable":
      return `the forge could not be read: ${standing.reason}`;
    default:
      return standing._tag.toLowerCase();
  }
};

export default defineWorkflow({
  id: "release",
  title: "release — merge and tag a merge request on a human's go",
  description:
    "Takes one merge request the rest of the way: it waits, at no model cost, until the merge request is approved, answered, green and mergeable at a head the Run's checks proved, asks the human for the go, then claims the repository, merges at that head, tags the release and reads the tag back on origin. An application is staged, from its merge request before the merge or from its tag after it, and goes to production on the human's go.",
  input: Schema.Struct({
    mr: Schema.String.annotate({ description: "The merge request or pull request to release" }),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER } },
  hints: { mr: "diff-target" },
  path: [
    checkingOut,
    assess,
    proveHead,
    reviewWait,
    mergeGo,
    claim,
    merge,
    stage,
    productionGo,
    playProduction,
  ],
  // A failed release is released again: before its merge as any Run, after it by taking
  // the landing over, and through the adopt question where it kept the claim.
  followUps: [
    {
      id: "release-again",
      title: "Release again",
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
          yield* stepFailed(why);
          yield* host.parked(runId, why);
          return yield* Workflow.suspend(yield* WorkflowInstance);
        });

      const ref = readMrRef(asked.mr);
      const mr = ref === null ? null : mrUrlOf(ref);
      if (ref === null || mr === null)
        return yield* fail(`${asked.mr || "an empty mr"} is not a merge request this Run can find`);
      yield* host.mergeRequest(runId, mr);
      const { cwd } = yield* checkingOut(
        Effect.gen(function* () {
          const checkout = yield* Activity.make({
            name: "checkout",
            success: Schema.Union([
              Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
              Schema.Struct({ refused: Schema.String }),
            ]),
            execute: host.checkoutReviewed(runId),
          });
          if ("refused" in checkout)
            return yield* fail(`${mr} has no checkout to release from: ${checkout.refused}`);
          return checkout;
        }),
      );
      const place = yield* host.place(runId);
      const forge = forgeOfRef(ref);
      const steps = RELEASE_ON[forge];
      const url = `https://${ref.project ?? ""}`;
      const input = {
        inputs: { mr },
        run: { dir: place.dir, id: runId },
        repository: url,
        merged: "",
        head: "",
        recovery: "",
        comments: "",
        round: "",
        verify: "",
        iteration: "",
        max_iterations: "",
        findings: "",
        stage_jobs: "",
        failure: "",
        jobs: "",
        channel: "",
      };
      const as = (operation: string) => ({
        operation,
        agent: RELEASER,
        role: "implementer",
        input,
      });

      const start = yield* Activity.make({
        name: "start",
        success: ReviewStandingSchema,
        error: WorkflowError,
        execute: host.review({ runId, cwd, proved: "", seen: [] }),
      });
      if (start._tag === "Unreadable")
        return yield* fail(`${mr} could not be read: ${start.reason}`);
      if (start._tag === "Closed") return yield* fail(`${mr} is closed, so nothing was released`);
      const recovering =
        start._tag !== "Merged"
          ? null
          : yield* Activity.make({
              name: "take-over",
              success: TakeoverSchema,
              error: WorkflowError,
              execute: host.takeOverLanding({ runId, cwd }),
            });
      if (recovering?._tag === "Refused") return yield* fail(recovering.why);
      if (recovering === null) {
        const merging = yield* Activity.make({
          name: "auto-merging",
          success: Schema.NullOr(Schema.String),
          error: WorkflowError,
          execute: host.autoMerging(cwd),
        });
        if (merging !== null)
          return yield* fail(
            `${mr} is set to merge itself once green, so this Run leaves it to do that`,
          );
      }

      // The go's options depend on this, so it comes before the checks and the wait. It
      // reads only: no claim is held yet.
      const assessed = yield* assess(
        agentWork({
          ...as("assess"),
          instructions: steps.assess,
          output: Assessed,
        }),
      );
      const testJobs = assessed.is_package ? [] : (assessed.stage_jobs?.merge_request ?? []);
      const stageJobs = assessed.is_package ? [] : (assessed.stage_jobs?.tag ?? []);
      if (!assessed.is_package && testJobs.length === 0 && stageJobs.length === 0)
        return yield* fail(
          `${mr} is an application with no stage deploy that Collie can prove, on its merge request's pipeline or its tags', so nothing was released${assessed.kind_evidence ? `: ${assessed.kind_evidence}` : ""}`,
        );
      const finishing = assessed.is_package ? [tag] : [stage, productionGo, playProduction];
      yield* forecast(
        recovering === null
          ? [assess, proveHead, reviewWait, mergeGo, claim, merge, ...finishing]
          : [assess, claim, ...finishing],
      );
      const goes = assessed.is_package
        ? [GO.release]
        : [...(testJobs.length > 0 ? [GO.test] : []), ...(stageJobs.length > 0 ? [GO.stage] : [])];
      const offered = assessed.is_package
        ? `${GO.release} merges it at that head and tags it;`
        : [
            testJobs.length > 0
              ? `${GO.test} deploys that head to stage for you to test, unmerged, and asks for production before it merges.`
              : "",
            stageJobs.length > 0
              ? `${GO.stage} merges it at that head and tags it, and stage gets the tag; production waits for a second go.`
              : "",
          ]
            .filter((line) => line !== "")
            .join(" ");

      const deploys = {
        applications: assessed.applications ?? [],
        jobs: [...testJobs, ...stageJobs],
      };
      const claimed = claiming({
        runId,
        cwd,
        deploys,
        park,
        words: {
          adopt: "You already hold or are queued for a claim this release needs. Take it over?",
          unclaimed: (why) =>
            `${mr} cannot hold the Helle claims its release needs: ${why}. Nothing is merged or tagged without them. ${UNCLAIMED.again} claims them again; ${UNCLAIMED.without} goes on holding none; ${GO.finish} stops here.`,
          again: UNCLAIMED.again,
          without: UNCLAIMED.without,
          finish: GO.finish,
          went: (why) => `released without a Helle claim on the human's say: ${why}`,
        },
      });

      let landed: Landed;
      if (recovering !== null) {
        // That go was given and spent: no wait, no go and no merge, only what is left.
        const slugs = yield* claim(
          claimed("claim").pipe(Effect.map((held) => held?.slugs ?? null)),
        );
        if (slugs === null)
          return yield* fail(
            `${mr} was merged at ${recovering.sha}, and its release was stopped without the Helle claims it needs, so nothing was tagged`,
          );
        landed = {
          sha: recovering.sha,
          slugs,
          recovery: `This Run recovers the release of ${mr} that ${recovering.from} merged at \`${recovering.sha}\` and then failed: ${recovering.failure} Where a tag on origin already carries \`${recovering.sha}\`, finish that tag's release and its pipeline, stage included, instead of making another.`,
          production: null,
        };
      } else {
        const moveTo = (at: number, head: string) =>
          Activity.make({
            name: `fast-forward.${at}`,
            success: Schema.String,
            execute: Effect.gen(function* () {
              const moved = yield* host.fastForward({ runId, cwd, head });
              if (moved._tag === "Refused") return yield* park(moved.why);
              return moved.head;
            }),
          });
        const checksNow = Effect.map(host.approved(runId), renderApproved);
        // `parkWith` says why another fix round would not help, so a failure parks the Run
        // here, where a resume runs the checks again.
        const checksAt = (
          name: string,
          pass: { readonly pass: "fix"; readonly round: number } | null,
          parkWith: string | null,
        ) =>
          Activity.make({
            name,
            success: Schema.Struct({ head: Schema.String, failed: Schema.Array(Schema.String) }),
            execute: Effect.gen(function* () {
              const checks = yield* host.approved(runId);
              const failed: string[] = [];
              for (const spec of checks.filter((one) => one.ci === undefined)) {
                const ran = yield* host
                  .verify({ runId, name: spec.name, cwd, ...pass })
                  .pipe(Effect.result);
                if (ran._tag === "Failure") failed.push(`${spec.name}: ${ran.failure.reason}`);
                else if (ran.success.result !== "pass") failed.push(`${spec.name} failed`);
              }
              for (const spec of checks.filter((one) => one.ci !== undefined)) {
                const read = yield* host.ciJob({
                  runId,
                  cwd,
                  name: spec.name,
                  wait: true,
                  settle: true,
                });
                if (!("proved" in read) && read.before === undefined) failed.push(read.unproved);
              }
              const head = (yield* host.evidence(runId, cwd)).final.head_sha;
              if (failed.length > 0 && parkWith !== null)
                return yield* park(
                  `The checks failed at ${short(head)} ${parkWith}: ${failed.join("; ")}`,
                );
              return { head, failed };
            }),
          });
        const treeNow = Effect.map(host.evidence(runId, cwd), ({ final }) => ({
          head: final.head_sha,
          fingerprint: final.fingerprint,
        }));
        const Tree = Schema.Struct({ head: Schema.String, fingerprint: Schema.String });
        let fixes = 0;
        /** One fix round on `findings`, the `round`th in a row: its number, and why it stalled, if it did. */
        const fixRound = (findings: ReadonlyArray<Finding>, round: number) =>
          Effect.gen(function* () {
            fixes += 1;
            const n = fixes;
            const before = yield* Activity.make({
              name: `fix-${n}.before`,
              success: Tree,
              execute: treeNow,
            });
            const fixed = yield* agentWork({
              ...as(`fix-${n}`),
              pushes: true,
              clears: RELEASE_CLEARS.fix(url),
              instructions: steps.fix,
              input: {
                ...input,
                verify: yield* checksNow,
                iteration: String(round),
                max_iterations: String(ROUNDS),
                findings: formatFindings(findings),
              },
              output: FixOutputSchema,
            });
            const after = yield* Activity.make({
              name: `fix-${n}.after`,
              success: Tree,
              execute: treeNow,
            });
            const disputed = fixed.disputed ?? [];
            const stalled =
              after.head === before.head &&
              after.fingerprint === before.fingerprint &&
              (fixed.fixed ?? []).length === 0
                ? `after fix-${n} changed nothing${disputed.length === 0 ? "" : `, disputing ${disputed.map((one) => `${one.title}: ${one.reason ?? "no reason given"}`).join("; ")}`}`
                : null;
            return { n, stalled };
          });
        /** The head proved by the checks, after as many fix rounds as it takes, up to ROUNDS. */
        const proving = (
          name: string,
          pass: { readonly pass: "fix"; readonly round: number } | null,
        ) =>
          Effect.gen(function* () {
            let at = yield* checksAt(name, pass, null);
            for (let rounds = 1; at.failed.length > 0; rounds++) {
              const findings = at.failed.map((title) => ({
                severity: "blocker",
                title,
                detail: `Collie ran this Run's checks on ${short(at.head)}, the merge request's head, and this is what failed.`,
              }));
              const { n, stalled } = yield* fixRound(findings, rounds);
              at = yield* checksAt(
                `fix-${n}.checks`,
                { pass: "fix", round: n },
                stalled ?? (rounds >= ROUNDS ? `after ${ROUNDS} fix rounds` : null),
              );
            }
            return at.head;
          });
        const awaited = (at: number, proved: string) =>
          Activity.make({
            name: `review.${at}`,
            success: ReviewStandingSchema,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const standing = yield* host.awaitReview({ runId, cwd, proved, seen: [] });
              if (standing._tag === "Held") return yield* Workflow.suspend(yield* WorkflowInstance);
              return standing;
            }),
          });

        let proved = yield* proveHead(
          Effect.andThen(
            moveTo(0, start._tag === "Moved" ? start.head : ""),
            proving("checks.0", null),
          ),
        );
        let waits = 0;
        let rounds = 0;
        let gos = 0;
        let stagings = 0;
        let merged: Omit<Landed, "recovery"> | null = null;
        // Journaled: a replay asks what the first pass asked, whatever the settings say now.
        const sharing = yield* Activity.make({
          name: "share-settings",
          success: Schema.Struct({ on: Schema.Boolean, channel: Schema.String }),
          execute: Effect.gen(function* () {
            const on = (yield* host.config(SHARE_SETTINGS.on)).trim() === "true";
            const channel = (yield* host.config(SHARE_SETTINGS.channel)).trim();
            return { on, channel };
          }),
        });
        const channel = sharing.channel;
        if (sharing.on && channel === "")
          yield* host.record(
            runId,
            `${SHARE_SETTINGS.on} is on but ${SHARE_SETTINGS.channel} names no channel, so nothing is shared for approval`,
          );
        let shared = !sharing.on || channel === "";
        let shares = 0;
        /** After a wait, the question comes again only at a new head. */
        let askedAt: string | null = null;
        const standingAt = (name: string) =>
          Activity.make({
            name,
            success: ReviewStandingSchema,
            error: WorkflowError,
            execute: host.review({ runId, cwd, proved, seen: [] }),
          });
        /** Asks to share the merge request while it waits on a teammate's approval at `proved`. */
        const offerShare = (at: number) =>
          Effect.gen(function* () {
            if (!waitsOnApproval(yield* standingAt(`share-standing.${at}`))) return;
            shares += 1;
            askedAt = proved;
            const answer = yield* shareAsk(
              ask({
                name: nth("share-for-approval", shares),
                prompt: `${mr} at ${short(proved)} waits for a teammate's approval. Check it first. ${SHARE.post} posts it in ${channel} as its title, linked, and nothing else; ${SHARE.wait} posts nothing and asks again once its head moves.`,
                options: [SHARE.post, SHARE.wait],
              }),
              { round: shares },
            );
            if (answer === SHARE.wait)
              return yield* host.record(
                runId,
                `not shared at ${short(proved)}: waiting for ${mr} to change`,
              );
            // The answer can come long after the question, once nobody need approve it any more.
            if (!waitsOnApproval(yield* standingAt(`${nth("share", shares)}.standing`)))
              return yield* host.record(
                runId,
                `not shared: ${mr} no longer waits for a teammate's approval`,
              );
            const posted = yield* sharePost(
              agentWork({
                ...as(nth("share", shares)),
                clears: SHARE_CLEARS(mr, channel),
                instructions: steps.share,
                input: { ...input, channel },
                output: Shared,
              }).pipe(
                Effect.catch((failed) =>
                  Effect.succeed<typeof Shared.Type>({ posted: false, why: failed.reason }),
                ),
              ),
              { round: shares },
            );
            shared = posted.posted;
            yield* host.record(
              runId,
              posted.posted
                ? `shared ${mr} in ${channel} for approval: ${posted.link ?? "no permalink given"}`
                : `did not share ${mr} in ${channel}: ${posted.why ?? "no reason given"}`,
            );
          });
        while (merged === null) {
          waits += 1;
          if (!shared && askedAt !== proved) yield* offerShare(waits);
          const standing = yield* reviewWait(awaited(waits, proved));
          if (standing._tag === "Merged")
            return yield* fail(
              `${mr} was merged outside this Run by ${standing.by || "someone"}, so nothing was tagged`,
            );
          if (standing._tag === "Closed")
            return yield* fail(`${mr} was closed, so nothing was released`);
          if (standing._tag === "Moved") {
            proved = yield* proveHead(
              Effect.andThen(moveTo(waits, standing.head), proving(`checks.${waits}`, null)),
            );
            continue;
          }
          if (standing._tag === "Unanswered") {
            rounds += 1;
            const n = rounds;
            const given = standing.comments;
            const head = yield* comments(
              Effect.gen(function* () {
                const answered = yield* agentWork({
                  ...as(`answer-${n}`),
                  pushes: true,
                  clears: RELEASE_CLEARS.answer(url),
                  instructions: steps.answer,
                  input: {
                    ...input,
                    comments: commentLines(given),
                    round: String(n),
                    verify: yield* checksNow,
                  },
                  output: Answered,
                });
                const settled = yield* Activity.make({
                  name: `answer-${n}.settle`,
                  success: Schema.Struct({ head: Schema.String, answers: SettledAnswersSchema }),
                  error: WorkflowError,
                  execute: Effect.gen(function* () {
                    const read = yield* host.reviewHead({
                      runId,
                      cwd,
                      commits: answered.answers.flatMap((one) =>
                        one.commit === undefined ? [] : [one.commit],
                      ),
                    });
                    const answers = settleAnswers({
                      given,
                      answers: answered.answers,
                      onHead: read.carries,
                      open: read.open,
                    });
                    if (answers.replies.length === 0 && answers.carried.length > 0)
                      return yield* park(
                        `answer-${n} answered none of the comments it was given: ${answers.carried.map((one) => one.url).join(", ")}`,
                      );
                    return { head: read.head, answers };
                  }),
                });
                for (const reply of settled.answers.replies)
                  yield* Activity.make({
                    name: `answer-${n}.reply.${reply.id}`,
                    success: Schema.Literals(["posted", "already"]),
                    error: WorkflowError,
                    execute: host.reply({
                      runId,
                      cwd,
                      comment: reply.id,
                      body: reply.body,
                      ...(reply.kind !== undefined && { kind: reply.kind }),
                    }),
                  });
                return settled.head;
              }),
              { round: n },
            );
            if (head !== proved)
              proved = yield* proveHead(proving(`answer-${n}.checks`, { pass: "fix", round: n }));
            continue;
          }
          if (standing._tag !== "Ready") continue;

          gos += 1;
          const head = standing.head;
          const approvers = standing.approvers.join(", ") || "nobody the forge names";
          const answer = yield* mergeGo(
            ask({
              name: `go-${gos}`,
              prompt: `Release ${mr} at ${short(head)}, approved by ${approvers}? ${offered} Finish leaves it open.`,
              options: [...goes, GO.finish],
            }),
            { round: gos },
          );
          if (answer === GO.finish) {
            yield* host.record(runId, `go ${gos}: finished with ${mr} left open`);
            return `${mr} was left open`;
          }
          const slugs = yield* claim(
            claimed(`go-${gos}.claim`).pipe(Effect.map((held) => held?.slugs ?? null)),
          );
          if (slugs === null) {
            yield* host.record(
              runId,
              `go ${gos}: finished without the Helle claims, ${mr} left open`,
            );
            return `${mr} was left open`;
          }
          const giveBack =
            slugs.length === 0
              ? Effect.void
              : Activity.make({
                  name: `go-${gos}.give-back`,
                  execute: Effect.asVoid(host.release(runId)),
                });
          // The claim can wait on Helle or a question, so the review is read once it is held.
          const still = yield* Activity.make({
            name: `go-${gos}.check`,
            success: ReviewStandingSchema,
            error: WorkflowError,
            execute: host.review({ runId, cwd, proved: head, seen: [] }),
          });
          if (still._tag !== "Ready") {
            yield* giveBack;
            yield* host.record(
              runId,
              `go ${gos} no longer holds for ${short(head)}: ${notReady(still)}`,
            );
            continue;
          }
          let production: ProductionGo | null = null;
          if (answer === GO.test) {
            stagings += 1;
            const n = stagings;
            const mrStage = staging({
              runId,
              cwd,
              jobs: testJobs,
              stage: (name, at) =>
                agentWork({
                  ...as(name),
                  input: { ...input, head: at, stage_jobs: quoted(testJobs) },
                  clears: RELEASE_CLEARS.stageMergeRequest(url),
                  instructions: steps.stageMergeRequest,
                  output: StagedMergeRequest,
                }),
              unstage: (name, at, failure) =>
                agentWork({
                  ...as(name),
                  input: { ...input, head: at, failure },
                  clears: RELEASE_CLEARS.rollback(url),
                  instructions: steps.unstage,
                  output: RolledBack,
                }),
            });
            /** Takes stage off `head` and gives the claim back, or fails keeping it where the forge cannot show that. */
            const unstage = (failure: string, failing: string) =>
              Effect.gen(function* () {
                yield* mrStage.off(nth("unstage", n), failure, failing);
                yield* giveBack;
              });
            const tested = yield* stageMr(
              Effect.gen(function* () {
                const { read: onStage, jobs } = yield* mrStage.put(nth("stage", n), head);
                const readStage = host.readStage({ runId, cwd, head, jobs });
                if (onStage._tag === "Moved") {
                  const moved = `its head moved to ${short(onStage.head)}`;
                  yield* unstage(
                    moved,
                    `stage of ${mr} at ${short(head)} no longer holds: ${moved}`,
                  );
                  yield* host.record(
                    runId,
                    `go ${gos} no longer holds for ${short(head)}: ${moved}`,
                  );
                  return { _tag: "Moved" } as const;
                }
                if (onStage._tag === "Failed") {
                  yield* unstage(
                    onStage.why,
                    `stage of ${mr} at ${short(head)} failed: ${onStage.why}`,
                  );
                  yield* host.record(
                    runId,
                    `stage of ${short(head)} failed: ${onStage.why}; stage is back on what production carries`,
                  );
                  const fixed = yield* fixRound(
                    [
                      {
                        severity: "blocker",
                        title: onStage.why,
                        detail: `Collie staged ${short(head)}, the merge request's head, from its pipeline, and this is what failed. Stage is back on what production carries.`,
                      },
                    ],
                    1,
                  );
                  return { _tag: "Fixed", n: fixed.n } as const;
                }
                return { _tag: "Staged", jobs: onStage.jobs, readStage } as const;
              }),
              { round: n },
            );
            if (tested._tag === "Moved") continue;
            if (tested._tag === "Fixed") {
              proved = yield* proveHead(
                proving(`fix-${tested.n}.checks`, { pass: "fix", round: tested.n }),
              );
              continue;
            }
            const go = yield* productionGo(
              Effect.gen(function* () {
                const go = yield* ask({
                  name: nth("production", n),
                  prompt: `Stage carries ${mr} at \`${short(head)}\` for testing, unmerged: ${plays(tested.jobs)}. Test it there, then: ${PRODUCTION.send} merges it at that head, tags it and plays production with no further question; ${PRODUCTION.leave} merges and tags it, and waits until production carries it, whoever plays it; ${GO.finish} merges nothing and rolls stage back.`,
                  options: [PRODUCTION.send, PRODUCTION.leave, GO.finish],
                });
                if (go === GO.finish) {
                  yield* unstage(
                    `the human finished with ${mr} unmerged`,
                    `${mr} was left open, but stage was not rolled back`,
                  );
                  yield* host.record(runId, `the production go: finished with ${mr} left open`);
                  return GO.finish;
                }
                // Nothing is merged yet, so the go holds only for the head it was given for, on stage.
                const holds = yield* Activity.make({
                  name: `${nth("production", n)}.check`,
                  success: Schema.NullOr(Schema.String),
                  error: WorkflowError,
                  execute: Effect.gen(function* () {
                    const standing = yield* host.review({ runId, cwd, proved: head, seen: [] });
                    if (standing._tag !== "Ready") return notReady(standing);
                    const now = yield* tested.readStage;
                    if (now._tag === "Moved") return `its head moved to ${short(now.head)}`;
                    return now._tag === "Failed" ? now.why : null;
                  }),
                });
                if (holds !== null) {
                  const why = `the production go no longer holds for ${short(head)}: ${holds}`;
                  yield* unstage(why, why);
                  yield* host.record(runId, why);
                  return null;
                }
                return go === PRODUCTION.send ? PRODUCTION.send : PRODUCTION.leave;
              }),
              { round: n },
            );
            if (go === GO.finish) return `${mr} was left open, and stage rolled back`;
            if (go === null) continue;
            production = go;
          }
          const outcome = yield* merge(
            Activity.make({
              name: `merge.${gos}`,
              success: MergeOutcomeSchema,
              error: WorkflowError,
              execute: host.merge({ runId, cwd, head }),
            }),
            { round: gos },
          );
          if (outcome._tag === "Merged") {
            merged = { sha: outcome.sha, slugs, production };
            continue;
          }
          yield* giveBack;
          if (outcome._tag === "HeadMoved") {
            yield* host.record(
              runId,
              `go ${gos} no longer holds: the head moved to ${short(outcome.head)} before the merge`,
            );
            continue;
          }
          if (outcome._tag === "MergedOutside")
            return yield* fail(
              `${mr} was merged outside this Run by ${outcome.by}, so nothing was tagged`,
            );
          return yield* fail(`the forge refused to merge ${mr}: ${outcome.reason}`);
        }
        landed = { ...merged, recovery: "" };
      }

      const released = `${mr} merged at ${landed.sha}`;
      const giveBack = landed.slugs.length === 0 ? Effect.void : host.release(runId);
      if (assessed.is_package) {
        const tagged = yield* tag(
          Effect.gen(function* () {
            const tagged = yield* agentWork({
              ...as("tag"),
              input: { ...input, merged: landed.sha, recovery: landed.recovery },
              clears: RELEASE_CLEARS.tag(url),
              instructions: steps.tag,
              output: Tagged,
            });
            // A tag that is not proved leaves shared work half-done, so the claim stays with this
            // Run for `Release again` to take over.
            const read = yield* Activity.make({
              name: "read-tag",
              success: TagReadSchema,
              execute: host.readTag({
                runId,
                cwd,
                tag: tagged.tag,
                merged: landed.sha,
                pipeline: tagged.pipeline_url || null,
                proves: "finished",
              }),
            });
            if (read._tag === "Unproved")
              return yield* fail(`${released}, but ${tagged.tag} is not released: ${read.why}`);
            return tagged;
          }),
        );
        yield* giveBack;
        return `${released}, released as ${tagged.tag}`;
      }

      // An application with no stage deploy on its tags was tested on stage before the merge.
      const tagStages = stageJobs.length > 0;
      const { staged, pipeline, read } = yield* stage(
        Effect.gen(function* () {
          const staged = yield* agentWork({
            ...as("tag"),
            input: {
              ...input,
              merged: landed.sha,
              recovery: landed.recovery,
              stage_jobs: quoted(stageJobs),
            },
            clears: tagStages ? RELEASE_CLEARS.stage(url) : RELEASE_CLEARS.tagTested(url),
            instructions: tagStages ? steps.stage : steps.tagTested,
            output: Staged,
          });
          const pipeline = staged.pipeline_url || null;
          const read = yield* Activity.make({
            name: "read-tag",
            success: TagReadSchema,
            execute: host.readTag({
              runId,
              cwd,
              tag: staged.tag,
              merged: landed.sha,
              pipeline,
              proves: "staged",
              stage: tagStages ? [...new Set([...stageJobs, ...(staged.stage_jobs ?? [])])] : [],
              production: (staged.production_jobs ?? []).map((job) => job.name),
            }),
          });
          if (read._tag === "StageFailed") {
            const stageFailed = `${released}, but stage failed after the merge: ${read.why}`;
            yield* agentWork({
              ...as("rollback"),
              input: { ...input, merged: landed.sha, failure: read.why },
              clears: RELEASE_CLEARS.rollback(url),
              instructions: steps.rollback,
              output: RolledBack,
            });
            const back = yield* Activity.make({
              name: "read-rollback",
              success: RollbackReadSchema,
              execute: host.readRollback({ runId, cwd, off: [landed.sha] }),
            });
            // Only a stage the forge shows back on production's release is safe to give back.
            if (back._tag === "Unshown")
              return yield* fail(`${stageFailed}. Its rollback is not shown: ${back.why}`);
            yield* giveBack;
            return yield* fail(
              `${stageFailed}. Stage is back on what production carries, nothing went to production, and the merge stands: the fix is a new merge request`,
            );
          }
          if (read._tag === "Unproved")
            return yield* fail(
              `${released}, but ${staged.tag} is not ready for production: ${read.why}`,
            );
          return { staged, pipeline, read };
        }),
      );

      // Go 2 holds for this tag and these jobs: the head go 1 was given for is merged.
      const jobs = read._tag === "Proved" ? read.production : [];
      const answer =
        read._tag !== "Proved"
          ? null
          : (landed.production ??
            (yield* productionGo(
              ask({
                name: "production",
                prompt: `${staged.tag} of ${mr} is on stage: stage carries \`${short(landed.sha)}\`. Verify stage, then: ${PRODUCTION.send} plays ${plays(jobs)}; ${PRODUCTION.leave} waits until production carries it, whoever plays it.`,
                options: [PRODUCTION.send, PRODUCTION.leave],
              }),
            )));
      yield* playProduction(
        Effect.gen(function* () {
          let played = false;
          if (answer === PRODUCTION.send && read._tag === "Proved") {
            played = true;
            const now = yield* Activity.make({
              name: "production.read",
              success: ProductionReadSchema,
              execute: host.readProduction({
                runId,
                cwd,
                tag: staged.tag,
                at: read.at,
                merged: landed.sha,
                pipeline: pipeline ?? "",
                jobs: jobs.map((job) => job.name),
              }),
            });
            if (now._tag === "Unproved")
              return yield* fail(
                `${released} and tagged ${staged.tag}, but nothing was sent to production: ${now.why}`,
              );
            if (now._tag === "Play" && now.jobs.length > 0)
              yield* agentWork({
                ...as("production"),
                input: { ...input, merged: landed.sha, jobs: plays(now.jobs) },
                clears: RELEASE_CLEARS.production(url, now.jobs),
                instructions: steps.production,
                output: Played,
              });
            else
              yield* host.record(
                runId,
                now._tag === "Carried"
                  ? "production already carries the merge, so nothing was played"
                  : "somebody already started the production jobs, so nothing was played",
              );
          }
          // The forge decides when production carries the merge, never an Output.
          const carried = yield* host.awaitProduction({
            runId,
            cwd,
            sha: landed.sha,
            jobs,
            played,
            url,
            slug: landed.slugs.length === 0 ? undefined : landed.slugs.join(", "),
          });
          if (!carried) return yield* Workflow.suspend(yield* WorkflowInstance);
        }),
      );
      yield* giveBack;
      return `${released}, released as ${staged.tag}, in production`;
    }),
});
