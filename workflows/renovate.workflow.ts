// A month's dependency updates: assessed, batched, proved on stage, merged, released and
// checked off the team's shared issue.
//
// One agent for the whole Run, and a shape a fork can change without copying: the
// orchestration below is `renovation`, and the three steps that land the work — merge,
// release, record — are ordinary functions it is given. A fork supplies its own three and
// keeps everything before them, which is what "customise by composition" means here.
//
// What is a package and what is up to date are typed comparisons on the assessment, made
// before anything expensive: work that is skipped opens no agent, writes no Output and
// says why in the Run's own record.
//
// The Markdown beside this file is the content: what each step judges, and how.

import {
  FindingSchema,
  Agents,
  Host,
  Run,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  forecast,
  step,
} from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import onGitlab from "./renovate.gitlab.md" with { type: "text" };
import onGithub from "./renovate.github.md" with { type: "text" };

const text = Schema.String;

/** What every step of a renovation is told, under the names its content asks for them by. */
export const RenovateInput = Schema.Struct({
  inputs: Schema.Struct({ repository: text, team: text, issue: text }),
  run: Schema.Struct({ dir: text, id: text }),
  mr: Schema.Struct({ assignee: text }),
  merge_request: Schema.optionalKey(text),
  merge_operation: Schema.optionalKey(text),
  config: Schema.Struct({
    linear: Schema.Struct({ team: text }),
    renovate: Schema.Struct({ logs: text }),
  }),
});

/** Each step's section of one forge's content, under the preamble they share. */
const stepsOf = (markdown: string) => {
  const content = contentOf(markdown);
  return {
    track: content.template("track", RenovateInput.fields),
    assess: content.template("assess", RenovateInput.fields),
    batch: content.template("batch", RenovateInput.fields),
    stage: content.template("stage", RenovateInput.fields),
    approval: content.template("approval", RenovateInput.fields),
    merge: content.template("merge", RenovateInput.fields),
    release: content.template("release", RenovateInput.fields),
    record: content.template("record", RenovateInput.fields),
  };
};

/** The shipped content per forge: the procedure differs, not only the commands (ADR-0050 D1). */
export const RENOVATE_ON = { gitlab: stepsOf(onGitlab), github: stepsOf(onGithub) };

/** The GitLab content, under the name a fork written before there were two still reads. */
export const RENOVATE = RENOVATE_ON.gitlab;

const verdict = {
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
};

/** The one issue every later step writes to, so a long wait cannot split a repository. */
export const Tracked = Schema.Struct({
  ...verdict,
  issue: Schema.String.annotate({ description: "the Linear issue id this Run records itself on" }),
  issue_url: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  created_issue: Schema.optionalKey(Schema.Boolean),
  picked_because: Schema.optionalKey(Schema.String).annotate({
    description: "which issue among several was taken, and why",
  }),
});

/** One Renovate merge request, as the assessment read it. */
const Bump = Schema.Struct({
  iid: Schema.Union([Schema.Int, Schema.String]),
  title: Schema.optionalKey(Schema.String),
  bumps: Schema.optionalKey(Schema.String).annotate({ description: "pkg 1 -> 2" }),
  needs: Schema.optionalKey(Schema.String).annotate({ description: "nothing, or what it needs" }),
  risk: Schema.optionalKey(Schema.String).annotate({ description: "routine or migration" }),
});

/**
 * What the batch is, and the two facts everything after this branches on. Both are the
 * assessment's judgement, decided once and compared as values from here on.
 */
const Assessed = Schema.Struct({
  ...verdict,
  merge_requests: Schema.optionalKey(Schema.Array(Bump)),
  consulted: Schema.optionalKey(Schema.Array(Schema.String)),
  up_to_date: Schema.Boolean.annotate({ description: "true where Renovate has opened nothing" }),
  is_package: Schema.Boolean.annotate({
    description: "true where this repository publishes from its tag pipeline and deploys nowhere",
  }),
  kind_evidence: Schema.optionalKey(Schema.String).annotate({
    description: "what said it is a package or an application",
  }),
});

const Batched = Schema.Struct({
  ...verdict,
  mr_url: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  included: Schema.optionalKey(Schema.Array(Schema.Union([Schema.Int, Schema.String]))),
  left_out: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        iid: Schema.Union([Schema.Int, Schema.String]),
        why: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  consulted: Schema.optionalKey(Schema.Array(Schema.String)),
});

const Staged = Schema.Struct({
  ...verdict,
  deploy_job: Schema.optionalKey(Schema.String),
  verified_by: Schema.optionalKey(Schema.String).annotate({
    description: "e2e-stage, smoke or manual check",
  }),
  verified: Schema.Boolean,
  attempts: Schema.optionalKey(Schema.Int),
  rollbacks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        to: Schema.String,
        why: Schema.optionalKey(Schema.String),
        fixed_by: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

const Approved = Schema.Struct({
  ...verdict,
  approved_by: Schema.optionalKey(Schema.Array(Schema.String)),
  head_sha: Schema.optionalKey(Schema.String),
});

/** Every relevant merge request ends with exactly one of three outcomes. */
export const Merged = Schema.Struct({
  ...verdict,
  remaining_requests: Schema.optionalKey(Schema.Array(Bump)),
  outcomes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        iid: Schema.Union([Schema.Int, Schema.String]),
        url: Schema.optionalKey(Schema.String),
        outcome: Schema.Literals(["merged", "closed", "deferred"]),
        reason: Schema.optionalKey(Schema.String),
        replacement: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  held_branches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ branch: Schema.String, held_by: Schema.optionalKey(Schema.String) }),
    ),
  ),
  consulted: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const Released = Schema.Struct({
  ...verdict,
  version: Schema.optionalKey(Schema.String).annotate({ description: "the tag, or empty" }),
  tagged: Schema.Boolean,
  release_url: Schema.optionalKey(Schema.String),
  is_package: Schema.optionalKey(Schema.Boolean),
  pipeline: Schema.optionalKey(Schema.String).annotate({
    description: "succeeded, not run, or waiting for production",
  }),
  prod_jobs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.optionalKey(Schema.String) })),
  ).annotate({ description: "the production jobs left for the human to play" }),
  up_to_date: Schema.optionalKey(Schema.Boolean),
});

export const Recorded = Schema.Struct({
  ...verdict,
  issue: Schema.optionalKey(Schema.String),
  issue_url: Schema.optionalKey(Schema.String),
  checked_off: Schema.Boolean,
  status: Schema.Literals(["renovated", "renovated with exceptions", "up to date"]),
  exceptions: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** The services every step of a renovation needs, which a fork's own three need too. */
export type Renovating = Run | Agents | Host | WorkflowEngine | WorkflowInstance;

/** Where a landing step stands: its Run's directory, its content, and what came before it. */
export interface Landed {
  readonly dir: string;
  /** The forge the repository is on, whose content its steps are given. */
  readonly forge: keyof typeof RENOVATE_ON;
  /** The repository's web address on that forge, which a step's Clearance names. */
  readonly url: string;
  /** "merge request" or "pull request". */
  readonly noun: string;
  /** What every step of this Run is told. */
  readonly input: typeof RenovateInput.Type;
  readonly tracked: typeof Tracked.Type;
  readonly assessed: typeof Assessed.Type;
}

/**
 * What lands a renovation, once everything before it has agreed there is one. A fork
 * changes these three and keeps the rest; they are functions rather than a service,
 * because the only thing that varies is what to do, not who provides it.
 */
export interface Landing {
  /** One turn per request, scoped by `input.merge_request`, on the same conversation. */
  readonly merge: (at: Landed) => Effect.Effect<typeof Merged.Type, WorkflowError, Renovating>;
  readonly release: (at: Landed) => Effect.Effect<typeof Released.Type, WorkflowError, Renovating>;
  readonly record: (
    at: Landed,
    released: typeof Released.Type,
  ) => Effect.Effect<typeof Recorded.Type, WorkflowError, Renovating>;
}

/** One agent for the whole Run, which each step continues. */
export const TRACKER = "track";

/** What every step of this Run is asked as, and on which agent. */
export const asRenovator = (at: Pick<Landed, "input">, operation: string) => ({
  operation: operation === "merge" ? (at.input.merge_operation ?? operation) : operation,
  agent: TRACKER,
  role: "renovate",
  input: { ...at.input, merge_request: at.input.merge_request ?? "" },
});

/** The shipped landing: merge what was assessed, tag it, and check the repository off. */
export const shippedLanding: Landing = {
  merge: (at) =>
    agentWork({
      ...asRenovator(at, "merge"),
      clears: [
        `approving the reviewed head of, and merging, Renovate's own ${at.noun}s on ${at.url}`,
        `merging this Run's batch ${at.noun} there once a teammate has approved it`,
        "using the forge's own commands as this step's content names them",
      ],
      instructions: RENOVATE_ON[at.forge].merge,
      output: Merged,
    }),
  release: (at) =>
    agentWork({
      ...asRenovator(at, "release"),
      clears: [
        `pushing an annotated version tag of ${at.url}'s default branch to origin`,
        "creating its release where the repository is a package",
        "watching the tag's pipeline, never playing a production deploy job",
      ],
      instructions: RENOVATE_ON[at.forge].release,
      output: Released,
    }),
  record: (at) =>
    agentWork({
      ...asRenovator(at, "record"),
      instructions: RENOVATE_ON[at.forge].record,
      output: Recorded,
    }),
};

const trackStep = step({
  id: "track",
  title: "Bind the Renovate issue",
  kind: "agent",
  role: "renovate",
  description: "Bind this renovation to the team's shared issue.",
});
const assessStep = step({
  id: "assess",
  title: "Assess",
  kind: "agent",
  role: "renovate",
  description: "Assess every Renovate merge request before changing shared work.",
});
const claimStep = step({
  id: "claim",
  title: "Claim",
  kind: "question",
  description: "Hold the deployment claim while shared work is changed.",
});
const batchStep = step({
  id: "batch",
  title: "Batch",
  kind: "agent",
  role: "renovate",
  description: "Gather an application's dependency updates into its batch branch.",
});
const stageStep = step({
  id: "stage",
  title: "Stage",
  kind: "agent",
  role: "renovate",
  description: "Prove the application's batch on stage.",
});
const approvalStep = step({
  id: "approval",
  title: "Approval",
  kind: "agent",
  role: "renovate",
  description: "Wait for another team member to approve the batch's current head.",
});
const mergeStep = step({
  id: "merge",
  title: "Merge",
  kind: "agent",
  role: "renovate",
  description: "Settle each Renovate merge request under the approval and branch safeguards.",
});
const tagStep = step({
  id: "tag",
  title: "Tag and watch the release",
  kind: "agent",
  role: "renovate",
  description: "Tag the merged updates and watch the release pipeline.",
});
const recordStep = step({
  id: "record",
  title: "Record the result",
  kind: "agent",
  role: "renovate",
  description: "Record the repository's result on the shared Renovate issue.",
});
const productionStep = step({
  id: "production",
  title: "Watch production",
  kind: "check",
  description: "Keep the claim until the forge shows production carries the merged updates.",
});

/**
 * The whole renovation, with its landing supplied: the shipped one where none is. A fork
 * spreads this with three functions of its own and an identity of its own.
 */
export const renovation = (landing: Landing = shippedLanding) =>
  defineWorkflow({
    id: "renovate",
    connections: {
      needs: {
        linear: { with: "Checks each repository off its Renovate issue" },
        gitlab: {
          with: "Assesses, merges and releases dependency updates",
        },
      },
    },
    title: "renovate — merge the month's dependency updates, tag, release and record it",
    description:
      "Lands a repository's Renovate updates: it assesses every Renovate Bot merge request or pull request, gathers an application's into one batch branch proven on stage under the shared claim and approved by a teammate, merges, tags and watches the release, then checks the repository off the team's shared Renovate issue in Linear.",
    input: Schema.Struct({
      repository: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "A GitLab or GitHub URL, or an existing local checkout; empty is the checkout it started from",
        }),
      ),
      team: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The Linear team whose shared Renovate issue this Run records itself on; empty is the configured linear.team",
        }),
      ),
      issue: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The team's shared Renovate issue, where you already know it; empty finds it",
        }),
      ),
    }),
    output: Schema.String,
    // The one agent every step continues, on Claude Code, whose auto mode it is started in.
    agents: { harness: "claude", model: "default", effort: "high" },
    path: [trackStep, assessStep, claimStep, mergeStep, tagStep, recordStep, productionStep],
    hints: { repository: "repository" },
    // Detached at the default branch, so no branch of the repository is bound to this Run.
    checkout: "roaming",
    // A failed Run keeps the claim over shared work it may have left half-done. Recovering
    // is another renovation of the same repository, which takes that claim over.
    followUps: [
      {
        id: "recover",
        title: "Recover the retained claim",
        workflow: "self",
        when: "failed",
        inputs: { repository: "started-with", team: "started-with", issue: "started-with" },
        eligible: (facts) => facts.claim !== null,
      },
      {
        id: "renovate-again",
        title: "Renovate again",
        workflow: "self",
        when: "failed",
        inputs: { repository: "started-with", team: "started-with", issue: "started-with" },
        eligible: (facts) => facts.claim === null,
      },
    ],
    run: ({ input: asked }) =>
      Effect.gen(function* () {
        const host = yield* Host;
        const runId = (yield* Run).id;
        const place = yield* host.place(runId);
        const cwd = place.cwd;
        const inputs = {
          repository: asked.repository ?? "",
          team: asked.team ?? "",
          issue: asked.issue ?? "",
        };
        // Everything from the assessment on is the forge's CLI: what it cannot reach, it
        // cannot read, merge or tag. Asked before an agent is started rather than discovered
        // by one, and the same answer names the forge and whoever the batch is assigned to.
        const forge = yield* host.mr({ cwd });
        if (!forge.ok || forge.provider === undefined) {
          const reason = forge.ok ? "this checkout's forge could not be read" : forge.reason;
          yield* host.record(runId, `nothing to renovate here: ${reason}`);
          return `nothing to renovate here: ${reason}`;
        }
        const steps = RENOVATE_ON[forge.provider];
        const input = {
          inputs,
          merge_request: "",
          run: { dir: place.dir, id: runId },
          mr: { assignee: forge.assignee },
          // What the operator configured, so nothing team-specific or company-specific
          // lives in the content: the fallback team, and where this installation's logs are.
          config: {
            linear: { team: yield* host.config("linear.team") },
            renovate: { logs: yield* host.config("renovate.logs") },
          },
        };
        const started = { input };
        const tracked = yield* trackStep(
          agentWork({
            ...asRenovator(started, "track"),
            // Claude Code's configured auto mode; this agent is reused by every later step.
            permissions: "harness",
            instructions: steps.track,
            output: Tracked,
          }),
        );
        // The issue this Run bound itself to, in the preamble every later step shares: a
        // long wait, a resume or a cycle rollover cannot split the repository across two.
        const bound = { input: { ...input, inputs: { ...inputs, issue: tracked.issue } } };
        // Nothing shared is touched yet: no claim is held, so the assessment reads only.
        const assessed = yield* assessStep(
          agentWork({
            ...asRenovator(bound, "assess"),
            instructions: steps.assess,
            output: Assessed,
          }),
        );
        const here: Landed = {
          ...bound,
          dir: place.dir,
          forge: forge.provider,
          url: forge.url ?? "",
          noun: forge.noun ?? "merge request",
          tracked,
          assessed,
        };
        if (!assessed.is_package && !assessed.up_to_date)
          yield* forecast([
            trackStep,
            assessStep,
            claimStep,
            batchStep,
            stageStep,
            approvalStep,
            mergeStep,
            tagStep,
            recordStep,
            productionStep,
          ]);

        // An empty batch is a finished Run in waiting, decided from the assessment's own
        // judgement: no tab is opened for the work that is skipped, and no Output is
        // written to say it had nothing to do.
        if (assessed.up_to_date) {
          yield* host.record(runId, "nothing to renovate: Renovate has opened nothing here");
          const released = yield* tagStep(landing.release(here));
          const recorded = yield* recordStep(landing.record(here, released));
          return `${tracked.issue}: ${recorded.status}`;
        }

        // The first thing that touches anything shared, so the claim is taken here and held
        // until the Run is settled. Waiting costs wall clock and no model tokens.
        const held = yield* claimStep(
          host.claim({
            runId,
            cwd,
            adopting: ask({
              name: "adopt-claim",
              prompt: "You already hold or are queued for this project's claim. Take it over?",
              options: ["yes", "no"],
            }).pipe(Effect.map((answer) => answer === "yes")),
            say: (line) => host.record(runId, line),
          }),
        );
        if ("unresolved" in held)
          yield* host.record(runId, `◦ ${held.unresolved} — carrying on without one`);
        const claim = "slugs" in held && held.slugs.length > 0 ? held.slugs.join(", ") : null;
        // Given back once the work is finished, merged or not, and not before: holding it
        // across a consultation is what stops anyone deploying on a half-finished renovation.
        const finished = (outcome: string) =>
          (claim === null ? Effect.void : host.release(runId)).pipe(Effect.as(outcome));

        if (!assessed.is_package) {
          // An application's updates land together: one batch branch, one merge request,
          // proved on stage once and reviewed once.
          const batched = yield* batchStep(
            agentWork({
              ...asRenovator(here, "batch"),
              instructions: steps.batch,
              output: Batched,
            }),
          );
          if (batched.mr_url !== undefined) yield* host.mergeRequest(runId, batched.mr_url);
          const staged = yield* stageStep(
            agentWork({
              ...asRenovator(here, "stage"),
              clears: [
                `playing, retrying and watching the stage deploy, e2e-stage and smoke jobs of ${here.url}'s pipelines`,
                "rolling stage back to the newest tag whose production deploy succeeded, never a production job",
              ],
              instructions: steps.stage,
              output: Staged,
            }),
          );
          // Nothing here shows stage is back on its stable release, so the claim stays with
          // this failed Run until someone recovers stage.
          if (!staged.verified) {
            return yield* new WorkflowError({
              reason: `${tracked.issue}: stage was not verified, so nothing is merged`,
            });
          }
          // The batch is approved by another team member, never by the Run that wrote it.
          const approval = yield* approvalStep(
            agentWork({
              ...asRenovator(here, "approval"),
              instructions: steps.approval,
              output: Approved,
            }),
          );
          if ((approval.approved_by ?? []).length === 0) {
            yield* host.record(runId, "the batch was not approved, so nothing is merged");
            return yield* finished(`${tracked.issue}: the batch was not approved`);
          }
        } else {
          yield* host.record(
            runId,
            "a package has no batch branch: skipped batch, stage, approval",
          );
        }

        const pending = [...(assessed.merge_requests ?? [])];
        if (pending.length === 0) yield* mergeStep(landing.merge(here));
        for (let index = 0; index < pending.length; index++) {
          const current = pending[index]!;
          const merged = yield* mergeStep(
            landing.merge({
              ...here,
              input: {
                ...here.input,
                merge_request: String(current.iid),
                merge_operation: index === 0 ? "merge" : `merge-${index + 1}`,
              },
            }),
            { item: String(current.iid), items: pending.map((one) => String(one.iid)) },
          );
          for (const discovered of merged.remaining_requests ?? [])
            if (!pending.some((one) => String(one.iid) === String(discovered.iid)))
              pending.push(discovered);
        }
        // Everything this Run merged, read once so a replay waits for the same commit.
        const head =
          claim === null
            ? null
            : yield* Activity.make({
                name: "default-head",
                success: Schema.String,
                error: WorkflowError,
                execute: host.defaultHead(cwd),
              });
        const released = yield* tagStep(landing.release(here));
        const recorded = yield* recordStep(landing.record(here, released));
        const jobs = released.prod_jobs ?? [];
        const outcome = `${tracked.issue}: ${recorded.status}${released.version ? ` ${released.version}` : ""}`;
        if (claim === null || head === null) {
          const left = jobs.map((job) => `\`${job.name}\`${job.url ? ` at ${job.url}` : ""}`);
          return left.length === 0
            ? outcome
            : `${outcome}; production jobs left to play: ${left.join(", ")}`;
        }
        // The forge decides when production carries the merge, never the Output.
        const carried = yield* productionStep(
          host.awaitProduction({
            runId,
            cwd,
            sha: head,
            jobs,
            slug: claim,
            url: here.url,
          }),
        );
        if (!carried) return yield* Workflow.suspend(yield* WorkflowInstance);
        return yield* finished(`${outcome}; production carries it`);
      }),
  });

export default renovation();
