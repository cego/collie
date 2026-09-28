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

import { Context, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import type { CheckEvidence } from "./output";
import type { Verification } from "./verify";
import type { VerifySpec } from "./verify-spec";
import { WorkflowInstance, type WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as Workflow from "effect/unstable/workflow/Workflow";
import type { Agents } from "./agents";
import { bodySections, INPUT_STRATEGIES, type InputStrategy } from "./definitions";
import { exclusiveClashes } from "./strategies";
import { expressionsIn, malformedIn } from "./template";
import {
  KINDS,
  REQUESTABLE,
  evidenceGaps,
  isOutcome,
  needsApproved,
  nothingApproved,
  refInside,
  type Outcome,
} from "./outcome";
import type { Source } from "./offers";

export { EXCLUSIVE_STRATEGIES } from "./strategies";

/** Where an offer's input comes from, as the Run it is offered about knows it. */
export { SOURCES, SOURCE_NAMES, isSource, type Source } from "./offers";

/**
 * What a review is about its target: which kind of change it names, and the glab
 * arguments that point a command at its project from anywhere.
 */
export { parseMrTarget, repoArgs, targetKind, type MrRef } from "./mr";

export {
  CheckSchema,
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
  blockingKeys,
  findingKey,
  formatFindings,
  isBlocking,
  renderReview,
  settleFinalFix,
  settleRound,
  splitDisputed,
  substantiated,
  unsubstantiated,
  type Check,
  type CheckEvidence,
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
 * the prose a human reads and the findings whatever comes next counts — and `riskLine` is
 * the paragraph an extra axis adds to what a reviewer is asked.
 */
export { FINDINGS_FILE, REVIEW_FILE, leaveReview, openFindingsIn, riskLine } from "./output";

export type { Snapshot, Verification } from "./verify";
export type { VerifySpec } from "./verify-spec";

/** The approved commands as a human would type them, for a prompt to name what it faces. */
export { renderApproved } from "./verify-spec";

/**
 * What kind of result a Run is for, and what the journal says it actually collected —
 * for a merge request to say what was proved rather than what an Output claimed.
 */
export { isOutcome, renderEvidence, type Outcome } from "./outcome";

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
  checksIn,
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
  const undeclared = expressionsIn(text).filter(
    (name) => !(GIVEN.has(name) || declares(fields, name.split("."))),
  );
  const wrong = [...undeclared.map((name) => `{{${name}}}`), ...malformedIn(text)];
  if (wrong.length > 0) {
    throw new Error(
      `this template names ${wrong.join(", ")}, which nothing fills: declare ${wrong.length === 1 ? "it" : "them"} among what it takes, or remove ${wrong.length === 1 ? "it" : "them"}`,
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
        `there is no "## ${section}" section here; there is ${[...sections.keys()].join(", ") || "none"}`,
      );
    }
    return [preamble, body].filter((part) => part !== "").join("\n\n");
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
export function evidenceGapsOf(options: {
  readonly kind: Outcome;
  readonly evidence: CheckEvidence;
  readonly approved: ReadonlyArray<VerifySpec>;
  /** What each piece of work reported, by the name it was done under. */
  readonly outputs: Readonly<Record<string, Schema.Json>>;
  /** Which of those are a reviewer's judgement rather than the implementer's claim. */
  readonly reviewed: ReadonlyArray<string>;
  /** The directories this Run owns, which a reference it gives has to point inside. */
  readonly roots: ReadonlyArray<string>;
  readonly tickets: ReadonlyArray<{
    readonly file: string;
    readonly checks: ReadonlyArray<string>;
  }>;
}): ReadonlyArray<string> {
  return evidenceGaps(options.kind, {
    verifications: options.evidence.verifications,
    final: options.evidence.final,
    approved: options.approved,
    outputs: new Map(Object.entries(options.outputs)),
    reviewed: new Set(options.reviewed),
    insideRun: (ref) => refInside(options.roots, ref),
    tickets: options.tickets,
  });
}

/**
 * A workflow's failure, as every workflow reports one. One shape rather than an
 * author's own union, because what a host does with a failure is show it: a Run that
 * ended badly is a Run, not a value another workflow destructures.
 */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  reason: Schema.String,
}) {}

/** The Run a workflow is executing as: supplied by the host, never passed by hand. */
export interface RunApi {
  readonly id: string;
  /** The public id of the workflow it is a Run of. */
  readonly workflow: string;
}

export class Run extends Context.Service<Run, RunApi>()("collie/Run") {}

/** Which agent does the work: each is inherited from the configuration where it is left out. */
export interface AgentPreferences {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
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
  Array.isArray(seats);

/**
 * The panel this workflow's definition seats for a role: every seat it names, or one that
 * prefers nothing of its own where it names none. Work given a seat sits at it.
 */
export const panelOf = (role: string): Effect.Effect<ReadonlyArray<Seat>> =>
  Effect.gen(function* () {
    const given = (yield* WorkflowAgents)?.roles?.[role];
    const seats = given === undefined ? [] : isPanel(given) ? given : [given];
    return seats.length === 0 ? [{}] : seats;
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
  | Path.Path;

/** What a definition declares about itself beside what it does. None of it is a step. */
export interface Declarations {
  /** Input field to the strategy that infers it. At most one field per exclusive one. */
  readonly hints?: Readonly<Record<string, InputStrategy>>;
  readonly outcome?: OutcomeContract;
  /**
   * What this workflow needs of the repository. `branch` builds on a worktree of its own
   * and `roaming` on a detached one; the host makes it before the Run exists. Absent works
   * in the checkout the Run was started for.
   */
  readonly checkout?: "branch" | "roaming";
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
export interface HostApi {
  readonly dir: string;
  /**
   * This Run as the host admitted it. The checkout is the one it was started for — its
   * own workspace where a caller named one — the directory is this Run's, where a plan, a
   * review and anything else a card reads is looked for, and the options are what the
   * host itself was given beside the author's input.
   */
  readonly place: (runId: string) => Effect.Effect<Place>;
  readonly held: (runId: string) => Effect.Effect<boolean>;
  readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
  readonly record: (runId: string, event: string) => Effect.Effect<void>;
  /**
   * Why this Run has parked its own work and what picks it up again, shown beside its
   * status; null says it no longer has.
   */
  readonly parked: (runId: string, why: string | null) => Effect.Effect<void>;
  /** Records the question this run is waiting on, so the host can say what may answer it. */
  readonly asking: (runId: string, question: DecisionSpec) => Effect.Effect<void>;
  /**
   * What has been verified for this run, and the tree in front of it now. This is what
   * `settleFinalFix` is read against: a check an Output says it ran is a claim, and the
   * journal is what binds a result to the revision it was collected on.
   */
  readonly evidence: (runId: string, cwd: string) => Effect.Effect<CheckEvidence>;
  /**
   * Runs one of the commands this Run was started under the authority of, and records
   * what it did against the tree it ran on. A name nobody approved is refused: the list
   * is a human's, read when the Run started, and a workflow cannot add to it.
   */
  readonly verify: (options: {
    readonly runId: string;
    readonly name: string;
    readonly cwd: string;
    /** What a pass looks like; `fail` is how a reproduction is proved to reproduce. */
    readonly expect?: "pass" | "fail";
  }) => Effect.Effect<Verification, WorkflowError>;
  /**
   * What this Run may have Collie run for it. A prompt names them so an agent knows what
   * its work is going to be held to, and the gate before a merge request reads the same
   * list. A workflow cannot add to it: it is a human's, read when the Run started.
   */
  readonly approved: (runId: string) => Effect.Effect<ReadonlyArray<VerifySpec>>;
  /**
   * One value from the operator's own configuration, by its dotted name, and empty where
   * they have set none. What a shipped workflow must not hard-code — which team files its
   * issues, where its logs are — is asked for here rather than written into its content.
   */
  readonly config: (dotted: string) => Effect.Effect<string>;
  /**
   * Whether a merge request can be opened from this checkout, and what it would carry —
   * the configured assignee, the repository's own template, the issues this branch
   * answers. One question rather than two: a step that cannot reach GitLab has nothing to
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
   * Blocks until this Run holds the shared claim on the repository it works in, and
   * answers null where that repository has none. Waiting here costs wall clock and no
   * model tokens, which is the point of claiming before an agent starts rather than
   * after. `adopting` is asked only where the claim was already the operator's own, so
   * the question is the workflow's — durable, and answered once.
   */
  readonly claim: <E, R>(options: {
    readonly runId: string;
    readonly cwd: string;
    readonly adopting: Effect.Effect<boolean, E, R>;
    readonly say: (line: string) => Effect.Effect<void, E, R>;
  }) => Effect.Effect<{ readonly slug: string } | null, WorkflowError | E, R>;
  /**
   * Gives the claim back. Only a Run that has finished its work releases: holding it
   * across a consultation is what stops anyone deploying on a half-finished change.
   */
  readonly release: (runId: string) => Effect.Effect<void>;
  /**
   * Records the merge request this Run opened. It is a fact about the Run from then on:
   * its card links it, says it waits on it, and follows what the forge says of it.
   */
  readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
  /**
   * Puts a note on the merge request a Run was pointed at, sent by Collie rather than
   * written out again by an agent — asking for a file to be repeated verbatim is how
   * verbatim stops being true. The refusal is the message: a target that is not a merge
   * request, no `glab` for that project, or one assigned to whoever is running this.
   */
  readonly post: (options: {
    readonly runId: string;
    readonly target: string;
    readonly cwd: string;
    /** The file to send, as the Run wrote it. */
    readonly file: string;
  }) => Effect.Effect<Posted>;
}

/** A Run as the host admitted it: where it works, where its work belongs, and what it was given. */
export interface Place {
  readonly cwd: string;
  readonly dir: string;
  /**
   * The host's own launch options for this Run — the `RESERVED_INPUTS` names — as a front
   * door supplied them. They are not in the payload because they are not the author's
   * fields, and this is where a workflow that wants one reads it.
   */
  readonly options: Readonly<Record<string, string>>;
  /** The Task this Run belongs to, whose workspace its agents open in; null for none. */
  readonly task: string | null;
  /** A workspace of the Run's own, where it asked for one; null lives in its Task's. */
  readonly workspace: string | null;
}

/** What opening a merge request from here needs, and what it would be filled in with. */
export interface MrReady {
  readonly ok: boolean;
  /** Why it cannot be done here. Empty where it can. */
  readonly reason: string;
  /** The configured assignee, else whoever glab is logged in as; empty for neither. */
  readonly assignee: string;
  /** The repository's merge request template, relative to the checkout; empty for none. */
  readonly template: string;
  /** The Linear issues this branch answers. */
  readonly issues: ReadonlyArray<string>;
}

/** What became of a note: whether it landed, and the sentence a human reads either way. */
export interface Posted {
  readonly ok: boolean;
  readonly message: string;
}

export class Host extends Context.Service<Host, HostApi>()("collie/Host") {}

/** A question as the host records it: its identity, what it asks, and what it takes. */
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
    yield* host.asking((yield* Run).id, {
      name: question.name,
      prompt: question.prompt ?? question.name,
      options: question.options ?? [],
    });
    return yield* DurableDeferred.await(
      DurableDeferred.make(question.name, { success: Schema.String }),
    );
  });

/**
 * What this Run may have Collie run to prove its kind of result. Where that kind needs
 * the approved set and nothing is approved, the Run parks with the repair instead of
 * spending work no gate could accept; a resume asks again.
 */
export const requireApproved = (
  kind: string,
): Effect.Effect<ReadonlyArray<VerifySpec>, never, Run | Host | WorkflowInstance> =>
  Effect.gen(function* () {
    const runId = (yield* Run).id;
    const host = yield* Host;
    const approved = yield* host.approved(runId);
    if (approved.length > 0 || !needsApproved(isOutcome(kind) ? kind : "unspecified")) {
      yield* host.parked(runId, null);
      return approved;
    }
    yield* host.parked(runId, nothingApproved(runId));
    return yield* Workflow.suspend(yield* WorkflowInstance);
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
    WorkflowEngine | Host | Agents | Children | FileSystem.FileSystem | Path.Path
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
 * What a card, a launch and a follow-up read. None of it is a step: a hint says how an
 * input is inferred, an outcome says what closing needs, an action says what may be
 * started next. A workflow's body never consults any of it.
 */
export interface WorkflowMetadata {
  /** Input field to the strategy that infers it. At most one field per exclusive one. */
  readonly hints?: Readonly<Record<string, InputStrategy>>;
  readonly outcome?: OutcomeContract;
  /**
   * What this workflow needs of the repository. `branch` builds on a worktree of its own
   * and `roaming` on a detached one; the host makes it before the Run exists. Absent works
   * in the checkout the Run was started for.
   */
  readonly checkout?: typeof DeclaredCheckout.Type;
  readonly followUps?: ReadonlyArray<FollowUp>;
  readonly actions?: ReadonlyArray<ActionProvider>;
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
  readonly planIssues: number;
  readonly disposed: boolean;
  /** Findings it left for somebody to fix, which is what a fix is offered over. */
  readonly openFindings: number;
  /** What it was pointed at, where it was pointed at anything. */
  readonly diffTarget: string | null;
  /** The shared claim it still holds, by the project it claimed; null where it holds none. */
  readonly claim: string | null;
}

/**
 * Something a card may offer. The `id` is stable and the `title` is what a human reads —
 * two fields because a retitled action is the same action, and a card that matched on the
 * title would start a different one. `arguments` is the child's schema, not presentation.
 */
export interface ActionProvider {
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
    "Where the checkout comes from: `new` for a worktree workspace of its own, or an existing checkout's absolute path; distinct from the CLI's workspace scope",
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
  id: Schema.String,
  title: Schema.String,
  workflow: Schema.String,
  inputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
};

/** What metadata has to be before any of it can be read: a module is JavaScript by now. */
const DeclaredMetadata = Schema.Struct({
  hints: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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
  if (entry.title.trim() === "") problems.push("title is required");
  const fields = new Set(Object.keys(entry.input));
  for (const [name, field] of Object.entries(entry.input)) {
    if (!Schema.isSchema(field)) problems.push(`input "${name}" is not a schema`);
  }
  for (const name of fields) {
    if (isReserved(name)) {
      problems.push(`input "${name}" collides with a host option: ${reservedMeaning(name)}`);
    }
  }
  const declared = entry.metadata === undefined ? null : readMetadata(entry.metadata);
  if (declared?._tag === "Failure") {
    return [...problems, `metadata is not what a workflow declares: ${declared.failure.message}`];
  }
  problems.push(...hintProblems(entry.metadata?.hints ?? {}, fields));
  problems.push(...outcomeProblems(entry.metadata?.outcome));
  const checkout: unknown = entry.metadata?.checkout;
  if (checkout !== undefined && !isDeclaredCheckout(checkout)) {
    problems.push(`checkout "${String(checkout)}" is not branch or roaming`);
  }
  problems.push(...offerProblems(entry.metadata));
  return problems;
}

function hintProblems(
  hints: Readonly<Record<string, InputStrategy>>,
  fields: ReadonlySet<string>,
): ReadonlyArray<string> {
  const problems: string[] = [];
  for (const [field, strategy] of Object.entries(hints)) {
    if (!fields.has(field)) problems.push(`hint for "${field}", which is not an input`);
    if (!KNOWN_STRATEGIES.has(strategy)) {
      problems.push(`input "${field}" has no strategy called "${strategy}"`);
    }
  }
  problems.push(...exclusiveClashes(hints));
  return problems;
}

function outcomeProblems(outcome: OutcomeContract | undefined): ReadonlyArray<string> {
  if (!outcome) return [];
  const problems: string[] = [];
  if (outcome.fixed !== undefined && outcome.selectable !== undefined) {
    problems.push("an outcome is either fixed or selectable, not both");
  }
  if (outcome.fixed !== undefined && !isOutcome(outcome.fixed)) {
    problems.push(`no outcome called "${String(outcome.fixed)}" (${KINDS.join(", ")})`);
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

function offerProblems(metadata: WorkflowMetadata | undefined): ReadonlyArray<string> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const offer of [...(metadata?.actions ?? []), ...(metadata?.followUps ?? [])]) {
    if (!IDENTITY.test(offer.id)) problems.push(`"${offer.id}" is not an identity for an offer`);
    if (seen.has(offer.id)) problems.push(`two offers are called "${offer.id}"`);
    seen.add(offer.id);
    if (offer.title.trim() === "") problems.push(`offer "${offer.id}" has no title`);
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
  return {
    hints: { ...metadata?.hints },
    outcome: metadata?.outcome?.fixed ?? null,
    selectable: [...(metadata?.outcome?.selectable ?? [])],
    checkout: metadata?.checkout ?? null,
    followUps: (metadata?.followUps ?? []).map((offer) => ({
      id: offer.id,
      title: offer.title,
      workflow: offer.workflow,
      when: offer.when,
    })),
    actions: (metadata?.actions ?? []).map((action) => {
      const projected = jsonSchemaFor(Schema.Struct(action.arguments));
      return {
        id: action.id,
        title: action.title,
        workflow: action.workflow,
        arguments: projected.document,
        // What the drawing does not say. The action is offered either way.
        limits: [...projected.limits],
      };
    }),
  };
}

const asJson = Schema.decodeUnknownSync(Schema.Json);

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
    const drawn = Schema.toJsonSchemaDocument(schema);
    const document = asJson({ ...drawn.schema, $defs: drawn.definitions });
    // Scanned without `$defs`, which is a container of schemas rather than one: empty
    // there means the document needed no definitions, not that it says nothing.
    return { document, limits: unconstrained(asJson({ ...drawn.schema }), "") };
  } catch (cause) {
    return { document: null, limits: [String(cause)] };
  }
}

/** Where the drawn document says nothing at all, which the schema itself still does. */
function unconstrained(node: Schema.Json, at: string): ReadonlyArray<string> {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => unconstrained(item, `${at}[${index}]`));
  }
  if (!isObject(node)) return [];
  const entries = Object.entries(node);
  if (entries.length === 0) return [`${at || "the schema"} projects to nothing`];
  return entries.flatMap(([key, value]) => unconstrained(value, at ? `${at}.${key}` : key));
}

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json));
