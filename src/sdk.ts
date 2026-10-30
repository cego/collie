// What an author imports when they write a workflow: `collie`.
//
// A workflow module is ordinary TypeScript, and this is what Collie adds to it: the
// payload envelope, the error contract, the metadata a card and a launch read, and the
// schemas the shipped steps already write. `agents.ts` is served under the same specifier
// and adds the one thing a module cannot write safely for itself — having an agent do the
// work. Everything else an author reaches for is Effect's: `Activity`, `DurableDeferred`,
// a Layer of their own, any operator at all.
//
// Two rules this file exists to keep. **Metadata is data, not control flow**: a hint, an
// outcome and an action say what a workflow is, and nothing here decides what it does.
// And **a conflict is refused before anything starts**: `checkEntry` runs at load, so a
// module that contradicts itself never reaches a Run, a worktree or an agent.
//
// `docs/sdk.md` is the guidance; `docs/adr/0014-native-workflows-run-on-effects-own-engine.md`
// is why the engine underneath is Effect's.

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import {
  Cause,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Result,
  Schema,
  SchemaGetter,
  SchemaRepresentation,
  flow,
} from "effect";
import type { CheckEvidence } from "./output";
import type { FailedTest, Snapshot, Verification } from "./verify";
import type { Issue, IssueRef } from "./forge/issues";
export type { Issue, IssueRef } from "./forge/issues";
import type { Report } from "./report";
export type { Report } from "./report";
export type { Produces, StepKind, StepMeta } from "./steps";
import type { VerifySpec } from "./verify-spec";
import type { CiJob } from "./ci-job";
import type { ChildProcessSpawner } from "effect/process";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as Workflow from "effect/workflow/Workflow";
import type { Agents } from "./agents";
import type { RunAuthority } from "./automode";
import { bodySections, INPUT_STRATEGIES, type InputStrategy } from "./definitions";
import { exclusiveClashes, launchInputProblem } from "./strategies";
import { expressionsIn, malformedIn } from "./template";
import {
  KINDS,
  REQUESTABLE,
  checkGaps,
  endsWithoutPatch,
  evidenceGaps,
  reviewGaps,
  isOutcome,
  refInside,
  type Outcome,
} from "./outcome";
import type { Source } from "./offers";
import {
  CurrentStep,
  runKey,
  type Produces,
  type StepKind,
  type StepMeta,
  type StepNote,
  type StepPlace,
} from "./steps";
import type { Asker } from "./proposals";
import type { UsageReading } from "./usage-model";
import type { Integration } from "./integrate";
import type { BenchmarkPlan, Measurement } from "./measurement-model";
import type { MergeOutcome, Takeover } from "./landing";
import type { ReviewHead, ReviewStanding } from "./review-wait";
import type { FastForward, ProductionRead, RollbackRead, StageRead, TagRead } from "./releasing";
import type { Holders } from "./helle";
import { ConnectionId, type ConnectionReading } from "./connection-model";
export { ConnectionId, ConnectionReading } from "./connection-model";

export { EXCLUSIVE_STRATEGIES } from "./strategies";

/** Where an offer's input comes from, as the Run it is offered about knows it. */
export { SOURCES, SOURCE_NAMES, isSource, type Source } from "./offers";

/**
 * What a review is about its target: which kind of change it names, and the glab
 * arguments that point a command at its project from anywhere.
 */
export { targetKind } from "./mr";
export { repoArgs } from "./forge/gitlab";
export { mrForgeFacts } from "./forge/forge";
/** How much of a Subscription is used, as the host reads it (ADR-0049). */
export { subscriptionOf, usedFor, type UsageReading } from "./usage-model";
export { forgeOfRef, mrUrlOf, parseMrTarget, readMrRef, type MrRef } from "./board-model";
/** What merging the default branch into a Run's branch did (`HostApi.integrate`). */
export { IntegrationSchema, type Integration } from "./integrate";
/** A Measurement as the host recorded it (`HostApi.measure`), an infinite ratio kept as JSON. */
export {
  MeasurementJson as MeasurementSchema,
  type BenchmarkPlan,
  type Measurement,
} from "./measurement-model";
export { MergeOutcomeSchema, TakeoverSchema, type MergeOutcome, type Takeover } from "./landing";
/** Where a merge request's review stands for a Release Run (`HostApi.awaitReview`). */
export {
  AnswerSchema,
  ReviewHeadSchema,
  ReviewStandingSchema,
  SettledAnswersSchema,
  settleAnswers,
  waitsOnApproval,
  type Answer,
  type OpenComment,
  type ReviewHead,
  type ReviewStanding,
  type SettledAnswers,
} from "./review-wait";
/**
 * A checkout brought to a head, and a tag, production and stage read back
 * (`HostApi.fastForward`, `readTag`, `readProduction`, `readStage`, `readRollback`).
 */
export {
  FastForwardSchema,
  JobLinkSchema,
  ProductionReadSchema,
  RollbackReadSchema,
  StageReadSchema,
  TagReadSchema,
  type FastForward,
  type JobLink,
  type ProductionRead,
  type RollbackRead,
  type StageRead,
  type TagRead,
} from "./releasing";
/** Who holds the shared claims a Run needs (`HostApi.holders`). */
export { HoldersSchema, type Holders } from "./helle";

export {
  CheckSchema,
  CriterionSchema,
  FindingSchema,
  FixOutputSchema,
  FixedSchema,
  MrOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  SynthesisSchema,
} from "./output";

/**
 * What a review/fix rally is made of: a workflow that writes its loop in TypeScript
 * converges, stands on a dispute and runs out of rounds where these say, and every
 * workflow says it the same way.
 */
export {
  afterMergeAnswers,
  answerFor,
  blockingKeys,
  findingKey,
  formatFindings,
  isBlocking,
  renderReview,
  settleFinalFix,
  settleRound,
  splitDisputed,
  substantiated,
  unmetCriteria,
  unsubstantiated,
  type Check,
  type CheckEvidence,
  type Criterion,
  type FinalFix,
  type Finding,
  type FixOutput,
  type FixReport,
  type Fixed,
  type Halt,
  type Rally,
  type ReviewOutput,
  type Split,
  type Synthesis,
} from "./output";

/**
 * What a Run leaves behind about a review, and where. `leaveReview` writes both halves —
 * the prose a human reads and the findings whatever comes next counts, read back by
 * `findingsIn` — `leaveOutstanding`
 * the findings still standing after a last fix `settleFinalFix` accepted, and `riskLine`
 * the paragraph an extra axis adds to what a reviewer is asked.
 */
export {
  FINDINGS_FILE,
  REVIEW_FILE,
  findingsIn,
  leaveOutstanding,
  leaveReview,
  openFindingsIn,
  riskLine,
} from "./output";

export type { FailedTest, Snapshot, Verification } from "./verify";
export type { VerifySpec } from "./verify-spec";
export type { CiJob } from "./ci-job";
export type { JobState } from "./forge/forge";

/** This Run's checks as a human would type them, for a prompt to name what it faces. */
export { renderApproved } from "./verify-spec";

/**
 * What kind of result a Run is for, and what the journal says it actually collected —
 * for a merge request to say what was proved rather than what an Output claimed.
 */
export {
  baseFailuresOf,
  baselinesOwed,
  evidenceRoots,
  flakesOf,
  isOutcome,
  recheckOwed,
  renderEvidence,
  renderRecordedChecks,
  rerunsOwed,
  settledChecks,
  wholeRunsOwed,
  type Outcome,
} from "./outcome";

/** A Check's proof on this tree, and which of a Run's Checks it runs itself. */
export { checkProof, owedLocally, type CheckProof, type Unmatched } from "./check-proof";

/** Text with every credential-shaped value replaced, before it is published. */
export { redact } from "./redact";

/** The fingerprint of a tree too large to measure: two of them are not the same tree. */
export { TOO_LARGE } from "./verify";

/**
 * Which of the five kinds of work a work source is. A workflow that reads a plan
 * directory differently from a Linear issue asks here rather than guessing from the text.
 */
export { classifyWorkSource } from "./inputs";

/**
 * A list of work, and the hand-off between its items. An item is known by its name and
 * never by where it sits, so a module that writes its own loop reuses what it has done
 * after a reordering.
 */
export { identityProblem, renderProgress, type Handed } from "./slices";

/**
 * A plan directory as the work it is: its tickets in an order they can be built in, and
 * the repositories they change. Ordinary functions over text and a directory, so a module
 * reads the plan it was given rather than being handed a reading of it.
 */
export {
  afterMergeIn,
  checksIn,
  criteriaIn,
  isSingleRepo,
  orderedTickets,
  orderedTicketsOf,
  planReposOf,
  readPlanRepos,
  type PlanRefusal,
  type PlanRepo,
  type PlanRepos,
  type Slice,
} from "./plan";

/**
 * Instructions whose `{{name}}` expressions read only the input it declares: `template`
 * refuses any other when it is made, so a module that loads has none, and `agentWork`
 * refuses one left unfilled before any agent starts.
 */
export class Template<Input> {
  declare readonly input: Input;
  constructor(readonly text: string) {}
}

/** What every agent's instructions may name without declaring it: `agentWork` gives it. */
const GIVEN: ReadonlySet<string> = new Set(["role", "cwd", "output_path"]);

const isStruct = (schema: unknown): schema is { readonly fields: Schema.Struct.Fields } =>
  Predicate.hasProperty(schema, "fields") && Predicate.isObject(schema.fields);

/** Whether `path` names a declared field, or one a field that is a map may hold. */
const declares = (
  fields: Schema.Struct.Fields,
  [head = "", ...rest]: ReadonlyArray<string>,
): boolean => {
  const field = fields[head];
  if (field === undefined) return false;
  if (rest.length === 0) return true;
  if (isStruct(field)) return declares(field.fields, rest);
  // A record's keys are its values', and nothing here can know them ahead.
  return Predicate.hasProperty(field, "key") && Predicate.hasProperty(field, "value");
};

/**
 * Instructions, and the input they take. What the text names and `fields` does not
 * declare is refused here, so a template made where a module loads is checked by every
 * load of it — `collie doctor` and `collie workflow check` among them.
 */
export function template<const Fields extends Schema.Struct.Fields>(
  text: string,
  fields: Fields,
): Template<Schema.Struct<Fields>["Type"]> {
  const undeclared = Arr.filter(
    expressionsIn(text),
    (name) => !(GIVEN.has(name) || declares(fields, Str.split(name, "."))),
  );
  const wrong = [...Arr.map(undeclared, (name) => `{{${name}}}`), ...malformedIn(text)];
  if (wrong.length > 0) {
    throw new Error(
      `this template names ${Arr.join(wrong, ", ")}, which nothing fills: declare ${wrong.length === 1 ? "it" : "them"} among what it takes, or remove ${wrong.length === 1 ? "it" : "them"}`,
    );
  }
  return new Template(text);
}

/** What agents are told, read from Markdown: see `contentOf`. */
export interface Content {
  readonly preamble: string;
  readonly sections: ReadonlyMap<string, string>;
  /** A section under the preamble; one the file does not have is refused, never sent empty. */
  readonly prompt: (section: string) => string;
  /** A section under the preamble, as a template of what it takes: see `template`. */
  readonly template: <const Fields extends Schema.Struct.Fields>(
    section: string,
    fields: Fields,
  ) => Template<Schema.Struct<Fields>["Type"]>;
}

/**
 * A Markdown file as the content it is: what stands above the first heading, and one
 * entry per `## name` section below it. Front matter is refused: what a workflow takes
 * and does is its definition's, where it is checked, and a second copy here would drift.
 */
export function contentOf(markdown: string): Content {
  if (FRONT_MATTER.test(markdown)) {
    throw new Error(
      "this Markdown has front matter, and a workflow's inputs, steps and questions belong in its definition: keep only what agents are told here",
    );
  }
  const { preamble, sections } = bodySections(markdown);
  const prompt = (section: string) => {
    const body = sections.get(section);
    if (body === undefined) {
      throw new Error(
        `there is no "## ${section}" section here; there is ${Arr.join([...sections.keys()], ", ") || "none"}`,
      );
    }
    return Arr.join(
      Arr.filter([preamble, body], (part) => part !== ""),
      "\n\n",
    );
  };
  return {
    preamble,
    sections,
    prompt,
    template: (section, fields) => {
      const text = prompt(section);
      try {
        return template(text, fields);
      } catch (cause) {
        throw new Error(
          `"## ${section}": ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
  };
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Everything still missing before this Run may say it proved its kind of result, one
 * sentence each. Empty means the evidence is there.
 *
 * Asked of what a module has: its own Outputs, and the directories it owns. A claim in
 * an Output is only ever a claim — what decides a check is the journal, bound to the
 * tree in front of it.
 */
export function evidenceGapsOf(options: EvidenceAsk): ReadonlyArray<string> {
  return evidenceGaps(options.kind, collectedOf(options));
}

/**
 * The gaps among those a verification on this tree could close: what a fix may be
 * handed. A reviewer's judgement and an Output's claim are not moved by running anything.
 */
export function checkGapsOf(options: EvidenceAsk): ReadonlyArray<string> {
  return checkGaps(options.kind, collectedOf(options));
}

/** The gaps among those a fresh review could close: what is worth paying a reviewer for. */
export function reviewGapsOf(options: EvidenceAsk): ReadonlyArray<string> {
  return reviewGaps(options.kind, collectedOf(options));
}

/**
 * Whether the Run is done with no patch to deliver, which is an outcome and not a failure:
 * an investigation that says so, or a performance Run whose tree is its latest base tree again.
 */
export function endsWithoutPatchOf(options: EvidenceAsk): boolean {
  return endsWithoutPatch(options.kind, collectedOf(options));
}

export interface EvidenceAsk {
  readonly kind: Outcome;
  readonly evidence: CheckEvidence;
  readonly approved: ReadonlyArray<VerifySpec>;
  /** What each piece of work reported, by the name it was done under. */
  readonly outputs: Readonly<Record<string, Schema.Json>>;
  /** Which of those are a reviewer's judgement rather than the implementer's claim. */
  readonly reviewed: ReadonlyArray<string>;
  /** The tree each of those reviewed. A `performance` verdict counts only from a review of the tree in front of it. */
  readonly reviewedOn?: Readonly<Record<string, Snapshot>>;
  /** The directories this Run owns, which a reference it gives has to point inside. */
  readonly roots: ReadonlyArray<string>;
  readonly tickets: ReadonlyArray<{
    readonly file: string;
    readonly checks: ReadonlyArray<string>;
  }>;
}

const collectedOf = (options: EvidenceAsk) => ({
  verifications: options.evidence.verifications,
  final: options.evidence.final,
  approved: options.approved,
  commands: options.evidence.commands,
  outputs: new Map(Rec.toEntries(options.outputs)),
  reviewed: new Set(options.reviewed),
  reviewedOn: new Map(Rec.toEntries(options.reviewedOn ?? {})),
  measurements: options.evidence.measurements,
  mergeBase: options.evidence.mergeBase,
  content: options.evidence.content,
  insideRun: (ref: string) => refInside(options.roots, ref),
  tickets: options.tickets,
});

/**
 * A workflow's failure, as every workflow reports one. One shape rather than an
 * author's own union, because what a host does with a failure is show it: a Run that
 * ended badly is a Run, not a value another workflow destructures.
 */
export class WorkflowError extends Schema.TaggedError<
  WorkflowError,
  { readonly brand: unique symbol }
>()("WorkflowError", {
  reason: Schema.String,
}) {
  /** A defect keeps only its message, so a died refusal still names its reason. */
  override get message() {
    return this.reason;
  }
}

/** The Run a workflow is executing as: supplied by the host, never passed by hand. */
export interface RunApi {
  readonly id: string;
  /** The public id of the workflow it is a Run of. */
  readonly workflow: string;
}

export class Run extends Context.Service<Run, RunApi>()("collie/Run") {}

export type { ClaudeSubagents } from "./subagents";

/** Which agent does the work: each is inherited from the configuration where it is left out. */
export interface AgentPreferences {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly claudeSubagents?: import("./subagents").ClaudeSubagents;
  /** Past this share of its busiest window, 1–100, this agent is not chosen for new work. */
  readonly upTo?: number;
  /**
   * What to try, in order, once this agent is past `upTo` or its Subscription is
   * Exhausted, before the human's `fallbacks`. Each fills in from this one.
   */
  readonly otherwise?: ReadonlyArray<AgentPreferences>;
}

/**
 * One place at a panel: the agent that sits there, and what it is and is told where that
 * is not its role's persona and its work's own instructions.
 */
export interface Seat extends AgentPreferences {
  /** Tells this seat's work apart from the others', in its operation's name. */
  readonly name?: string;
  /** The persona it is started as, in place of its role's. */
  readonly persona?: string;
  /** What it is told in place of its work's instructions, filled from the same input. */
  readonly instructions?: string | Template<unknown>;
}

/**
 * What a definition prefers: for all of its work, and over that for the work of a role —
 * one seat, or a panel of them — which is how a fork moves one role's agents and leaves
 * everything else the original's.
 */
export interface WorkflowAgentPreferences extends AgentPreferences {
  readonly roles?: Readonly<Record<string, Seat | ReadonlyArray<Seat>>>;
}

/** The agent preferences in force where work is asked for, outermost first. */
export const AgentScopes = Context.Reference<ReadonlyArray<AgentPreferences>>(
  "collie/AgentScopes",
  {
    defaultValue: () => [],
  },
);

/** What a definition prefers for its own work, under anything a Run or a scope prefers. */
export const WorkflowAgents = Context.Reference<WorkflowAgentPreferences | undefined>(
  "collie/WorkflowAgents",
  { defaultValue: () => undefined },
);

const isPanel = (seats: Seat | ReadonlyArray<Seat>): seats is ReadonlyArray<Seat> =>
  Arr.isArray<typeof seats>(seats);

/**
 * The panel this workflow's definition seats for a role: every seat it names, or one that
 * prefers nothing of its own where it names none. Work given a seat sits at it.
 */
export const panelOf = (role: string): Effect.Effect<readonly [Seat, ...Seat[]]> =>
  Effect.gen(function* () {
    const given = (yield* WorkflowAgents)?.roles?.[role];
    const [first = {}, ...rest] = given === undefined ? [] : isPanel(given) ? given : [given];
    return [first, ...rest];
  });

/**
 * Every piece of agent work inside `effect` prefers these — through any helper and into any
 * child — unless something nearer says otherwise. Parallel branches each keep their own.
 */
export const withAgents =
  (preferences: AgentPreferences) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const scopes = yield* AgentScopes;
      return yield* Effect.provideService(effect, AgentScopes, [...scopes, preferences]);
    });

/** What a workflow's own code may use without providing it: the host lends all of it. */
export type Lent =
  | Run
  | Host
  | Agents
  | Children
  | WorkflowEngine
  | WorkflowInstance
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

export interface WorkflowConnections {
  readonly needs?: Partial<Record<ConnectionId, { readonly with: string }>>;
  readonly uses?: Partial<
    Record<ConnectionId, { readonly with: string; readonly without: string }>
  >;
}

/** What a definition declares about itself beside what it does. */
export interface Declarations {
  readonly connections?: WorkflowConnections;
  /** The Steps it expects to take, in order: a forecast, never a precondition. */
  readonly path?: ReadonlyArray<Step>;
  /** Input field to the strategy that infers it. At most one field per exclusive one. */
  readonly hints?: Readonly<Record<string, InputStrategy>>;
  readonly outcome?: OutcomeContract;
  /**
   * What this workflow needs of the repository. `branch` builds on a worktree of its own
   * and `roaming` on a detached one; the host makes it before the Run exists. Absent works
   * in the checkout the Run was started for.
   */
  readonly checkout?: "branch" | "roaming";
  readonly closes?: "reported";
  readonly followUps?: ReadonlyArray<FollowUp>;
  readonly actions?: ReadonlyArray<ActionProvider>;
}

/**
 * A definition as the host reads one from a module's default export, before its defaults
 * are filled in. Its run may use what the host lends and nothing else: services of its
 * own come from its layer.
 */
export interface WrittenDefinition extends Declarations {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly input?: Schema.Struct<InputFields>;
  readonly output?: HostCodec;
  /** A typed failure of the workflow's own, beside the `WorkflowError` every workflow has. */
  readonly error?: HostCodec;
  /** The agent every piece of work defaults to, over the operator's configuration. */
  readonly agents?: WorkflowAgentPreferences;
  readonly layer?: Layer.Layer<never, never, Exclude<Lent, Run | WorkflowInstance>>;
  readonly run: (context: { readonly input: never }) => Effect.Effect<unknown, unknown, Lent>;
}

/** A workflow: its identity, what it takes and gives, what it declares, and what it does. */
export interface WorkflowDefinition extends WrittenDefinition {
  readonly title: string;
  readonly description: string;
  readonly input: Schema.Struct<InputFields>;
  readonly output: HostCodec;
}

/** A definition as its author wrote it, with every type the author's code is held to. */
export interface Definition<
  Fields extends Schema.Struct.Fields,
  Output extends Schema.Top,
  Err extends Schema.Top,
  Provided,
> extends Declarations {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly input?: Schema.Struct<Fields>;
  readonly output?: Output;
  readonly error?: Err;
  readonly agents?: WorkflowAgentPreferences;
  readonly layer?: Layer.Layer<Provided, never, Exclude<Lent, Run | WorkflowInstance>>;
  readonly run: (context: {
    readonly input: Schema.Struct<Fields>["Type"];
  }) => Effect.Effect<Output["Type"], WorkflowError | Err["Type"], Lent | Provided>;
}

/**
 * A workflow, as the one thing its module exports by default. Left out, the title is the
 * id, the description is empty, it takes nothing and it gives nothing back.
 */
export const defineWorkflow = <
  const Fields extends Schema.Struct.Fields = {},
  Output extends Schema.Top = typeof Schema.Void,
  Err extends Schema.Top = typeof Schema.Never,
  Provided = never,
>(
  definition: Definition<Fields, Output, Err, Provided>,
): Definition<Fields, Output, Err, Provided> => definition;

/** A definition with its defaults filled in. */
export const definitionOf = (written: WrittenDefinition): WorkflowDefinition => ({
  ...written,
  title: written.title ?? written.id,
  description: written.description ?? "",
  input: written.input ?? Schema.Struct({}),
  output: written.output ?? Schema.Void,
});

/**
 * What the host lends a workflow module; ticket 01's proof host provides it.
 *
 * `held` and `stopRequested` are plain Effects rather than Activities on purpose: an
 * operator sets a control between attempts, and an Activity would hand back the answer
 * from the attempt that first ran.
 */
/** What `claim` holds, or why the claims a Run needs could not be settled. */
export type Claimed =
  | {
      readonly slugs: ReadonlyArray<string>;
      /** What a free-only claim left to whoever holds it. */
      readonly left?: ReadonlyArray<{ readonly slug: string; readonly holder: string }>;
    }
  | { readonly unresolved: string };

const Holding = Schema.Union([
  Schema.Struct({
    slugs: Schema.Array(Schema.String),
    left: Schema.optionalKey(
      Schema.Array(Schema.Struct({ slug: Schema.String, holder: Schema.String })),
    ),
  }),
  Schema.Struct({ unresolved: Schema.String }),
]);

/**
 * What a claim journaled before a Run could hold several: one project, or null where it
 * went on holding none, which is read as unsettled so a replay asks rather than goes on.
 */
const SingleClaim = Schema.NullOr(Schema.Struct({ slug: Schema.String })).pipe(
  Schema.decodeTo(Holding, {
    decode: SchemaGetter.transform((one) =>
      one === null
        ? { unresolved: "an earlier Collie took this claim and held no Helle project" }
        : { slugs: [one.slug] },
    ),
    encode: SchemaGetter.forbidden(() => "a claim is journaled in its current shape"),
  }),
);

export const ClaimedSchema = Schema.Union([Holding, SingleClaim]);

export interface HostApi {
  readonly dir: string;
  /** The Collie release this host runs, as its tag names it. */
  readonly build: string;
  /** This Machine's Run report, for admissions at or after the ISO moment. */
  readonly report: (since: string) => Effect.Effect<Report, WorkflowError>;
  /** Open issues on the forge of this Run's checkout, or with `numbers` those issues read one by one. */
  readonly issues: (
    runId: string,
    numbers?: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<Issue>, WorkflowError>;
  /** Files redacted text on this Run's forge; another checkout's identity is refused. */
  readonly fileIssue: (options: {
    readonly runId: string;
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<IssueRef, WorkflowError>;
  /** Comments with the same redaction and checkout safeguards as filing. */
  readonly commentIssue: (options: {
    readonly runId: string;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, WorkflowError>;
  /**
   * This Machine's Usage readings, one per Subscription (ADR-0049). Read it inside an
   * Activity of the workflow's own where the workflow branches on it, so a replay takes
   * the same branch.
   */
  // oxlint-disable-next-line effecttsgo/lazy-effect -- Published author workflows call usage(); retain that source contract.
  readonly usage: () => Effect.Effect<ReadonlyArray<UsageReading>>;
  /** The installed `SKILL.md` an agent's `{{skill:name}}` would name, or null. */
  readonly skill: (name: string) => Effect.Effect<string | null>;
  /**
   * This Run as the host admitted it. The checkout is the one it was started for — its
   * own workspace where a caller named one — the directory is this Run's, where a plan, a
   * review and anything else a card reads is looked for, and the options are what the
   * host itself was given beside the author's input.
   */
  readonly place: (runId: string) => Effect.Effect<Place>;
  /**
   * The branch `checkoutReviewed` would check out, or its refusal in the same words. It
   * cuts and records nothing, so a workflow can ask before offering a fix. Take it inside
   * an Activity, so a replay answers the same.
   */
  readonly reviewedBranch: (runId: string) => Effect.Effect<ReviewedBranch>;
  /**
   * The checkout of the branch this Run's diff target names, recorded as the Run's own:
   * `place` answers with it from then on, and every verification is bound to it
   * (ADR-0054). The one git already has, else one cut from the branch; asking again
   * answers from the record. Take it inside an Activity, so a replay does not cut again.
   * `inStarter` lets it work in the checkout of the Run that started it and waits on it
   * alone, where that checkout is clean, at the branch's head and idle: only for work
   * that commits and pushes nothing, since that checkout's branch is the starter's own.
   */
  readonly checkoutReviewed: (
    runId: string,
    opts?: { readonly inStarter?: boolean },
  ) => Effect.Effect<ReviewedCheckout>;
  /**
   * Where Run `failed` had its reviewed checkout refused, why another on `target`, a merge
   * request or diff target, that this Run starts and waits on, taking it with `inStarter`,
   * would still be refused now,
   * in `checkoutReviewed`'s words. Null where it would not be, or where `failed`'s checkout
   * was never refused. It cuts and records nothing. Take it inside an Activity, so a
   * replay answers the same.
   */
  readonly reviewedRefusal: (
    runId: string,
    failed: string,
    target: string,
  ) => Effect.Effect<string | null>;
  readonly held: (runId: string) => Effect.Effect<boolean>;
  readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
  readonly record: (runId: string, event: string) => Effect.Effect<void>;
  /** Records that its work waits on a Subscription to reset; null says it no longer does. */
  readonly usageWait: (
    runId: string,
    wait: { readonly account: string; readonly resetsAt: string | null } | null,
  ) => Effect.Effect<void>;
  /** Records where the Run's work is among its Steps (ADR-draft-a-step-is-declared-where-its-work-is-written D4). */
  readonly step: (runId: string, note: StepNote) => Effect.Effect<void>;
  /**
   * Why this Run has parked its own work and what picks it up again, shown beside its
   * status; null says it no longer has.
   */
  readonly parked: (runId: string, why: string | null) => Effect.Effect<void>;
  /**
   * Records the question this run is waiting on, so the host can say what may answer it.
   * `asker` is the operation whose agent asked it, which the workflow is not woken for.
   */
  readonly asking: (runId: string, question: DecisionSpec, asker?: string) => Effect.Effect<void>;
  /** Every question this run has been asked, oldest first, with its answer once it has one. */
  readonly asked: (runId: string) => Effect.Effect<ReadonlyArray<AskedQuestion>>;
  /** Answers an open question with `value` as Collie, waking nothing that waits on it. */
  readonly close: (runId: string, decision: string, value: string) => Effect.Effect<void>;
  /**
   * What has been verified for this run, and the tree in front of it now. This is what
   * `settleFinalFix` is read against: a check an Output says it ran is a claim, and the
   * journal is what binds a result to the revision it was collected on.
   */
  readonly evidence: (runId: string, cwd: string) => Effect.Effect<CheckEvidence>;
  /**
   * Runs one of this Run's checks, and records what it did against the tree it ran on. A
   * name that is not among them is refused. Where the latest record of exactly its command
   * on this tree is a pass this host collected in the same environment, whoever asked for
   * it, that record answers and nothing runs; never for `expect: "fail"` or `at`.
   */
  readonly verify: (options: {
    readonly runId: string;
    readonly name: string;
    readonly cwd: string;
    /** What a pass looks like; `fail` is how a reproduction is proved to reproduce. */
    readonly expect?: "pass" | "fail";
    /**
     * Run it at the merge-base of this checkout and the default branch, in the same
     * checkout, then put it back. Refused on a checkout with changes of its own. This is
     * the `baseline` pass, whatever `pass` says.
     */
    readonly at?: "default-base";
    /**
     * Why it is run, which every door shows while it runs (ADR-0042): `gate` on the branch,
     * `rerun` of one failed `test` alone, `recheck` of the whole check on the same tree for a
     * flake, or `fix` after gate fix `round`. Absent is a plain `check`.
     */
    readonly pass?: "gate" | "rerun" | "recheck" | "fix";
    readonly round?: number;
    /**
     * The failed test a `rerun` runs: `bun test <file> -t <its whole name>` in the check's
     * directory, from the sources, recorded under the check's name. It passed only where
     * exactly one test ran and passed. With `at`, it is run at the base once per revision,
     * and failed there only where bun reported it failing.
     */
    readonly test?: FailedTest;
  }) => Effect.Effect<Verification, WorkflowError>;
  /**
   * This Run's checks as they stand now: what Collie runs itself to prove it. A prompt
   * names them so an agent knows what its work is held to, and the gate reads them again
   * at every pass, since anyone may name another with `collie run intent verification`.
   */
  readonly approved: (runId: string) => Effect.Effect<ReadonlyArray<VerifySpec>>;
  /**
   * One value from the operator's own configuration, by its dotted name, as text (`true` for
   * a setting turned on), and empty where they have set none. What a shipped workflow must
   * not hard-code — which team files its issues, where its logs are — is asked for here
   * rather than written into its content.
   */
  readonly config: (dotted: string) => Effect.Effect<string>;
  /** This Machine's reading; take it inside an Activity when branching on it. */
  readonly connection: (id: ConnectionId) => Effect.Effect<ConnectionReading>;
  /** Posts this Run's recorded merge request, linked by its forge title; a refusal never fails the Run. */
  readonly shareForApproval: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly channel: string;
  }) => Effect.Effect<{ readonly posted: boolean; readonly link?: string; readonly why?: string }>;
  /**
   * Whether a merge request can be opened from this checkout, and what it would carry —
   * the configured assignee, the repository's own template, the issues this branch
   * answers. One question rather than two: a step that cannot reach its forge has nothing to
   * fill in, and asking separately is how the two stop agreeing.
   */
  readonly mr: (options: {
    readonly cwd: string;
    /** What this Run was pointed at, where that is a merge request. */
    readonly target?: string;
    /** The work it is building, so the issues it answers can be found. */
    readonly source?: { readonly value: string; readonly kind: string };
  }) => Effect.Effect<MrReady>;
  /**
   * The URL of the checkout's branch's open merge request where it merges itself once
   * green, else null: a push to it would be a merge (ADR-0050 D4). Read fresh each time.
   * Fails, saying why, where the forge cannot be read: not knowing is not a no.
   */
  readonly autoMerging: (cwd: string) => Effect.Effect<string | null, WorkflowError>;
  /**
   * The job proving one of this Run's checks left to CI, read through the forge on the head
   * of the merge request the Run recorded, which must be `cwd`'s HEAD. A pass is recorded
   * once per tree as the check's `ci` Verification, with the job's URL. With `wait`, a job
   * pending or running is read again every 30 s for up to 2 hours, and the Run's log and
   * checks say which check, job and commit it waits on. Anything else is why it is unproved,
   * naming all three.
   */
  readonly ciJob: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly name: string;
    readonly wait?: boolean;
    /**
     * A failed job is read where the branch leaves its target, and is retried once and
     * waited on where it did not fail there too (ADR-0034): `before` and `retried` say which.
     */
    readonly settle?: boolean;
  }) => Effect.Effect<CiJob>;
  /** Puts a note on the merge request this Run recorded, sent by Collie rather than an agent. */
  readonly note: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly body: string;
  }) => Effect.Effect<Posted>;
  /**
   * Blocks until this Run holds every shared claim it needs, each recorded on the Run, and
   * answers which; `unresolved` says why the claims it needs could not be settled, and
   * nothing is claimed. Without `deploys` that is the repository's own project; with them,
   * also every project they name. A repository's `.collie/helle.json` overrides both.
   * Waiting here costs wall clock and no model tokens, which is the point of claiming
   * before an agent starts rather than after. `adopting` is asked only where a claim was
   * already the operator's own, so the question is the workflow's — durable, and
   * answered once.
   */
  readonly claim: <E, R>(options: {
    readonly runId: string;
    readonly cwd: string;
    readonly adopting: Effect.Effect<boolean, E, R>;
    readonly say: (line: string) => Effect.Effect<void, E, R>;
    /** What a release deploys: its applications, and its deploy jobs (`stage:<app>`). */
    readonly deploys?: {
      readonly applications: ReadonlyArray<string>;
      readonly jobs: ReadonlyArray<string>;
    };
    /**
     * Takes only the projects nobody else holds or queues for and waits for none; `left`
     * names each it did not take, and who has it.
     */
    readonly free?: boolean;
  }) => Effect.Effect<Claimed, WorkflowError | E, R>;
  /**
   * Who holds each shared claim `claim` would take for the same `deploys`, read without
   * joining any queue, with the projects each application needs and the applications each
   * deploy job names.
   */
  readonly holders: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly deploys?: {
      readonly applications: ReadonlyArray<string>;
      readonly jobs: ReadonlyArray<string>;
    };
  }) => Effect.Effect<Holders, WorkflowError>;
  /**
   * Gives every claim back, and answers those Helle would not take, which stay recorded.
   * Only a Run that has finished its work releases: holding it across a consultation is
   * what stops anyone deploying on a half-finished change.
   */
  readonly release: (runId: string) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Records the merge request this Run opened. It is a fact about the Run from then on:
   * its card links it, says it waits on it, and follows what the forge says of it.
   */
  readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
  /**
   * Fetches the default branch and, where it has moved, merges it into the branch checked
   * out at `cwd`: a merge commit, never a rebase or a push. A checkout with uncommitted
   * changes is left alone (`waiting`); a conflict leaves the merge in progress, naming its
   * files, for the builder to finish. Each merge is recorded in the Run log as
   * `integrated <branch>@<sha>`. Take it inside an Activity, so a replay does not merge again.
   */
  readonly integrate: (runId: string, cwd: string) => Effect.Effect<Integration>;
  /**
   * A Measurement of `cwd`, the Run's own checkout, against a base tree Collie makes at `base`
   * with the plan's harness commits applied: the plan's commands sampled A B B A … after its
   * warmup, while this Machine runs no other Measurement and is not Short of memory, and judged
   * per metric. Where these trees were measured under this plan, that record answers and `ran`
   * is false. A harness commit touching a path outside the plan's harness paths is refused,
   * naming each. Take it inside an Activity, so a replay does not measure again.
   */
  readonly measure: (options: {
    readonly runId: string;
    readonly base: string;
    readonly cwd: string;
    /** A key left out takes its default: warmup 1, samples 10, limit 600 s, threshold 5, tolerance 2. */
    readonly plan: typeof BenchmarkPlan.Encoded;
    /** `calibration`, `cycle N` or `final`. */
    readonly pass: string;
    /** Why the plan changed: refused without one where the Run was measured under another plan. */
    readonly reason?: string;
  }) => Effect.Effect<{ readonly measurement: Measurement; readonly ran: boolean }, WorkflowError>;
  /**
   * The commit origin's default branch is at now: everything merged there so far. Take it
   * inside an Activity, so a replay reads the same commit. Fails where origin cannot be read.
   */
  readonly defaultHead: (cwd: string) => Effect.Effect<string, WorkflowError>;
  /**
   * Where the checkout at `cwd` has no commits over its merge-base with the default branch,
   * the base a `default-base` verify runs at, and nothing uncommitted: records on this Run's
   * card and in its log that it had nothing to land, and answers why. Otherwise, or where
   * that base cannot be read, null. Take it inside an Activity.
   */
  readonly nothingToLand: (runId: string, cwd: string) => Effect.Effect<string | null>;
  /**
   * Merges the merge request this Run recorded at `head`, through the forge's REST merge,
   * never as an admin and never by auto-merge. The Run's landing record is written before
   * the forge is asked and says after what came of it; the merge watch reads it to leave this
   * Run, and the Runs it was started from, running when the merge lands. Answers `Merged`
   * with the merged commit, `HeadMoved` where the merge request's head is no longer `head`,
   * `MergedOutside` where someone else merged it first, or `Refused` with the forge's why.
   * Fails for a Run that recorded no merge request. Take it inside an Activity: a replay
   * settles an attempt an earlier host left on the forge's word rather than merging again.
   */
  readonly merge: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly head: string;
  }) => Effect.Effect<MergeOutcome, WorkflowError>;
  /**
   * One read of the review of the merge request this Run recorded, judged against `proved`,
   * the head its Checks were proved on: `Ready`, `Waiting` with what is missing, or any of
   * what `awaitReview` returns. `Unreadable` says why the forge could not be read. Take it
   * inside an Activity, so a replay takes the same path.
   */
  readonly review: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly proved: string;
    /** Unanswered comments already returned, which keep the review waiting rather than return. */
    readonly seen: ReadonlyArray<string>;
  }) => Effect.Effect<ReviewStanding, WorkflowError>;
  /**
   * Reads the review every 5 minutes, spending no model tokens, until it is `Ready` at
   * `proved`, has `Unanswered` external comments not in `seen`, has `Moved` from `proved`, is
   * `Merged` or `Closed`, or a Hold or Stop ends the wait (`Held`). A moved head is said
   * before readiness. Meanwhile the card's parked line says what it waits for, cleared when
   * it returns. Take it inside an Activity, and suspend the Run on `Held` there.
   */
  readonly awaitReview: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly proved: string;
    readonly seen: ReadonlyArray<string>;
    /**
     * Also return a `Waiting` review that needs a repair (a red pipeline, changes requested, a
     * merge the forge refuses) rather than wait for it.
     */
    readonly untilBlocked?: boolean;
  }) => Effect.Effect<ReviewStanding, WorkflowError>;
  /**
   * Replies to the comment with id `comment` on the merge request this Run recorded, posting
   * `body` with a last line naming the Run and its Machine, in the comment's thread where it
   * has one. Never resolves a thread. A comment already answered, as after a restart that
   * posted the reply before it was journaled, is `already` and gets no second reply. A posted
   * reply is recorded on the Run with its `kind`, and a `disputed` one is News. Take each
   * inside its own Activity.
   */
  readonly reply: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly comment: string;
    readonly body: string;
    readonly kind?: "fixed" | "disputed";
  }) => Effect.Effect<"posted" | "already", WorkflowError>;
  /**
   * The recorded merge request's head as the forge reports it, which of `commits` that head
   * carries (fetched from origin), and the ids of its external comments still unanswered.
   * Take it inside an Activity.
   */
  readonly reviewHead: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly commits: ReadonlyArray<string>;
  }) => Effect.Effect<ReviewHead, WorkflowError>;
  /**
   * Fetches origin and fast-forwards the checkout at `cwd` to `head`, recording the move in
   * the Run log. A checkout with uncommitted changes, or one `head` does not fast-forward
   * (a force push), is `Refused` with why: nothing is reset or discarded. Take it inside an
   * Activity.
   */
  readonly fastForward: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly head: string;
  }) => Effect.Effect<FastForward>;
  /**
   * Reads `tag` back from origin and the forge, rather than from an Output, against what it
   * must prove. Either way the tag is on origin and carries `merged`. `finished`, a
   * package's: where `pipeline` names one, the forge says it finished and succeeded; a
   * pipeline with a job waiting to be started by hand has not finished, and the answer names
   * the job. `staged`, an application's: `InProduction` where production already carries
   * `merged`; else each `stage` job passed and stage's newest successful deployment carries
   * `merged`, or it is `StageFailed`; every other job passed and none is still running or waiting to run; and each `production`
   * job, one at least, waits to be started by hand, which `Proved` lists with its address.
   * The pipeline's own state is not read. Take it inside an Activity.
   */
  readonly readTag: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly tag: string;
    readonly merged: string;
    /** The tag's pipeline, or null where it named none. */
    readonly pipeline: string | null;
    readonly proves: "finished" | "staged";
    /** For `staged`: the stage deploy and stage check jobs of the pipeline. */
    readonly stage?: ReadonlyArray<string>;
    /** For `staged`: the production jobs of the pipeline. */
    readonly production?: ReadonlyArray<string>;
  }) => Effect.Effect<TagRead>;
  /**
   * Reads again, before production jobs are played: `Carried` where production already
   * carries `merged`; `Unproved` where the tag on origin is no longer `at` or no longer
   * carries it, one of `jobs` is gone
   * from the pipeline or failed, or any other job failed or is still running or waiting to run; else `Play` with those of `jobs` still waiting to be
   * started by hand, none where somebody started them. Take it inside an Activity.
   */
  readonly readProduction: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly tag: string;
    /** `Proved`'s `at`: the tag's object on origin when it was proved. */
    readonly at: string;
    readonly merged: string;
    readonly pipeline: string;
    readonly jobs: ReadonlyArray<string>;
  }) => Effect.Effect<ProductionRead>;
  /**
   * Reads the recorded merge request's head on stage from the forge, rather than from an
   * Output, one stage environment at a time: `Staged` where each of `jobs`, one at least,
   * passed on its head's pipeline, and the newest successful deployment of every stage
   * environment that pipeline deployed to, one at least, carries `head`, with each job's
   * address and those environments; `Moved` where its head is no longer `head`; else `Failed`
   * with why, and the environments the pipeline reached where they could be read. Take it
   * inside an Activity.
   */
  readonly readStage: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly head: string;
    readonly jobs: ReadonlyArray<string>;
  }) => Effect.Effect<StageRead>;
  /**
   * Whether the forge shows stage rolled back: the newest successful deployment of each of
   * `environments` carries none of `off` and carries what production's has. Where
   * `environments` is not given, stage's newest successful deployment is read instead. Take
   * it inside an Activity.
   */
  readonly readRollback: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly off: ReadonlyArray<string>;
    readonly environments?: ReadonlyArray<string>;
  }) => Effect.Effect<RollbackRead>;
  /**
   * For a merged merge request this Run recorded: takes over the landing of the newest Run
   * on this host that landed it, where that Run ended without succeeding and the forge's
   * merged commit is the one it recorded. The landing is recorded on this Run, naming the
   * Run it came from. `Refused` says why not: merged outside a Release Run, already
   * released, or still being released. Take it inside an Activity.
   */
  readonly takeOverLanding: (options: {
    readonly runId: string;
    readonly cwd: string;
  }) => Effect.Effect<Takeover, WorkflowError>;
  /**
   * Blocks until the forge shows production carries `sha`, costing wall clock and no model
   * tokens, and says on the card meanwhile what it waits for: `jobs` are the production
   * jobs, and they and `slug` word the line only. Jobs left for a person to play park the
   * Run as Needs you; `played` jobs, or none, are awaited. A forge that cannot say is
   * waited on too. Answers true once production carries it, false where the Run was
   * stopped or held first.
   */
  readonly awaitProduction: (options: {
    readonly runId: string;
    readonly cwd: string;
    readonly sha: string;
    readonly jobs: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
    /** The jobs were played already, by this Run or somebody. */
    readonly played?: boolean;
    /** The claims held meanwhile, where the Run holds any. */
    readonly slug?: string;
    /** The repository's web address, which a job without its own is played at. */
    readonly url: string;
  }) => Effect.Effect<boolean>;
  /**
   * Puts a note on the merge request a Run was pointed at, sent by Collie rather than
   * written out again by an agent — asking for a file to be repeated verbatim is how
   * verbatim stops being true. The refusal is the message: a target that is not a merge
   * request, no CLI or login for its forge, or one assigned to whoever is running this.
   * With `approve`, the merge request is approved too, and the message says whether it was.
   */
  readonly post: (options: {
    readonly runId: string;
    readonly target: string;
    readonly cwd: string;
    /** The file to send, as the Run wrote it. */
    readonly file: string;
    /** Approve the merge request too: a review with nothing live left to fix. */
    readonly approve?: boolean;
  }) => Effect.Effect<Posted>;
}

/** A Run as the host admitted it: where it works, where its work belongs, and what it was given. */
export interface Place {
  readonly cwd: string;
  readonly dir: string;
  /**
   * The host's own launch options, plus agent preferences inherited from a parent Run.
   * They stay separate from the author's input payload.
   */
  readonly options: Readonly<Record<string, string>>;
  /** The Task this Run belongs to, whose workspace its agents open in; null for none. */
  readonly task: string | null;
  /** A workspace of the Run's own, where it asked for one; null lives in its Task's. */
  readonly workspace: string | null;
  /** This Run, then the Runs it was started from or builds a plan of, and so on: whose agents it may ask. */
  readonly lineage: ReadonlyArray<string>;
  /** What a Claude agent's auto mode is told this Run authorises: the branch it made, and who started it. */
  readonly authority: RunAuthority;
}

/** The reviewed branch's checkout, or why there is none, in the resolver's own words. */
export type ReviewedCheckout =
  | { readonly cwd: string; readonly branch: string }
  | { readonly refused: string };

/** The reviewed branch, or why there is none, in the resolver's own words. */
export type ReviewedBranch = { readonly branch: string } | { readonly refused: string };

/** What opening a merge request from here needs, and what it would be filled in with. */
export interface MrReady {
  readonly ok: boolean;
  /** The checkout's forge; absent on a host that only supports GitLab. */
  readonly provider?: "gitlab" | "github";
  /** The repository's path on its forge — `owner/repo` or `group/project` — for `--repo`. */
  readonly repository?: string;
  /** Why it cannot be done here. Empty where it can. */
  readonly reason: string;
  /** The GitLab configured assignee or authenticated user; the authenticated user on GitHub. */
  readonly assignee: string;
  /** The repository's merge request template, relative to the checkout; empty for none. */
  readonly template: string;
  /** The Linear issues this branch answers. */
  readonly issues: ReadonlyArray<string>;
  /** "GitLab" or "GitHub"; absent where the checkout's forge could not be read. */
  readonly forge?: string;
  /** "merge request" or "pull request", as the forge says it. */
  readonly noun?: string;
  /** The checkout's branch; empty on a detached checkout. */
  readonly branch?: string;
  /** The repository's web address, as its forge's adapter writes it. */
  readonly url?: string;
  /** The URL of this branch's open merge request, or empty for none. */
  readonly existing?: string;
  /** Whether `existing` merges itself once green, so a push to it is a merge. */
  readonly autoMerge?: boolean;
  /** The command lines an agent runs, written by the forge's adapter. */
  readonly commands?: {
    /** Opens one, with `<title>`, `<file>` (the description file) and any `<iid>` left to fill in. */
    readonly create: string;
    /** Posts `<file>` as a note on `existing`; empty where there is none. */
    readonly comment: string;
  };
}

/** What became of a note: whether it landed, and the sentence a human reads either way. */
export interface Posted {
  readonly ok: boolean;
  readonly message: string;
}

// oxlint-disable-next-line effecttsgo/lazy-effect -- Host serves the published HostApi.usage() method unchanged.
export class Host extends Context.Service<Host, HostApi>()("collie/Host") {}

/** A question as the host records it: its identity, what it asks, and what it takes. */
export interface AskedQuestion {
  readonly name: string;
  readonly answer: string | null;
  /** Who answered it, where the Run's audit says. */
  readonly by?: Asker;
}

export interface DecisionSpec {
  readonly name: string;
  readonly prompt: string;
  /** The answers it takes. Empty is a question answered in the operator's own words. */
  readonly options: ReadonlyArray<string>;
}

/**
 * Waits for this question to be answered, having told the host it is open. It is asked
 * when the work reaches it: nothing declares it ahead.
 *
 * Both halves matter. Waiting is Effect's — the answer is durable and a restart comes
 * back to it. Saying so is Collie's: a host that does not know what a run is asking
 * cannot show the question, cannot refuse an answer to one nobody asked, and cannot tell
 * a second answer from the first.
 */
export const ask = (question: {
  /** Its identity: the same name is the same question, however often the work replays. */
  readonly name: string;
  readonly prompt?: string;
  /** The answers it takes; none is a question answered in the operator's own words. */
  readonly options?: ReadonlyArray<string>;
}): Effect.Effect<string, never, Run | Host | WorkflowEngine | WorkflowInstance> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    const at = yield* CurrentStep;
    if (at !== null)
      yield* Activity.make({
        name: `ask.${question.name}.step`,
        execute: host.step(runId, { kind: "question", key: at.key, name: question.name }),
      });
    yield* host.asking(runId, {
      name: question.name,
      prompt: question.prompt ?? question.name,
      options: question.options ?? [],
    });
    return yield* DurableDeferred.await(
      DurableDeferred.make(question.name, { success: Schema.String }),
    );
  });

/**
 * What a parent asks for when part of its own work is another workflow.
 *
 * The child is named by its public id and selected in the parent's own project, so a
 * project that overrides a module gets that override in the work its parents start too.
 * `invocation` is the identity: the same one twice is the same child, which is what makes
 * replaying a parent reuse the child it already has rather than admit a second one.
 *
 * `input` is encoded, as every front door's is. The child's own schema decodes it before
 * anything exists, so a value it will not take is the parent's failure and not a child.
 */
export interface ChildAsk {
  readonly invocation: string;
  readonly workflow: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  /**
   * The host's own launch options for the child — the repository it is for, the checkout
   * it works in — as a front door supplies them. Only the host's own names are taken, so
   * a parent cannot put a field into a child's payload that its author never declared.
   */
  readonly options?: Readonly<Record<string, string>>;
  /** A Task of its own, with its own workspace and card, rather than the parent's. */
  readonly ownTask?: boolean;
}

/** A child as the host admitted it. `fresh` is false for an invocation already admitted. */
export interface ChildRun {
  readonly runId: string;
  readonly workflow: string;
  readonly invocation: string;
  readonly fresh: boolean;
}

/**
 * What a host lends a workflow that is made of other workflows. Two operations rather
 * than one, so fanning out is ordinary TypeScript: start what you want, then wait for it.
 */
export interface ChildrenApi {
  readonly start: (ask: ChildAsk) => Effect.Effect<ChildRun, WorkflowError>;
  /** Runs the child under this parent, which is what makes an interrupt reach both. */
  readonly result: (child: ChildRun) => Effect.Effect<unknown, WorkflowError>;
}

export class Children extends Context.Service<Children, ChildrenApi>()("collie/Children") {}

/**
 * One child workflow, started and waited on. Anything else is Effect's own operators. It
 * prefers the agents its parent prefers where it is started, unless its options say else.
 */
export const child = (ask: ChildAsk): Effect.Effect<unknown, WorkflowError, Children> =>
  Effect.gen(function* () {
    const children = yield* Children;
    return yield* children.result(yield* children.start(ask));
  });

/** What an author declares of a Step. Left out, its description is empty and it has no role. */
export interface StepDeclaration {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: StepKind;
  readonly role?: string;
  readonly produces?: Produces;
}

/** Which run of a Step a call is: a round under its bound, or an item of the list it comes from. */
export type StepCall =
  | { readonly round: number; readonly of?: number }
  | { readonly item: string; readonly items: ReadonlyArray<string> };

type Recording = Run | Host | WorkflowEngine | WorkflowInstance;

/**
 * A Step: called around the Effect that does its work, it runs that Effect unchanged and
 * records with the host when the work enters it and leaves it.
 */
export interface Step extends StepMeta {
  <A, E, R>(work: Effect.Effect<A, E, R>, place?: StepCall): Effect.Effect<A, E, R | Recording>;
  readonly meta: StepMeta;
}

/** Calls of each Step made without a place, per execution, so each is a run of its own. */
const unplaced = new WeakMap<object, Map<string, number>>();

const placeOf = (place: StepCall | undefined): StepPlace | null =>
  place === undefined
    ? null
    : "item" in place
      ? { item: place.item, items: [...place.items] }
      : { round: place.round, of: place.of ?? null };

/**
 * A Step, made where its work is written (ADR-draft-a-step-is-declared-where-its-work-is-written).
 * Its records are Activities, so a replay records nothing twice.
 */
export const step = (declared: StepDeclaration): Step => {
  const meta: StepMeta = {
    id: declared.id,
    title: declared.title,
    description: declared.description ?? "",
    kind: declared.kind,
    role: declared.role ?? null,
    produces: declared.produces ?? null,
  };
  const call = <A, E, R>(work: Effect.Effect<A, E, R>, given?: StepCall) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const instance = yield* WorkflowInstance;
      const place = placeOf(given);
      const calls = unplaced.get(instance) ?? new Map<string, number>();
      unplaced.set(instance, calls);
      const n = place === null ? (calls.get(meta.id) ?? 0) + 1 : 0;
      if (place === null) calls.set(meta.id, n);
      const key = runKey(meta.id, place, n);
      yield* Activity.make({
        name: `step.${key}.enter`,
        execute: host.step(runId, { kind: "enter", key, step: meta, place }),
      });
      if ((yield* host.held(runId)) || (yield* host.stopRequested(runId)))
        return yield* Workflow.suspend(yield* WorkflowInstance);
      const done = yield* Effect.provideService(work, CurrentStep, {
        step: meta.id,
        place,
        key,
      }).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : host.step(runId, { kind: "fail", key, why: failureOf(cause) }),
        ),
      );
      yield* Activity.make({
        name: `step.${key}.leave`,
        execute: host.step(runId, { kind: "leave", key }),
      });
      return done;
    });
  return Object.assign(call, { ...meta, meta });
};

const Said = Schema.Union([
  Schema.Struct({ reason: Schema.String }),
  Schema.Struct({ message: Schema.String }),
]);

/** Why a Step's work failed: a `WorkflowError`'s reason, an error's message, or what it is. */
const failureOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const said = Schema.decodeUnknownOption(Said)(error);
  if (said._tag === "None") return String(error);
  return "reason" in said.value ? said.value.reason : said.value.message;
};

/**
 * Records that the Step the work is in failed, where the Run parks to be resumed rather than
 * ending: the Step is drawn failed, saying why, until a resume enters it again.
 */
export const stepFailed = (why: string): Effect.Effect<void, never, Run | Host> =>
  Effect.gen(function* () {
    const at = yield* CurrentStep;
    if (at === null) return;
    yield* (yield* Host).step((yield* Run).id, { kind: "fail", key: at.key, why });
  });

/** Calls of `forecast`, per execution, so each forecast is an Activity of its own. */
const forecasts = new WeakMap<object, number>();

/**
 * The path from here, once the Run knows which branch it takes. The Flow forecasts from
 * the latest one; it is never a precondition.
 */
export const forecast = (path: ReadonlyArray<Step>): Effect.Effect<void, never, Recording> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    const instance = yield* WorkflowInstance;
    const n = (forecasts.get(instance) ?? 0) + 1;
    forecasts.set(instance, n);
    yield* Activity.make({
      name: `forecast.${n}`,
      execute: host.step(runId, { kind: "forecast", steps: Arr.map(path, (one) => one.meta) }),
    });
  });

/** The ids a path lists more than once: a Step is known by its id, so each is one Step. */
export const repeatedIds = (
  path: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<string> => {
  const ids = Arr.map(path, (one) => one.id);
  return Arr.dedupe(
    Arr.filter(ids, (id, at) => Arr.some(Arr.take(ids, at), (before) => before === id)),
  );
};

/**
 * A workflow as the host sees one: any input and any result, no service of the host's to
 * encode them, and the one error contract above.
 */
export type HostCodec = Schema.Codec<unknown, unknown, never, never>;
export interface HostPayload extends Schema.Struct<Schema.Struct.Fields> {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}
export type HostWorkflow = Workflow.Workflow<string, HostPayload, HostCodec, HostCodec>;

/** What a definition is registered as: the workflow, and how the host builds it. */
export interface Registration {
  readonly workflow: HostWorkflow;
  /**
   * What the host builds this generation from. The services in it are the ones a host
   * holds already: its own, and the file system and paths a module reads its work from.
   */
  readonly layer: Layer.Layer<
    never,
    never,
    | WorkflowEngine
    | Host
    | Agents
    | Children
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
  >;
}

/**
 * A field the host settles on the author's behalf. An ordinary schema, with one
 * requirement: it decodes without services of its own, because a launch is settled before
 * any of the author's Layers have been built.
 */
export type InputField = Schema.Codec<unknown, unknown, never, never>;
export type InputFields = Readonly<Record<string, InputField>>;

/**
 * The workflow's public identity and what it declares about itself. `id` is what an
 * operator types and never the registration name, which is the host's and opaque.
 */
export interface WorkflowEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly input: InputFields;
  readonly metadata?: WorkflowMetadata;
  /** What the workflow prefers for its own agents, under a Run's own and its scopes'. */
  readonly agents?: WorkflowAgentPreferences;
  readonly make: (registrationName: string) => Registration;
}

/** What a workflow may declare it needs of the repository. */
const DeclaredCheckout = Schema.Literals(["branch", "roaming"]);
const isDeclaredCheckout = Schema.is(DeclaredCheckout);

/**
 * What a card, a launch and a follow-up read: a hint says how an input is inferred, an
 * outcome says what closing needs, an action says what may be started next, a path what
 * the Flow forecasts. A workflow's body never consults any of it.
 */
export interface WorkflowMetadata {
  readonly connections?: WorkflowConnections;
  /** Input field to the strategy that infers it. At most one field per exclusive one. */
  readonly hints?: Readonly<Record<string, InputStrategy>>;
  readonly outcome?: OutcomeContract;
  /**
   * What this workflow needs of the repository. `branch` builds on a worktree of its own
   * and `roaming` on a detached one; the host makes it before the Run exists. Absent works
   * in the checkout the Run was started for.
   */
  readonly checkout?: typeof DeclaredCheckout.Type;
  readonly closes?: "reported";
  readonly followUps?: ReadonlyArray<FollowUp>;
  readonly actions?: ReadonlyArray<ActionProvider>;
  readonly path?: ReadonlyArray<StepMeta>;
}

/**
 * Either the kind this workflow always proves, or the kinds a human may ask it for —
 * one or the other. Both are optional here rather than a union, because the authority on
 * a contradiction is `checkEntry` at load: a module is JavaScript by then, and a type
 * that forbade it would only have made the check untestable.
 */
export interface OutcomeContract {
  readonly fixed?: Outcome;
  readonly selectable?: ReadonlyArray<Outcome>;
}

/** What a finished Run offers next, named by the public id of the workflow it starts. */
export interface FollowUp {
  readonly connections?: ReadonlyArray<ConnectionId>;
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly when: "succeeded" | "failed" | "always";
  /** What Collie fills in from the Run itself; the rest is the caller's to give. */
  readonly inputs?: Readonly<Record<string, Source>>;
  /** A further condition on the facts, where how it ended is not the whole of it. */
  readonly eligible?: (facts: ActionFacts) => boolean;
}

/**
 * The facts an action decides eligibility from. Facts, not a workflow name: a renamed or
 * user-authored workflow offers what its own results earn, exactly as a shipped one does.
 */
export interface ActionFacts {
  readonly outcome: Outcome;
  readonly succeeded: boolean;
  readonly branch: string | null;
  readonly mrUrl: string | null;
  /** It completed with no change to land, so there is nothing to carry on from. */
  readonly nothingToLand?: boolean;
  readonly planIssues: number;
  readonly disposed: boolean;
  /** Findings it left for somebody to fix, which is what a fix is offered over. */
  readonly openFindings: number;
  /** What it was pointed at, where it was pointed at anything. */
  readonly diffTarget: string | null;
  /** The shared claims it still holds, by the projects claimed; null where it holds none. */
  readonly claim: string | null;
}

/**
 * Something a card may offer. The `id` is stable and the `title` is what a human reads —
 * two fields because a retitled action is the same action, and a card that matched on the
 * title would start a different one. `arguments` is the child's schema, not presentation.
 */
export interface ActionProvider {
  readonly connections?: ReadonlyArray<ConnectionId>;
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly arguments: Schema.Struct.Fields;
  readonly eligible: (facts: ActionFacts) => boolean;
  /** What Collie fills in from the Run itself; the rest is the caller's to give. */
  readonly inputs?: Readonly<Record<string, Source>>;
}

/**
 * Names the host supplies at launch, with what each means. An input field of one of these
 * names would be shadowed by the host's own value without the author ever seeing it, so
 * declaring one is refused rather than silently overridden.
 */
export const RESERVED_INPUTS = {
  branch: "Branch selection for mutating work, offered by the host",
  task: "Task naming and association, never inferred from the workflow's name",
  workspace:
    "Where the checkout comes from: `new` for a worktree workspace of its own, an existing checkout's absolute path, or `projects-root` for the Projects root; distinct from the CLI's workspace scope",
  repo: "One repository's share of a multi-repository work source",
  outcome: "The selectable outcome, where the workflow does not fix one",
  risks: "Additional review axes, passed as declared context",
  previous: "Previous review context attached to the selected work",
  harness: "The harness this Run's agents run on, over the workflow's own preference",
  model: "The model this Run's agents run on, over the workflow's own preference",
  effort: "The effort this Run's agents are asked for, over the workflow's own preference",
} as const;

const IDENTITY = /^[a-z][a-z0-9-]*$/;

/** What a public id may be, so a command that writes one can refuse before the file exists. */
export const isWorkflowId = (id: string): boolean => IDENTITY.test(id);

const isReserved = (name: string): name is keyof typeof RESERVED_INPUTS => name in RESERVED_INPUTS;
const reservedMeaning = (name: string) => (isReserved(name) ? RESERVED_INPUTS[name] : "");
const KNOWN_STRATEGIES: ReadonlySet<string> = new Set(INPUT_STRATEGIES);

const Callable = Schema.declare(Predicate.isFunction);
const OfferFields = {
  connections: Schema.optionalKey(Schema.Array(ConnectionId)),
  id: Schema.String,
  title: Schema.String,
  workflow: Schema.String,
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
};

/** What metadata has to be before any of it can be read: a module is JavaScript by now. */
const DeclaredMetadata = Schema.Struct({
  connections: Schema.optionalKey(
    Schema.Struct({
      needs: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ with: Schema.NonEmptyString })),
      ),
      uses: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({ with: Schema.NonEmptyString, without: Schema.NonEmptyString }),
        ),
      ),
    }),
  ),
  hints: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  closes: Schema.optionalKey(Schema.Literal("reported")),
  outcome: Schema.optionalKey(
    Schema.Struct({
      fixed: Schema.optionalKey(Schema.String),
      selectable: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  followUps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...OfferFields,
        when: Schema.Literals(["succeeded", "failed", "always"]),
        eligible: Schema.optionalKey(Callable),
      }),
    ),
  ),
  actions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...OfferFields,
        arguments: Schema.Record(Schema.String, Schema.declare(Schema.isSchema)),
        eligible: Callable,
      }),
    ),
  ),
});
const readMetadata = Schema.decodeUnknownResult(DeclaredMetadata, { errors: "all" });

/**
 * Everything wrong with a module's declared identity and metadata, one sentence each.
 * Empty means it may be registered. The host calls this at load, before anything of the
 * author's runs and long before a Run, a worktree or an agent exists.
 */
export function checkEntry(entry: WorkflowEntry): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!IDENTITY.test(entry.id)) {
    problems.push(`workflow id "${entry.id}" is not an identity: lower case, digits and dashes`);
  }
  if (Str.trim(entry.title) === "") problems.push("title is required");
  const fields = new Set(Struct.keys(entry.input));
  for (const [name, field] of Rec.toEntries(entry.input)) {
    if (!Schema.isSchema(field)) problems.push(`input "${name}" is not a schema`);
  }
  for (const name of fields) {
    if (isReserved(name)) {
      problems.push(`input "${name}" collides with a host option: ${reservedMeaning(name)}`);
    }
  }
  const declared = entry.metadata === undefined ? null : readMetadata(entry.metadata);
  if (declared?._tag === "Failure") {
    return [
      ...problems,
      `${entry.id}: metadata is not what a workflow declares: ${declared.failure.message}`,
    ];
  }
  for (const kind of ["needs", "uses"] as const) {
    const connections = entry.metadata?.connections?.[kind] ?? {};
    for (const id of Struct.keys(connections)) {
      const text = connections[id];
      if (text === undefined) continue;
      if (!Schema.is(ConnectionId)(id)) problems.push(`${entry.id}: unknown Connection "${id}"`);
      for (const [column, value] of Rec.toEntries(text))
        if (Str.trim(value) === "")
          problems.push(`${entry.id}: ${kind}.${id}.${column} must have text`);
      if (kind === "uses" && id in (entry.metadata?.connections?.needs ?? {}))
        problems.push(`${entry.id}: Connection "${id}" is both needed and used`);
    }
  }
  problems.push(...hintProblems(entry.metadata?.hints ?? {}, fields));
  problems.push(...outcomeProblems(entry.metadata?.outcome));
  const checkout: unknown = entry.metadata?.checkout;
  if (checkout !== undefined && !isDeclaredCheckout(checkout)) {
    problems.push(`checkout ${JSON.stringify(checkout)} is not branch or roaming`);
  }
  problems.push(...offerProblems(entry.metadata, entry.id));
  for (const id of repeatedIds(entry.metadata?.path ?? []))
    problems.push(`path lists the Step "${id}" more than once`);
  return problems;
}

function hintProblems(
  hints: Readonly<Record<string, InputStrategy>>,
  fields: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const [field, strategy] of Rec.toEntries(hints)) {
    if (!fields.has(field)) problems.push(`hint for "${field}", which is not an input`);
    if (!KNOWN_STRATEGIES.has(strategy)) {
      problems.push(`input "${field}" has no strategy called "${strategy}"`);
    }
  }
  problems.push(...exclusiveClashes(hints));
  const launch = launchInputProblem([...fields], hints);
  if (launch !== null) problems.push(launch);
  return problems;
}

function outcomeProblems(outcome: OutcomeContract | undefined): ReadonlyArray<string> {
  if (!outcome) return [];
  const problems: string[] = [];
  if (outcome.fixed !== undefined && outcome.selectable !== undefined) {
    problems.push("an outcome is either fixed or selectable, not both");
  }
  if (outcome.fixed !== undefined && !isOutcome(outcome.fixed)) {
    problems.push(`no outcome called "${String(outcome.fixed)}" (${Arr.join(KINDS, ", ")})`);
  }
  if (outcome.selectable !== undefined) {
    if (outcome.selectable.length === 0) problems.push("a selectable outcome offers nothing");
    for (const kind of outcome.selectable) {
      if (!REQUESTABLE.includes(kind))
        problems.push(`"${kind}" is not an outcome a human may ask for`);
    }
  }
  return problems;
}

function offerProblems(
  metadata: WorkflowMetadata | undefined,
  workflow: string,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const offer of [...(metadata?.actions ?? []), ...(metadata?.followUps ?? [])]) {
    for (const id of offer.connections ?? []) {
      if (
        !(id in (metadata?.connections?.uses ?? {})) &&
        !(id in (metadata?.connections?.needs ?? {}))
      )
        problems.push(
          `${workflow}: offer "${offer.id}" lists Connection "${id}", which its workflow does not declare`,
        );
    }
    if (!IDENTITY.test(offer.id)) problems.push(`"${offer.id}" is not an identity for an offer`);
    if (seen.has(offer.id)) problems.push(`two offers are called "${offer.id}"`);
    seen.add(offer.id);
    if (Str.trim(offer.title) === "") problems.push(`offer "${offer.id}" has no title`);
    if (!IDENTITY.test(offer.workflow)) {
      problems.push(`offer "${offer.id}" starts "${offer.workflow}", which is not a workflow id`);
    }
  }
  return problems;
}

/**
 * What a module declares, as data a card or a listing can carry: ids, titles and the
 * projection of each action's argument schema. The eligibility closures and the schema
 * values themselves stay here — presentation travels, behaviour does not.
 */
export function describeMetadata(metadata: WorkflowMetadata | undefined): Schema.Json {
  const described = {
    hints: { ...metadata?.hints },
    outcome: metadata?.outcome?.fixed ?? null,
    selectable: [...(metadata?.outcome?.selectable ?? [])],
    checkout: metadata?.checkout ?? null,
    closes: metadata?.closes ?? null,
    path: Arr.map(metadata?.path ?? [], (one) => ({ id: one.id, title: one.title })),
    followUps: Arr.map(metadata?.followUps ?? [], (offer) => ({
      id: offer.id,
      title: offer.title,
      workflow: offer.workflow,
      when: offer.when,
      connections: [...(offer.connections ?? [])],
    })),
    actions: Arr.map(metadata?.actions ?? [], (action) => {
      const projected = jsonSchemaFor(Schema.Struct(action.arguments));
      return {
        id: action.id,
        title: action.title,
        workflow: action.workflow,
        connections: [...(action.connections ?? [])],
        arguments: projected.document,
        // What the drawing does not say. The action is offered either way.
        limits: [...projected.limits],
      };
    }),
  };
  if (metadata?.connections === undefined) return described;
  return {
    ...described,
    connections: {
      needs: { ...metadata.connections.needs },
      uses: { ...metadata.connections.uses },
    },
  };
}

const asJson = flow(Schema.decodeUnknownResult(Schema.Json), Result.getOrThrow);

/**
 * The JSON Schema for a prompt or a discovery listing, and what it does not say.
 *
 * Projection is not validation. A schema may fail to draw at all — `document` is null —
 * and it may draw something that constrains nothing, which is what a `Schema.declare`
 * becomes. Both are reported and neither makes the schema invalid: what is lost is the
 * copy a model is constrained by at its own end, not the contract it is held to here.
 */
export interface Projection {
  /** The drawn document, or null where nothing could be drawn at all. */
  readonly document: Schema.Json | null;
  /** Each place the drawing constrains nothing, which the schema itself still does. */
  readonly limits: ReadonlyArray<string>;
}

export function jsonSchemaFor(schema: Schema.Constraint): Projection {
  try {
    const drawn = SchemaRepresentation.toJsonSchemaDocument(
      withPatterns(SchemaRepresentation.toRepresentation(Schema.toCodecJson(schema).ast)),
    );
    const document = asJson({ ...drawn.schema, $defs: drawn.definitions });
    // Scanned without `$defs`, which is a container of schemas rather than one: empty
    // there means the document needed no definitions, not that it says nothing.
    return { document, limits: unconstrained(asJson({ ...drawn.schema }), "") };
  } catch (cause) {
    return { document: null, limits: [String(cause)] };
  }
}

/**
 * Effect draws a pattern only for a RegExp with the `u` flag, which a JSON Schema pattern
 * implies; any other whose source is known to match the same strings under it is drawn too.
 */
function withPatterns<T>(node: T): T {
  if (isList(node)) {
    // SAFETY: the same list, each element copied with its own type.
    return Arr.map(node, withPatterns) as T;
  }
  if (!isNode(node)) return node;
  const copied = Rec.fromEntries(
    Arr.map(
      Rec.toEntries(node),
      ([key, value]) => [key, key === "annotations" ? value : withPatterns(value)] as const,
    ),
  );
  const annotations = isPatternCheck(node) ? drawn(node) : null;
  // SAFETY: the same node, with at most a pattern check's annotations replaced.
  return (annotations === null ? copied : { ...copied, annotations }) as T;
}

const isList = Schema.is(Schema.Array(Schema.Unknown));
const isNode = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const PatternCheck = Schema.TaggedStruct("Filter", {
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  representation: Schema.Struct({
    id: Schema.Literal("effect/schema/isPattern"),
    payload: Schema.Struct({ source: Schema.String, flags: Schema.String }),
  }),
});
const isPatternCheck = Schema.is(PatternCheck);

function drawn(check: typeof PatternCheck.Type) {
  const { source, flags } = check.representation.payload;
  if (!/^[dg]*$/.test(flags) || !sameUnderUnicode(source)) return null;
  return { ...check.annotations, toJsonSchema: () => ({ pattern: source }) };
}

/**
 * True for printable ASCII that compiles under `u` and has no atom matching a code unit
 * without it and a code point with it, or an escape `u` gives another meaning.
 */
function sameUnderUnicode(source: string) {
  if (!/^[ -~]*$/.test(source)) return false;
  try {
    new RegExp(source, "u");
  } catch {
    return false;
  }
  const atoms = Option.getOrNull(pipe(source, Str.match(/\\.|\[\^|./g))) ?? [];
  return Arr.every(atoms, (atom) => !/^(?:\.|\[\^|\\[DPSWpu])$/.test(atom));
}

/** Where the drawn document says nothing at all, which the schema itself still does. */
function unconstrained(node: Schema.Json, at: string): ReadonlyArray<string> {
  if (Arr.isArray<typeof node>(node)) {
    return Arr.flatMap(node, (item, index) => unconstrained(item, `${at}[${index}]`));
  }
  const object = asObject(node);
  if (Result.isFailure(object)) return [];
  const entries = Rec.toEntries(object.success);
  if (entries.length === 0) return [`${at || "the schema"} projects to nothing`];
  return Arr.flatMap(entries, ([key, value]) => unconstrained(value, at ? `${at}.${key}` : key));
}

const asObject = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json));
