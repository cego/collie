// What an author imports when they write a workflow: `collie/native`.
//
// A workflow module is ordinary TypeScript. This file is the whole of what Collie adds to
// it — the payload envelope, the error contract, the metadata a card and a launch read,
// and the schemas the shipped steps already write. Everything else an author reaches for
// is Effect's: `Activity`, `DurableDeferred`, a Layer of their own, any operator at all.
//
// Two rules this file exists to keep. **Metadata is data, not control flow**: a hint, an
// outcome and an action say what a workflow is, and nothing here decides what it does.
// And **a conflict is refused before anything starts**: `checkEntry` runs at load, so a
// module that contradicts itself never reaches a Run, a worktree or an agent.
//
// `docs/sdk.md` is the guidance; `docs/adr/0014-native-workflows-run-on-effects-own-engine.md`
// is why the engine underneath is Effect's.

import { Context, Effect, Layer, Schema } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as Workflow from "effect/unstable/workflow/Workflow";
import { INPUT_STRATEGIES, type InputStrategy } from "./definitions";
import { exclusiveClashes } from "./strategies";
import { KINDS, REQUESTABLE, isOutcome, type Outcome } from "./outcome";

export { EXCLUSIVE_STRATEGIES } from "./strategies";

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

/** What the host lends a workflow module; ticket 01's proof host provides it. */
export interface NativeHostApi {
  readonly dir: string;
  readonly held: (runId: string) => Effect.Effect<boolean>;
  readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
  readonly record: (runId: string, event: string) => Effect.Effect<void>;
}

export class NativeHost extends Context.Service<NativeHost, NativeHostApi>()("collie/NativeHost") {}

/** A decision a run waits on. Answered with text, which is what an operator types. */
export const decision = (name: string) => DurableDeferred.make(name, { success: Schema.String });
export type NativeDecision = ReturnType<typeof decision>;

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
  readonly layer: Layer.Layer<never, never, WorkflowEngine | NativeHost>;
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
