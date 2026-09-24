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
} from "collie";
import { Effect, Schema } from "effect";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import markdown from "./renovate.md" with { type: "text" };

const content = contentOf(markdown);

/** A section of the renovate content, under the preamble every step of it shares. */
export const renovateText = (section: string): string =>
  [content.preamble, content.sections.get(section) ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");

const verdict = {
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
};

/** The one issue every later step writes to, so a long wait cannot split a repository. */
const Tracked = Schema.Struct({
  ...verdict,
  issue: Schema.String.annotate({ description: "the Linear issue id this Run records itself on" }),
  issue_url: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  created_issue: Schema.optionalKey(Schema.Boolean),
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
    description: "succeeded or not run",
  }),
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
  /** What every step of this Run is told, under the names the content asks for them by. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly vars: Readonly<Record<string, Schema.Json>>;
  readonly tracked: typeof Tracked.Type;
  readonly assessed: typeof Assessed.Type;
}

/**
 * What lands a renovation, once everything before it has agreed there is one. A fork
 * changes these three and keeps the rest; they are functions rather than a service,
 * because the only thing that varies is what to do, not who provides it.
 */
export interface Landing {
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
export const asRenovator = (at: Pick<Landed, "inputs" | "vars">, operation: string) => ({
  operation,
  agent: TRACKER,
  role: "renovate",
  inputs: at.inputs,
  vars: at.vars,
});

/** The shipped landing: merge what was assessed, tag it, and check the repository off. */
export const shippedLanding: Landing = {
  merge: (at) =>
    agentWork({
      ...asRenovator(at, "merge"),
      instructions: renovateText("merge"),
      output: Merged,
    }),
  release: (at) =>
    agentWork({
      ...asRenovator(at, "release"),
      instructions: renovateText("release"),
      output: Released,
    }),
  record: (at) =>
    agentWork({
      ...asRenovator(at, "record"),
      instructions: renovateText("record"),
      output: Recorded,
    }),
};

/**
 * The whole renovation, with its landing supplied: the shipped one where none is. A fork
 * spreads this with three functions of its own and an identity of its own.
 */
export const renovation = (landing: Landing = shippedLanding) =>
  defineWorkflow({
    id: "renovate",
    title: "renovate — merge the month's dependency updates, tag, release and record it",
    description:
      "Assesses every Renovate Bot merge request, gathers an application's into one batch branch proven on stage under the shared claim and approved by a teammate, merges, tags and watches the release, then checks the repository off the team's shared Renovate issue in Linear.",
    input: Schema.Struct({
      /** A GitLab URL or an existing local checkout; empty is the workspace it started from. */
      repository: Schema.optionalKey(Schema.String),
      /** The Linear team whose shared Renovate issue this Run records itself on. */
      team: Schema.optionalKey(Schema.String),
      /** The team's shared Renovate issue, where the operator already knows which it is. */
      issue: Schema.optionalKey(Schema.String),
    }),
    output: Schema.String,
    // The one agent every step continues, on Claude Code, whose auto mode it is started in.
    agents: { harness: "claude", model: "default", effort: "medium" },
    hints: { repository: "gitlab-repository" },
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
        // Everything from the assessment on is glab: what it cannot reach, it cannot read,
        // merge or tag. Asked before an agent is started rather than discovered by one, and
        // the same answer names whoever the batch merge request is assigned to.
        const gitlab = yield* host.mr({ cwd });
        if (!gitlab.ok) {
          yield* host.record(runId, `nothing to renovate here: ${gitlab.reason}`);
          return `nothing to renovate here: ${gitlab.reason}`;
        }
        const vars = {
          run: { dir: place.dir, id: runId },
          mr: { assignee: gitlab.assignee },
          // What the operator configured, so nothing team-specific or company-specific
          // lives in the content: the fallback team, and where this installation's logs are.
          config: {
            linear: { team: yield* host.config("linear.team") },
            renovate: { logs: yield* host.config("renovate.logs") },
          },
        };
        const started = { inputs, vars };
        const tracked = yield* agentWork({
          ...asRenovator(started, "track"),
          // Claude Code's configured auto mode; this agent is reused by every later step.
          permissions: "harness",
          instructions: renovateText("track"),
          output: Tracked,
        });
        // The issue this Run bound itself to, in the preamble every later step shares: a
        // long wait, a resume or a cycle rollover cannot split the repository across two.
        const bound = { ...started, inputs: { ...inputs, issue: tracked.issue } };
        // Nothing shared is touched yet: no claim is held, so the assessment reads only.
        const assessed = yield* agentWork({
          ...asRenovator(bound, "assess"),
          instructions: renovateText("assess"),
          output: Assessed,
        });
        const here: Landed = { ...bound, dir: place.dir, tracked, assessed };

        // An empty batch is a finished Run in waiting, decided from the assessment's own
        // judgement: no tab is opened for the work that is skipped, and no Output is
        // written to say it had nothing to do.
        if (assessed.up_to_date) {
          yield* host.record(runId, "nothing to renovate: Renovate has opened nothing here");
          const released = yield* landing.release(here);
          const recorded = yield* landing.record(here, released);
          return `${tracked.issue}: ${recorded.status}`;
        }

        // The first thing that touches anything shared, so the claim is taken here and held
        // until the Run is settled. Waiting costs wall clock and no model tokens.
        const claim = yield* host.claim({
          runId,
          cwd,
          adopting: ask({
            name: "adopt-claim",
            prompt: "You already hold or are queued for this project's claim. Take it over?",
            options: ["yes", "no"],
          }).pipe(Effect.map((answer) => answer === "yes")),
          say: (line) => host.record(runId, line),
        });
        // Given back once the work is finished, merged or not, and not before: holding it
        // across a consultation is what stops anyone deploying on a half-finished renovation.
        const finished = (outcome: string) =>
          (claim === null ? Effect.void : host.release(runId)).pipe(Effect.as(outcome));

        if (!assessed.is_package) {
          // An application's updates land together: one batch branch, one merge request,
          // proved on stage once and reviewed once.
          const batched = yield* agentWork({
            ...asRenovator(here, "batch"),
            instructions: renovateText("batch"),
            output: Batched,
          });
          if (batched.mr_url !== undefined) yield* host.mergeRequest(runId, batched.mr_url);
          const staged = yield* agentWork({
            ...asRenovator(here, "stage"),
            instructions: renovateText("stage"),
            output: Staged,
          });
          // Nothing here shows stage is back on its stable release, so the claim stays with
          // this failed Run until someone recovers stage.
          if (!staged.verified) {
            return yield* new WorkflowError({
              reason: `${tracked.issue}: stage was not verified, so nothing is merged`,
            });
          }
          // The batch is approved by another team member, never by the Run that wrote it.
          const approval = yield* agentWork({
            ...asRenovator(here, "approval"),
            instructions: renovateText("approval"),
            output: Approved,
          });
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

        yield* landing.merge(here);
        const released = yield* landing.release(here);
        const recorded = yield* landing.record(here, released);
        return yield* finished(
          `${tracked.issue}: ${recorded.status}${released.version ? ` ${released.version}` : ""}`,
        );
      }),
  });

export default renovation();
