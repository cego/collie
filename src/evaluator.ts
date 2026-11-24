// WARNING: the model is a harness CLI run once with no tools or inherited config, and speaks only in closed schemas.
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Data, Effect, FileSystem, Path, Schema, Option, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { budgetPath, reserve, settle, machineHerd } from "./steering";
import { isArray, isRecord, isString } from "./schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Stream } from "effect";
import type { Authority } from "./intent";

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
  batch: Schema.optionalKey(Schema.String),
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

import { ActionSchema, recipientOf } from "./actions";
import type { Action } from "./actions";

export const ProposalSchema = Schema.Struct({
  interpretation: Schema.String,
  targets: Schema.Array(Schema.Struct({ run: Schema.String })),
  actions: Schema.Array(ActionSchema),
  confidence: Schema.Finite,
});
export type Proposal = Schema.Schema.Type<typeof ProposalSchema>;

// WARNING: display data only; no field here lets the model say anything that acts.
export const TaskNameSchema = Schema.Struct({
  project: Schema.String,
  title: Schema.String,
});
export type TaskName = Schema.Schema.Type<typeof TaskNameSchema>;

// WARNING: only paths it was shown may be chosen, so an answer points only where a Run could already go.
export const RouteSchema = Schema.Struct({
  answer: Schema.Literals(["one", "several", "none"]),
  checkouts: Schema.Array(Schema.String),
});
export type Route = Schema.Schema.Type<typeof RouteSchema>;

const SCHEMAS = {
  judgement: JudgementSchema,
  proposal: ProposalSchema,
  naming: TaskNameSchema,
  routing: RouteSchema,
} as const;

export type EvaluationKind = keyof typeof SCHEMAS;

export function jsonSchemaFor(kind: EvaluationKind) {
  const document = Schema.toJsonSchemaDocument(SCHEMAS[kind]);
  return encodeJson({ ...document.schema, $defs: document.definitions });
}

const encodeJson = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 })),
  Result.getOrThrow,
);

export class EvaluatorUnavailable extends Data.TaggedError("EvaluatorUnavailable")<{
  reason: string;
}> {}

// WARNING: each flag is load-bearing for isolation; there is no spending flag, since usage is recorded, never capped.
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

// WARNING: this list is the whole isolation; a dropped flag shows in no test.
export function argvFor(limits: CallLimits, schema: string, systemPromptFile: string) {
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

// WARNING: the payload is found by what validates, since the CLI envelope may rename its fields.
export function structuredFrom<A, I>(raw: string, schema: Schema.Codec<A, I, never>) {
  const decode = Schema.decodeUnknownOption(schema);
  const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
  const envelope = parse(raw);
  if (envelope._tag === "None") {
    return { error: "the CLI did not print JSON" };
  }

  const seen: Array<unknown> = [];
  const queue: Array<unknown> = [envelope.value];
  while (queue.length > 0) {
    const node = queue.shift();
    if (seen.includes(node)) {
      continue;
    }
    seen.push(node);
    const direct = decode(node);
    if (direct._tag === "Some") {
      return direct.value;
    }
    if (isString(node)) {
      const nested = parse(node);
      if (nested._tag === "Some") {
        queue.push(nested.value);
      }
      continue;
    }
    if (isArray(node)) {
      queue.push(...node);
    } else if (isRecord(node)) {
      queue.push(...Rec.values(node));
    }
  }
  return { error: "nothing in the CLI's envelope matched the schema it was given" };
}

export interface EvaluatorDeps {
  readonly help: Effect.Effect<
    string,
    EvaluatorUnavailable,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly systemPromptFile: string;
  readonly limits: CallLimits;
}

// WARNING: a bracketed suffix such as [-file] names both spellings.
export function missingFlags(help: string) {
  const named = pipe_(help, Str.replaceAll(/(--[a-z-]+)\[(-[a-z-]+)\]/g, "$1 $1$2"));
  return Arr.filter(REQUIRED_FLAGS, (flag) => !pipe_(named, Str.includes(flag)));
}

const HELP_TAIL = 500;

export const helpOf = (command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [cmd = "", ...args] = command;
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd, [...args, "--help"], { extendEnv: true }),
    );
    const text = (stream: typeof handle.stdout) => Stream.mkString(Stream.decodeText(stream));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [text(handle.stdout), text(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new EvaluatorUnavailable({
          reason: `${Arr.join(command, " ")} --help did not start: ${String(cause)}`,
        }),
    ),
    Effect.flatMap((ran) => {
      if (ran.exitCode === 0 && Str.trim(ran.stdout) !== "") {
        return Effect.succeed(ran.stdout);
      }
      const said = pipe_(Str.trim(ran.stderr), Str.slice(-HELP_TAIL));
      return Effect.fail(
        new EvaluatorUnavailable({
          reason: `${Arr.join(command, " ")} --help exited ${ran.exitCode}${said === "" ? " and printed nothing" : `: ${said}`}`,
        }),
      );
    }),
  );

export const flagsPresent = Effect.fn("Evaluator.flagsPresent")(function* (deps: EvaluatorDeps) {
  return missingFlags(yield* deps.help);
});

export interface Outcome {
  readonly outcome: "ok" | "failed" | "timeout" | "over_output";
  readonly seconds: number;
  readonly bytes: number;
  readonly stdout: string;
}

const STDERR_TAIL_BYTES = 4 * 1024;

interface Captured {
  readonly text: string;
  readonly bytes: number;
}

const capped = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, cap: number) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => ({ text: "", bytes: 0 }),
      (all: Captured, chunk: string) => {
        const bytes = all.bytes + Buffer.byteLength(chunk, "utf8");
        return { text: bytes > cap ? all.text : all.text + chunk, bytes };
      },
    ),
  );

// WARNING: the caller reserves and settles the budget around this, never here.
export const call = Effect.fn("Evaluator.call")(function* (
  deps: EvaluatorDeps,
  kind: EvaluationKind,
  pack: string,
) {
  const missing = yield* flagsPresent(deps);
  if (missing.length > 0) {
    return yield* new EvaluatorUnavailable({
      reason: `the installed claude does not take ${Arr.join(missing, ", ")}`,
    });
  }

  const argv = argvFor(deps.limits, jsonSchemaFor(kind), deps.systemPromptFile);
  const started = yield* Clock.currentTimeMillis;
  const ran = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("claude", argv, {
        // WARNING: the pack goes on stdin, since argv is visible to other processes.
        stdin: Stream.make(new TextEncoder().encode(pack)),
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
      }),
    );
    // WARNING: both streams are read concurrently, or a full stderr pipe stalls the child into a timeout.
    const [read, failed, exit] = yield* Effect.all(
      [
        capped(handle.stdout, deps.limits.maxOutputBytes),
        capped(handle.stderr, STDERR_TAIL_BYTES),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { read, stderr: pipe_(failed.text, Str.slice(-STDERR_TAIL_BYTES)), code: Number(exit) };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(deps.limits.maxSeconds * 1000),
    Effect.catch(() => Effect.void),
  );

  const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
  if (ran === undefined || ran._tag === "None") {
    return { outcome: "timeout" as const, seconds, bytes: 0, stdout: "", stderr: "" };
  }
  const { read, stderr, code } = ran.value;
  if (read.bytes > deps.limits.maxOutputBytes) {
    return { outcome: "over_output" as const, seconds, bytes: read.bytes, stdout: "", stderr };
  }
  return {
    outcome: code === 0 ? ("ok" as const) : ("failed" as const),
    seconds,
    bytes: read.bytes,
    stdout: read.text,
    stderr,
    usd: costOf(read.text),
  };
});

// WARNING: telemetry only; nothing may decide from the cost.
const CostEnvelope = Schema.Struct({ total_cost_usd: Schema.Finite });
const costOf = (stdout: string) =>
  Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(stdout).pipe(
    Option.flatMap((json) => Schema.decodeUnknownOption(CostEnvelope)(json)),
    Option.map((envelope) => envelope.total_cost_usd),
    Option.getOrUndefined,
  );

// WARNING: an answer outside its schema yields no action at all.
export const evaluate = Effect.fn("Evaluator.evaluate")(function* (
  deps: EvaluatorDeps,
  kind: EvaluationKind,
  pack: string,
) {
  const ran = yield* call(deps, kind, pack);
  if (ran.outcome !== "ok") {
    return {
      spent: ran,
      value: null,
      error: ran.stderr === "" ? ran.outcome : `${ran.outcome}: ${Str.trim(ran.stderr)}`,
    };
  }
  // WARNING: per kind, since inference over the union picks one member's type.
  const decoded =
    kind === "judgement"
      ? structuredFrom(ran.stdout, JudgementSchema)
      : kind === "naming"
        ? structuredFrom(ran.stdout, TaskNameSchema)
        : kind === "routing"
          ? structuredFrom(ran.stdout, RouteSchema)
          : structuredFrom(ran.stdout, ProposalSchema);
  if ("error" in decoded) {
    return { spent: ran, value: null, error: `evaluator_invalid_output: ${decoded.error}` };
  }
  return { spent: ran, value: decoded, error: null };
});

export interface ValidationContext {
  readonly runs: ReadonlySet<string>;
  readonly agents: ReadonlyMap<string, ReadonlySet<string>>;
  readonly intents: ReadonlyMap<
    string,
    { readonly version: number; readonly authority: Authority }
  >;
  readonly origin: "driver" | "steer";
  readonly maxDeliveryBytes: number;
}

export interface Validated {
  readonly action: Action;
  readonly state: "allowed_now" | "pending";
}

// WARNING: only a Driver's drift check may act on the grant; a steer's proposal goes back to its human.
function granted(action: Action, authority: Authority) {
  switch (action.kind) {
    case "deliver":
      if (!authority.auto_correct) {
        return false;
      }
      if (action.mode === "now") {
        return authority.now_allowed;
      }
      if (action.mode === "interrupt") {
        return authority.interrupt_allowed;
      }
      return true;
    case "stop":
      return authority.stop_allowed;
    default:
      return false;
  }
}

function runOf(action: Action) {
  return "run" in action ? action.run : null;
}

// WARNING: an action about a Run not shown becomes ask_human, not dropped.
export function validate(proposal: Proposal, ctx: ValidationContext) {
  return Arr.map(proposal.actions, (action) => {
    const refused = refusalFor(action, ctx);
    if (refused !== null) {
      return {
        action: { kind: "ask_human" as const, question: refused },
        state: "pending" as const,
      };
    }
    const run = runOf(action);
    const intent = run === null ? undefined : ctx.intents.get(run);
    const allowed =
      ctx.origin === "driver" && intent !== undefined && granted(action, intent.authority);
    return { action, state: allowed ? ("allowed_now" as const) : ("pending" as const) };
  });
}

function refusalFor(action: Action, ctx: ValidationContext) {
  const run = runOf(action);
  if (run !== null && !ctx.runs.has(run)) {
    return `I proposed ${action.kind} for run "${run}", which was not among the runs I was shown.`;
  }
  if (action.kind === "deliver") {
    const agent = action.agent;
    if (agent !== undefined && !ctx.agents.get(action.run)?.has(agent)) {
      return `I proposed a message for agent "${agent}", which is not one of run ${action.run}'s.`;
    }
    if (Buffer.byteLength(action.text, "utf8") > ctx.maxDeliveryBytes) {
      return `The message I wrote for ${recipientOf(action)} is over the ${ctx.maxDeliveryBytes}-byte limit.`;
    }
  }
  if (action.kind === "update_intent") {
    const current = ctx.intents.get(action.run)?.version;
    if (current !== undefined && current !== action.base_version) {
      return `I wrote an Intent change against v${action.base_version} of run ${action.run}, which is now v${current}.`;
    }
  }
  return null;
}

export const evaluationDeps = Effect.fn("Evaluator.evaluationDeps")(function* (env: {
  readonly pluginRoot: string;
  readonly herdKey: string;
}) {
  const path = yield* Path.Path;
  const limits = {
    maxSeconds: 120,
    maxOutputBytes: 256 * 1024,
    model: "sonnet",
    effort: "medium",
  };
  return {
    herdKey: env.herdKey,
    evaluator: {
      help: helpOf(["claude"]),
      systemPromptFile: path.join(env.pluginRoot, "prompts", "steward.md"),
      limits,
    },
    limits,
  };
});

export interface BudgetedDeps {
  readonly evaluator: EvaluatorDeps;
  readonly budget: string;
}

// WARNING: without its prompt the data shown is no longer data, so no call is made.
export const budgetedDeps = Effect.fn("Evaluator.budgetedDeps")(function* (
  env: {
    readonly userDir: string;
    readonly raw: Readonly<Record<string, string | undefined>>;
    readonly pluginRoot: string;
    readonly stateDir: string;
  },
  prompt: string,
  limits: Partial<CallLimits>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (herd === null) {
    return null;
  }
  const systemPromptFile = path.join(env.pluginRoot, "prompts", prompt);
  if (!(yield* fs.exists(systemPromptFile).pipe(Effect.orElseSucceed(() => false)))) {
    return null;
  }
  const evaluation = yield* evaluationDeps({ pluginRoot: env.pluginRoot, herdKey: herd });
  return {
    evaluator: {
      ...evaluation.evaluator,
      systemPromptFile,
      limits: { ...evaluation.limits, ...limits },
    },
    budget: yield* budgetPath(env.stateDir, herd),
  } satisfies BudgetedDeps;
});

export const askOnce = Effect.fn("Evaluator.askOnce")(function* (
  deps: BudgetedDeps,
  kind: EvaluationKind,
  pack: string,
) {
  const asked = yield* Effect.result(
    Effect.gen(function* () {
      const callId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
      yield* reserve(deps.budget, { id: callId, run: null }, deps.evaluator.limits);
      const answer = yield* evaluate(deps.evaluator, kind, pack);
      yield* settle(deps.budget, callId, {
        outcome:
          answer.spent.outcome === "ok" && answer.error !== null ? "failed" : answer.spent.outcome,
        usd: answer.spent.usd,
        seconds: answer.spent.seconds,
        bytes: answer.spent.bytes,
      });
      return answer.value;
    }),
  );
  return asked._tag === "Failure" ? null : asked.success;
});
