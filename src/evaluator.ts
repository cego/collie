// The one place a model is asked anything, and the shape of everything it may say back.
//
// Collie holds no API key and grows no daemon, so the model is a harness CLI run once,
// with no tools, no inherited configuration, a clock and an output cap. It speaks only in
// closed schemas: there is no free-text channel from the model into anything that acts.
//
// Nothing here executes an action. `evaluate` returns a decoded answer, judgement or
// proposal; `validate` says which of a proposal's actions the target's own authority
// already grants and which need a human. Running them is somebody else's module.

import { Clock, Data, Effect, Schema, Option } from "effect";
import { isArray, isRecord, isString } from "./schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Stream } from "effect";
import type { Authority } from "./intent";

/** Where a claim points. Validated against the Run's own directories before it is stored. */
const RefSchema = Schema.Struct({
  kind: Schema.Literals(["diff", "output", "verification", "plan", "record", "git"]),
  path: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  sha: Schema.optionalKey(Schema.String),
  excerpt: Schema.optionalKey(Schema.String),
});
export type Ref = Schema.Schema.Type<typeof RefSchema>;

export const DriftReportSchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  run: Schema.String,
  intent_version: Schema.Int,
  constraint: Schema.String,
  kind: Schema.Literals(["rule", "semantic"]),
  severity: Schema.Literals(["block", "warn"]),
  evidence: Schema.Array(RefSchema),
  evidence_truncated: Schema.Boolean,
  correction: Schema.optionalKey(Schema.String),
  resolution: Schema.Literals([
    "open",
    "correction_submitted",
    "verified",
    "escalated",
    "superseded",
  ]),
});
export type DriftReport = Schema.Schema.Type<typeof DriftReportSchema>;

export const JudgementSchema = Schema.Struct({ reports: Schema.Array(DriftReportSchema) });
export type Judgement = Schema.Schema.Type<typeof JudgementSchema>;

/**
 * Everything the model may propose, and nothing else. A closed union is the security
 * boundary: there is no action here that is "run this string", so a model that decided to
 * be creative has nowhere to put it.
 */
export const ActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("update_intent"),
    run: Schema.String,
    /** Which amendment this is. `patch` is the goal, the constraint, or its id. */
    change: Schema.Literals(["set-goal", "add-constraint", "remove-constraint"]),
    patch: Schema.String,
    base_version: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("deliver"),
    run: Schema.String,
    agent: Schema.String,
    text: Schema.String,
    mode: Schema.Literals(["boundary", "now", "interrupt"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("hold"),
    run: Schema.String,
    /** When it lifts by itself, ISO or a clock time; absent is held until released. */
    until: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("release"), run: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stop"), run: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("answer"),
    run: Schema.String,
    choiceId: Schema.String,
    answer: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("start"),
    workflow: Schema.String,
    inputs: Schema.Record(Schema.String, Schema.String),
    decisions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /**
     * Which workspace's checkout the Run is for: a workspace id, its label, or the path
     * of the checkout itself — a directory no workspace is open on gets one opened.
     * Absent means the caller's own, which is what a `collie run start` in a repository
     * means. Named, because a launch asked for from the Home would otherwise root in
     * Collie's own namespace directory — a Run about a repository nobody named.
     */
    workspace: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("resume"), run: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("followup"), run: Schema.String, text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("navigate"),
    run: Schema.String,
    agent: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("clear_override"),
    run: Schema.String,
    agent: Schema.String,
  }),
  /**
   * The standing constraints every Run started in one workspace afterwards is held to.
   * Setting the standing *authority* is not here: widening what Runs may do without
   * asking is a grant, and a model that could ask for one would be authorising itself.
   */
  Schema.Struct({
    kind: Schema.Literal("update_defaults"),
    change: Schema.Literals(["add-constraint", "remove-constraint"]),
    /**
     * Whose new Runs this changes. Named rather than inherited, for the reason `start`
     * names one: defaults are filed per workspace, and a confirmation carried out by the
     * board would otherwise write the Home's — a file no Run ever reads.
     */
    workspace: Schema.String,
    /** The constraint in the human's words to add, or the id of the one to remove. */
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("fork_definition"),
    what: Schema.Literals(["workflow", "persona"]),
    name: Schema.String,
    /** What the fork is called. */
    as: Schema.String,
    layer: Schema.optionalKey(Schema.Literals(["user", "project"])),
    mode: Schema.optionalKey(Schema.Literals(["extends", "copy"])),
  }),
  Schema.Struct({ kind: Schema.Literal("home_cleanup") }),
  Schema.Struct({ kind: Schema.Literal("upgrade") }),
  Schema.Struct({ kind: Schema.Literal("ask_human"), question: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("none"), why: Schema.String }),
]);
export type Action = Schema.Schema.Type<typeof ActionSchema>;
export type ActionKind = Action["kind"];

export const ProposalSchema = Schema.Struct({
  interpretation: Schema.String,
  targets: Schema.Array(Schema.Struct({ run: Schema.String })),
  actions: Schema.Array(ActionSchema),
  confidence: Schema.Number,
});
export type Proposal = Schema.Schema.Type<typeof ProposalSchema>;

/**
 * What a new Task's workspace is called: the project or theme it belongs to, and what
 * this piece of work is. Two short strings and nothing else — a name is display data,
 * and there is no field here for the model to say anything that acts.
 */
export const TaskNameSchema = Schema.Struct({
  project: Schema.String,
  title: Schema.String,
});
export type TaskName = Schema.Schema.Type<typeof TaskNameSchema>;

const SCHEMAS = {
  judgement: JudgementSchema,
  proposal: ProposalSchema,
  naming: TaskNameSchema,
} as const;

export type EvaluationKind = keyof typeof SCHEMAS;

/** The JSON Schema handed to `--json-schema`, so the model is constrained at its own end too. */
export function jsonSchemaFor(kind: EvaluationKind): string {
  const document = Schema.toJsonSchemaDocument(SCHEMAS[kind]);
  return encodeJson({ ...document.schema, $defs: document.definitions });
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

export class EvaluatorUnavailable extends Data.TaggedError("EvaluatorUnavailable")<{
  reason: string;
}> {}

/**
 * Every flag SPEC §7.6 relies on. Checked against the installed `--help` before a call,
 * because each one is load-bearing: without `--tools ""` the model has tools, without
 * `--setting-sources ""` it inherits the human's hooks and MCP servers, without
 * A missing flag refuses the call. No spending flag is among them: what a call costs is
 * recorded, never capped — the user's decision is that usage is data, not a restriction.
 */
export const REQUIRED_FLAGS = [
  "--print",
  "--output-format",
  "--json-schema",
  "--tools",
  "--restricted",
  "--strict-mcp-config",
  "--setting-sources",
  "--no-session-persistence",
  "--append-system-prompt-file",
] as const;

export interface CallLimits {
  readonly maxSeconds: number;
  readonly maxOutputBytes: number;
  readonly model: string;
  readonly effort: string;
}

/**
 * The argv one evaluation runs as. Exported and pure so a test can assert it exactly:
 * this list is the whole of the isolation, and a flag quietly dropped from it would not
 * change any behaviour a test could otherwise see.
 */
export function argvFor(
  limits: CallLimits,
  /** The JSON Schema itself: the CLI takes the text, not a path to it. */
  schema: string,
  systemPromptFile: string,
): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--model",
    limits.model,
    "--effort",
    limits.effort,
    "--append-system-prompt-file",
    systemPromptFile,
  ];
}

/**
 * The structured result, found by what validates rather than by a field name. The CLI's
 * envelope is its own shape and may rename its fields between releases; what cannot
 * change is that the payload is the thing that satisfies the closed schema we demanded.
 * So every candidate in the envelope is tried against that schema, and the one that
 * decodes is the answer.
 */
export function structuredFrom<A, I>(
  raw: string,
  /** The closed schema the model was given, which is what says which node is the payload. */
  schema: Schema.Codec<A, I, never>,
): A | { readonly error: string } {
  const decode = Schema.decodeUnknownOption(schema);
  const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
  const envelope = parse(raw);
  if (envelope._tag === "None") return { error: "the CLI did not print JSON" };

  const seen: unknown[] = [];
  const queue: unknown[] = [envelope.value];
  while (queue.length > 0) {
    const node = queue.shift();
    if (seen.includes(node)) continue;
    seen.push(node);
    const direct = decode(node);
    if (direct._tag === "Some") return direct.value;
    if (isString(node)) {
      const nested = parse(node);
      if (nested._tag === "Some") queue.push(nested.value);
      continue;
    }
    if (isArray(node)) queue.push(...node);
    else if (isRecord(node)) queue.push(...Object.values(node));
  }
  return { error: "nothing in the CLI's envelope matched the schema it was given" };
}

export interface EvaluatorDeps {
  /** `claude --help`, however the caller gets it; checked for every required flag. */
  readonly help: Effect.Effect<string>;
  /** Where the frozen system prompt lives. Repo content, never anything an agent wrote. */
  readonly systemPromptFile: string;
  readonly limits: CallLimits;
}

/** Whether the installed CLI still takes every flag the isolation depends on. */
/**
 * The required flags this `--help` does not name. A flag is named either as its own row
 * or folded into a neighbour's — claude 2.1.268 lists `--append-system-prompt[-file]` and
 * takes both spellings — so a bracketed suffix is read as naming both.
 */
export function missingFlags(help: string): string[] {
  const named = help.replace(/(--[a-z-]+)\[(-[a-z-]+)\]/g, "$1 $1$2");
  return REQUIRED_FLAGS.filter((flag) => !named.includes(flag));
}

export const flagsPresent = Effect.fn("Evaluator.flagsPresent")(function* (deps: EvaluatorDeps) {
  return missingFlags(yield* deps.help);
});

export interface Outcome {
  readonly outcome: "ok" | "failed" | "timeout" | "over_output";
  readonly seconds: number;
  readonly bytes: number;
  readonly stdout: string;
}

/** What a failing call is allowed to say about itself. Enough to diagnose, not a transcript. */
const STDERR_TAIL_BYTES = 4 * 1024;

/** What has arrived on a stream so far, and what it has weighed — kept only under a cap. */
interface Captured {
  readonly text: string;
  readonly bytes: number;
}

/** Fold a child's output under a byte cap, counting everything and keeping what fits. */
const capped = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, cap: number) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      (): Captured => ({ text: "", bytes: 0 }),
      (all: Captured, chunk: string) => {
        const bytes = all.bytes + Buffer.byteLength(chunk, "utf8");
        return { text: bytes > cap ? all.text : all.text + chunk, bytes };
      },
    ),
  );

/**
 * One call: no tools, no inherited settings, a wall clock and an output cap.
 * The pack goes in on stdin as data, never as instructions — the system prompt says so,
 * and the schema is what the answer has to fit.
 *
 * The caller reserves and settles the budget around this; that is deliberately not done
 * here, because a broker that both spent and accounted for the money would be the only
 * witness to its own spending.
 */
export const call = Effect.fn("Evaluator.call")(function* (
  deps: EvaluatorDeps,
  kind: EvaluationKind,
  pack: string,
) {
  const missing = yield* flagsPresent(deps);
  if (missing.length > 0)
    return yield* new EvaluatorUnavailable({
      reason: `the installed claude does not take ${missing.join(", ")}`,
    });

  const argv = argvFor(deps.limits, jsonSchemaFor(kind), deps.systemPromptFile);
  const started = yield* Clock.currentTimeMillis;
  const ran = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("claude", argv, {
        // The pack goes in as one stream on stdin: it is data about someone else's work,
        // and putting it on the command line would make it argv a shell could see.
        stdin: Stream.make(new TextEncoder().encode(pack)),
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
      }),
    );
    // Both streams, concurrently: a child whose stderr nobody reads blocks on a full pipe
    // and becomes a timeout. Counted as they arrive, because a cap that only classifies
    // what has already been allocated is not a cap on anything.
    const [read, failed, exit] = yield* Effect.all(
      [
        capped(handle.stdout, deps.limits.maxOutputBytes),
        capped(handle.stderr, STDERR_TAIL_BYTES),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { read, stderr: failed.text.slice(-STDERR_TAIL_BYTES), code: Number(exit) };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(deps.limits.maxSeconds * 1000),
    Effect.catch(() => Effect.succeed(undefined)),
  );

  const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
  if (ran === undefined || ran._tag === "None")
    return { outcome: "timeout" as const, seconds, bytes: 0, stdout: "", stderr: "" };
  const { read, stderr, code } = ran.value;
  if (read.bytes > deps.limits.maxOutputBytes)
    return { outcome: "over_output" as const, seconds, bytes: read.bytes, stdout: "", stderr };
  return {
    outcome: code === 0 ? ("ok" as const) : ("failed" as const),
    seconds,
    bytes: read.bytes,
    stdout: read.text,
    stderr,
    usd: costOf(read.text),
  };
});

/**
 * What the CLI said the call cost, where it said: the envelope's own `total_cost_usd`.
 * Telemetry, written beside the call's record for a human to see; nothing reads it back
 * to decide anything.
 */
const CostEnvelope = Schema.Struct({ total_cost_usd: Schema.Number });
const costOf = (stdout: string): number | undefined =>
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(stdout).pipe(
    Option.flatMap((json) => Schema.decodeUnknownOption(CostEnvelope)(json)),
    Option.map((envelope) => envelope.total_cost_usd),
    Option.getOrUndefined,
  );

/**
 * What a call produced, decoded, or why there is nothing. A decode failure is
 * `evaluator_invalid_output` and yields no action at all: a model that answered outside
 * its schema has said nothing Collie is willing to act on.
 */
export const evaluate = Effect.fn("Evaluator.evaluate")(function* (
  deps: EvaluatorDeps,
  kind: EvaluationKind,
  pack: string,
) {
  const ran = yield* call(deps, kind, pack);
  // The child's own words about why, where it said any: `failed` on its own is a fact
  // about an exit code and nothing a human can act on.
  if (ran.outcome !== "ok")
    return {
      spent: ran,
      value: null,
      error: ran.stderr === "" ? ran.outcome : `${ran.outcome}: ${ran.stderr.trim()}`,
    };
  // Per kind rather than from `SCHEMAS`: inference over that union picks one member's
  // type, and callers narrow the union of both.
  const decoded =
    kind === "judgement"
      ? structuredFrom(ran.stdout, JudgementSchema)
      : kind === "naming"
        ? structuredFrom(ran.stdout, TaskNameSchema)
        : structuredFrom(ran.stdout, ProposalSchema);
  if ("error" in decoded)
    return { spent: ran, value: null, error: `evaluator_invalid_output: ${decoded.error}` };
  return { spent: ran, value: decoded, error: null };
});

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

export interface ValidationContext {
  /** Runs the model was shown. An action about anything else is about nothing. */
  readonly runs: ReadonlySet<string>;
  /** Agents the model was shown, by run. */
  readonly agents: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each target's current Intent version and authority. */
  readonly intents: ReadonlyMap<
    string,
    { readonly version: number; readonly authority: Authority }
  >;
  /**
   * Where the proposal came from. A Driver's own drift check may act inside what the Run
   * granted; anything a human's steer produced waits for that human, whatever was granted.
   */
  readonly origin: "driver" | "steer";
  readonly maxDeliveryBytes: number;
}

export interface Validated {
  readonly action: Action;
  readonly state: "allowed_now" | "pending";
}

/**
 * Whether the Run's own authority already grants Collie this action. Only ever consulted
 * for a Driver's drift check: a proposal that came out of a conversation with a human
 * goes back to that human, because the grant was for correcting drift, not for doing
 * whatever the conversation turned up.
 */
function granted(action: Action, authority: Authority): boolean {
  switch (action.kind) {
    case "deliver":
      if (!authority.auto_correct) return false;
      if (action.mode === "now") return authority.now_allowed;
      if (action.mode === "interrupt") return authority.interrupt_allowed;
      return true;
    case "stop":
      return authority.stop_allowed;
    default:
      // Everything else — an amended Intent, a new Run, a resumed one, an answered
      // Choice, a cleared override — is a decision, and decisions are the human's.
      return false;
  }
}

function runOf(action: Action): string | null {
  return "run" in action ? action.run : null;
}

/**
 * Every action, with what it is allowed to do. An action about something the model was
 * not shown becomes `ask_human` carrying the reason rather than being dropped: the human
 * asked a question, and "I proposed something about a Run that does not exist" is an
 * answer they need to see.
 */
export function validate(proposal: Proposal, ctx: ValidationContext): Validated[] {
  return proposal.actions.map((action) => {
    const refused = refusalFor(action, ctx);
    if (refused !== null)
      return {
        action: { kind: "ask_human" as const, question: refused },
        state: "pending" as const,
      };
    const run = runOf(action);
    const intent = run === null ? undefined : ctx.intents.get(run);
    const allowed =
      ctx.origin === "driver" && intent !== undefined && granted(action, intent.authority);
    return { action, state: allowed ? ("allowed_now" as const) : ("pending" as const) };
  });
}

function refusalFor(action: Action, ctx: ValidationContext): string | null {
  const run = runOf(action);
  if (run !== null && !ctx.runs.has(run))
    return `I proposed ${action.kind} for run "${run}", which was not among the runs I was shown.`;
  if (action.kind === "deliver") {
    if (!ctx.agents.get(action.run)?.has(action.agent))
      return `I proposed a message for agent "${action.agent}", which is not one of run ${action.run}'s.`;
    if (Buffer.byteLength(action.text, "utf8") > ctx.maxDeliveryBytes)
      return `The message I wrote for ${action.agent} is over the ${ctx.maxDeliveryBytes}-byte limit.`;
  }
  if (action.kind === "update_intent") {
    const current = ctx.intents.get(action.run)?.version;
    if (current !== undefined && current !== action.base_version)
      return `I wrote an Intent change against v${action.base_version} of run ${action.run}, which is now v${current}.`;
  }
  return null;
}
