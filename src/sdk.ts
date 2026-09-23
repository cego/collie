// What an author imports when they write a workflow: `collie/native`.
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

import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import type { CheckEvidence } from "./output";
import type { Verification } from "./verify";
import type { VerifySpec } from "./verify-spec";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as Workflow from "effect/unstable/workflow/Workflow";
import type { NativeAgents } from "./agents";
import { bodySections, INPUT_STRATEGIES, type InputStrategy } from "./definitions";
import { exclusiveClashes } from "./strategies";
import { KINDS, REQUESTABLE, evidenceGaps, isOutcome, refInside, type Outcome } from "./outcome";
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
 * What a review/fix rally is made of. These are the engine's own functions, not a copy
 * for modules: a workflow that writes its loop in TypeScript converges, stands on a
 * dispute and runs out of rounds exactly where a declared one does.
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
 * A list of work, and the hand-off between its items. The identities are the engine's own
 * rule — an item is known by its name and never by where it sits — so a module that
 * writes its own loop reuses what it has done after a reordering exactly as a declared
 * list does.
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
 * A Markdown file as the content it is: what stands above the first heading, and one
 * entry per `## name` section below it. A module reads the file it ships beside rather
 * than carrying the same prose twice, and what a definition put in front matter is not
 * content — so it is left out rather than rendered at an agent.
 */
export function contentOf(markdown: string): {
  readonly preamble: string;
  readonly sections: ReadonlyMap<string, string>;
} {
  return bodySections(markdown.replace(FRONT_MATTER, ""));
}

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Everything still missing before this Run may say it proved its kind of result, one
 * sentence each. Empty means the evidence is there.
 *
 * The same table a declared workflow's gate is judged by, asked for what a module has:
 * its own Outputs rather than a step record, and the directories it owns rather than a
 * Run record to read them from. A claim in an Output is still only ever a claim — what
 * decides a check is the journal, bound to the tree in front of it.
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
 * A workflow's failure, as every native workflow reports one. One shape rather than an
 * author's own union, because what a host does with a failure is show it: a Run that
 * ended badly is a Run, not a value another workflow destructures.
 */
export class WorkflowError extends Schema.TaggedError<WorkflowError>()("WorkflowError", {
  reason: Schema.String,
}) {}

/**
 * The envelope every native workflow is executed with. The host supplies `runId` and the
 * author supplies `input`, and idempotency is `runId` alone — so a retry of an accepted
 * request is the same execution, and a new start is a new one.
 */
export const payloadOf = <Input extends Schema.Struct.Fields>(input: Input) => ({
  runId: Schema.String,
  input: Schema.Struct(input),
});

/**
 * A native workflow under Collie's envelope. Everything else `Workflow.make` takes is
 * still yours; this only fixes the payload and the error, which the host has to know.
 */
export const defineWorkflow = <
  Input extends Schema.Struct.Fields,
  Success extends Schema.Top,
>(options: {
  readonly name: string;
  readonly input: Input;
  readonly success: Success;
}): Workflow.Workflow<
  string,
  Schema.Struct<{ runId: typeof Schema.String; input: Schema.Struct<Input> }>,
  Success,
  typeof WorkflowError
> =>
  Workflow.make(options.name, {
    payload: payloadOf(options.input),
    idempotencyKey: (payload) => payload.runId,
    success: options.success,
    error: WorkflowError,
  });

/**
 * What the host lends a workflow module; ticket 01's proof host provides it.
 *
 * `held` and `stopRequested` are plain Effects rather than Activities on purpose: an
 * operator sets a control between attempts, and an Activity would hand back the answer
 * from the attempt that first ran.
 */
export interface NativeHostApi {
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
  readonly blocked: (runId: string, why: string | null) => Effect.Effect<void>;
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

export class NativeHost extends Context.Service<NativeHost, NativeHostApi>()("collie/NativeHost") {}

/** A question as the host records it: its identity, what it asks, and what it takes. */
export interface DecisionSpec {
  readonly name: string;
  readonly prompt: string;
  /** The answers it takes. Empty is a question answered in the operator's own words. */
  readonly options: ReadonlyArray<string>;
}

/** A decision a run waits on. Answered with text, which is what an operator types. */
export interface NativeDecision extends DurableDeferred.DurableDeferred<typeof Schema.String> {
  readonly asks: DecisionSpec;
}

export const decision = (
  name: string,
  asks?: { readonly prompt?: string; readonly options?: ReadonlyArray<string> },
): NativeDecision =>
  Object.assign(DurableDeferred.make(name, { success: Schema.String }), {
    asks: { name, prompt: asks?.prompt ?? name, options: asks?.options ?? [] },
  });

/**
 * Waits for this question to be answered, having told the host it is open.
 *
 * Both halves matter. Waiting is Effect's — the answer is durable and a restart comes
 * back to it. Saying so is Collie's: a host that does not know what a run is asking
 * cannot show the question, cannot refuse an answer to one nobody asked, and cannot tell
 * a second answer from the first.
 */
export const ask = (
  runId: string,
  question: NativeDecision,
  /** What it takes this time, where a menu offers less than it declares. */
  options?: ReadonlyArray<string>,
): Effect.Effect<string, never, NativeHost | WorkflowEngine | WorkflowInstance> =>
  Effect.gen(function* () {
    const host = yield* NativeHost;
    yield* host.asking(runId, options ? { ...question.asks, options } : question.asks);
    return yield* DurableDeferred.await(question);
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
  /** The parent's run id: what the child belongs to, and half of its identity. */
  readonly runId: string;
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

export class NativeChildren extends Context.Service<NativeChildren, ChildrenApi>()(
  "collie/NativeChildren",
) {}

/** One child workflow, started and waited on. Anything else is Effect's own operators. */
export const child = (ask: ChildAsk): Effect.Effect<unknown, WorkflowError, NativeChildren> =>
  Effect.gen(function* () {
    const children = yield* NativeChildren;
    return yield* children.result(yield* children.start(ask));
  });

/**
 * A workflow as the host sees one: any input and any result, no service of the host's to
 * encode them, and the one error contract above.
 */
type HostCodec = Schema.Codec<unknown, unknown, never, never>;
interface HostPayload extends Schema.Struct<Schema.Struct.Fields> {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}
export type HostWorkflow = Workflow.Workflow<string, HostPayload, HostCodec, typeof WorkflowError>;

/** What `make(registrationName)` hands back: the workflow, how to register it, its decisions. */
export interface Registration {
  readonly workflow: HostWorkflow;
  /**
   * What the host builds this generation from. The services in it are the ones a host
   * holds already: its own, and the file system and paths a module reads its work from.
   */
  readonly layer: Layer.Layer<
    never,
    never,
    WorkflowEngine | NativeHost | NativeAgents | NativeChildren | FileSystem.FileSystem | Path.Path
  >;
  readonly decisions: Readonly<Record<string, NativeDecision>>;
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
  readonly make: (registrationName: string) => Registration;
}

/**
 * What a card, a launch and a follow-up read. None of it is a step: a hint says how an
 * input is inferred, an outcome says what closing needs, an action says what may be
 * started next. A workflow's body never consults any of it.
 */
export interface WorkflowMetadata {
  /** Input field to the strategy that infers it. At most one field per exclusive one. */
  readonly hints?: Readonly<Record<string, InputStrategy>>;
  readonly outcome?: OutcomeContract;
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
  workspace: "An existing checkout or workspace, distinct from the CLI's workspace scope",
  repo: "One repository's share of a multi-repository work source",
  outcome: "The selectable outcome, where the workflow does not fix one",
  risks: "Additional review axes, passed as declared context",
  previous: "Previous review context attached to the selected work",
} as const;

const IDENTITY = /^[a-z][a-z0-9-]*$/;

/** What a public id may be, so a command that writes one can refuse before the file exists. */
export const isWorkflowId = (id: string): boolean => IDENTITY.test(id);

const isReserved = (name: string): name is keyof typeof RESERVED_INPUTS => name in RESERVED_INPUTS;
const reservedMeaning = (name: string) => (isReserved(name) ? RESERVED_INPUTS[name] : "");
const KNOWN_STRATEGIES: ReadonlySet<string> = new Set(INPUT_STRATEGIES);

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
  for (const [field, value] of [
    ["title", entry.title],
    ["description", entry.description],
  ] as const) {
    if (value.trim() === "") problems.push(`${field} is required`);
  }
  const fields = new Set(Object.keys(entry.input));
  for (const name of fields) {
    if (isReserved(name)) {
      problems.push(`input "${name}" collides with a host option: ${reservedMeaning(name)}`);
    }
  }
  problems.push(...hintProblems(entry.metadata?.hints ?? {}, fields));
  problems.push(...outcomeProblems(entry.metadata?.outcome));
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
  /** Each place the drawing constrains nothing, which the native schema still does. */
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

/** Where the drawn document says nothing at all, which the native schema still does. */
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
