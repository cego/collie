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
  NativeAgents,
  NativeHost,
  type WorkflowError,
  agentWork,
  ask,
  contentOf,
  decision,
  defineWorkflow,
  type Registration,
  type WorkflowMetadata,
} from "collie/native";
import { Effect, Schema } from "effect";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import markdown from "./renovate.md" with { type: "text" };

export const id = "renovate";
export const title = "renovate — merge the month's dependency updates, tag, release and record it";
export const description =
  "Assesses every Renovate Bot merge request, gathers an application's into one batch branch proven on stage under the shared claim and approved by a teammate, merges, tags and watches the release, then checks the repository off the team's shared Renovate issue in Linear.";

export const input = {
  /** A GitLab URL or an existing local checkout; empty is the workspace it started from. */
  repository: Schema.optionalKey(Schema.String),
  /** The Linear team whose shared Renovate issue this Run records itself on. */
  team: Schema.optionalKey(Schema.String),
  /** The team's shared Renovate issue, where the operator already knows which it is. */
  issue: Schema.optionalKey(Schema.String),
};

export const metadata: WorkflowMetadata = {
  hints: { repository: "gitlab-repository" },
  // Detached at the default branch, so no branch of the repository is bound to this Run.
  checkout: "roaming",
};

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
export type Renovating = NativeAgents | NativeHost | WorkflowEngine | WorkflowInstance;

/** Where a landing step stands: the Run, its content, and what the steps before it found. */
export interface Landed {
  readonly runId: string;
  readonly cwd: string;
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

/** One agent for the whole Run, so its model is named once and each step continues it. */
const TRACKER = "track";

/** What every step of this Run is asked as, and on which agent. */
const asRenovator = (at: Pick<Landed, "runId" | "cwd" | "inputs" | "vars">, operation: string) => ({
  runId: at.runId,
  operation,
  agent: TRACKER,
  role: "renovate",
  workflow: id,
  cwd: at.cwd,
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
 * The whole renovation, with its landing supplied. `make` is this with the shipped one;
 * a fork exports its own `make` that calls this with three functions of its own.
 */
export const renovation = (options: {
  readonly name: string;
  readonly landing?: Landing;
}): Registration => {
  const landing = options.landing ?? shippedLanding;
  const workflow = defineWorkflow({ name: options.name, input, success: Schema.String });
  const adopt = decision("adopt-claim", {
    prompt: "You already hold or are queued for this project's claim. Take it over?",
    options: ["yes", "no"],
  });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const runId = payload.runId;
      const asked = payload.input;
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
      const started = { runId, cwd, inputs, vars };
      const tracked = yield* agentWork({
        ...asRenovator(started, "track"),
        model: "default",
        effort: "medium",
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
        adopting: ask(runId, adopt).pipe(Effect.map((answer) => answer === "yes")),
        say: (line) => host.record(runId, line),
      });

      if (!assessed.is_package) {
        // An application's updates land together: one batch branch, one merge request,
        // proved on stage once and reviewed once.
        yield* agentWork({
          ...asRenovator(here, "batch"),
          instructions: renovateText("batch"),
          output: Batched,
        });
        const staged = yield* agentWork({
          ...asRenovator(here, "stage"),
          instructions: renovateText("stage"),
          output: Staged,
        });
        if (!staged.verified) {
          yield* host.record(runId, "stage was not verified, so nothing is merged");
          return `${tracked.issue}: stage was not verified`;
        }
        // The batch is approved by another team member, never by the Run that wrote it.
        const approval = yield* agentWork({
          ...asRenovator(here, "approval"),
          instructions: renovateText("approval"),
          output: Approved,
        });
        if ((approval.approved_by ?? []).length === 0) {
          yield* host.record(runId, "the batch was not approved, so nothing is merged");
          return `${tracked.issue}: the batch was not approved`;
        }
      } else {
        yield* host.record(runId, "a package has no batch branch: skipped batch, stage, approval");
      }

      yield* landing.merge(here);
      const released = yield* landing.release(here);
      const recorded = yield* landing.record(here, released);
      // Given back once the work is done and not before: holding it across a consultation
      // is what stops anyone deploying on a half-finished renovation.
      if (claim !== null) yield* host.release(runId);
      return `${tracked.issue}: ${recorded.status}${released.version ? ` ${released.version}` : ""}`;
    }),
  );

  return { workflow, layer, decisions: { "adopt-claim": adopt } };
};

export const make = (registrationName: string) => renovation({ name: registrationName });
