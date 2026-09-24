// An agent a workflow operates, and the Output it is held to.
//
// Three things a workflow must not be left to get right on its own. An agent is launched
// once however often the work replays. What it wrote is decoded before any of it is
// believed. And a file it wrote wrongly buys exactly one more attempt, from the agent that
// is still holding the work rather than a fresh one with none of the context. So an author
// asks for the work — `agentWork` — and the Activities under it are Collie's.
//
// Launching is external, and no Activity makes an external effect exactly once. What
// makes it safe is reconciliation: the agent's name is derived from the run and the
// operation, so a launch that may already have happened is settled by looking rather than
// by starting a second one, and a question nobody can answer blocks the work instead.
//
// `docs/adr/0020-an-agent-is-launched-once-and-its-output-is-decoded.md` is why.

import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import {
  COMPACTION_WAIT_MS,
  atBoundary,
  installControls,
  withControlLock,
  type CompactionDeps,
  type CompactionPorts,
} from "./compaction";
import { COMPACTION_PORTS } from "./compactors";
import { FALLBACK_DEFAULTS, loadDefaults } from "./config";
import * as dispatch from "./dispatcher";
import { layers, skillDirs } from "./definitions";
import { currentEnv, type PluginEnv } from "./env";
import {
  HARNESSES,
  foldPreferences,
  isPermissionMode,
  personaPrefix,
  preferencesIn,
  resolveChoice,
  startArgs,
  type AgentChoice,
  type PermissionMode,
  type Preferences,
} from "./harness";
import { Herdr } from "./herdr";
import { agentName, reason, shellQuote, unsafePathComponent } from "./naming";
import { askRouteTo } from "./handoff";
import { liveAgent, registerAgent, registryPath, scopeFor, verifyIncarnation } from "./registry";
import {
  contentOf,
  jsonSchemaFor,
  AgentScopes,
  Host,
  Run,
  WorkflowAgents,
  WorkflowError,
  type HostApi,
  type Projection,
} from "./sdk";
import { deliveriesOf } from "./steering";
import { readTask, withTaskLock, writeTask } from "./task";
import { renderTemplate, skillMention, skillsIn } from "./template";

/** A schema that decodes an agent's Output without services of the author's own. */
export type OutputContract = Schema.Codec<unknown, unknown, never, never>;

/** One piece of agent work, named so that replaying it finds what it already did. */
export interface AgentAsk {
  readonly runId: string;
  readonly operation: string;
  /** What this agent is being asked to be, stated rather than inferred from a name. */
  readonly role: string;
  /** The agent this work goes to, where several pieces share one. Null gives it its own. */
  readonly agent: string | null;
  readonly workflow: string;
  /** The Run's Task: its agents open in that Task's workspace. Null opens where the host is. */
  readonly task: string | null;
  /** The Run's own workspace, where it asked for one; its agents open there instead. */
  readonly workspace?: string | null;
  readonly cwd: string;
  readonly prompt: string;
  readonly output: string;
  /** A skill this work is started with, invoked the way the human channel invokes one. */
  readonly skill: string | null;
  /** Null takes the host's own configured default, which is the operator's. */
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissions: string | null;
}

/**
 * The agent this work is on. Recorded by the launch Activity, so every later attempt
 * reattaches to this agent rather than starting another.
 */
export const Launched = Schema.Struct({
  agent: Schema.String,
  output: Schema.String,
  /** True where the agent was already there and this launch reconciled onto it. */
  reused: Schema.Boolean,
  /**
   * What a repair needs to reach this same agent about this same work. Kept here because
   * this is the durable record: a host that restarts between the collection and the
   * repair reads the agent and the operation back rather than deriving them again.
   */
  runId: Schema.String,
  operation: Schema.String,
  role: Schema.String,
  workflow: Schema.String,
  harness: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** herdr's id for the process given this work: the name alone is reused by the next one. */
  terminalId: Schema.optionalKey(Schema.String),
});

/** The agent chosen for one piece of work, recorded before anything starts it. */
export const AgentChoiceSchema = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type Launched = typeof Launched.Type;

/**
 * Nobody can say whether this agent exists or whether it was given its work, so nothing
 * was started. Uncertainty is reported; it is never rounded down to "nothing happened".
 */
export class AgentUncertain extends Schema.TaggedError<AgentUncertain>()("AgentUncertain", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

/**
 * The work cannot go on until something outside the Run changes — a pane that will not
 * take its prompt, a workspace and checkout that have both gone — and nothing about it is
 * uncertain. It parks for a resume rather than failing into a fresh agent.
 */
export class AgentParked extends Schema.TaggedError<AgentParked>()("AgentParked", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

/** What a host lends a workflow that needs an agent. */
export interface AgentsApi {
  /** Where this operation's Output goes — known before anything starts, so a prompt can name it. */
  readonly outputFor: (runId: string, operation: string) => string;
  /**
   * Where each of these skills is installed, for the mentions a prompt carries. A name
   * nobody has installed is left out, and the mention says so rather than pointing at a
   * path that is not there.
   */
  readonly skills: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>;
  /**
   * What an agent is told about asking for a decision its work does not cover: the pane
   * of whoever is live in that role, and otherwise to stop and ask the human. A role, not
   * a bare route: who may be asked is the workflow's own declaration.
   */
  readonly askRoute: (role: string, cwd: string) => Effect.Effect<string>;
  /** How often anything here looks again, which a workflow's own watch for a stop shares. */
  readonly pollMs: number;
  /** The agent these preferences come to over the operator's configuration, lowest first. */
  readonly choose: (
    layers: ReadonlyArray<Preferences | undefined>,
  ) => Effect.Effect<AgentChoice, WorkflowError>;
  /** What this Run's agent of that name runs on, where it is running; null where it is not. */
  readonly choiceOf: (runId: string, agent: string) => Effect.Effect<AgentChoice | null>;
  readonly launch: (ask: AgentAsk) => Effect.Effect<Launched, AgentUncertain | AgentParked>;
  /**
   * Starts this work's agent again with its prompt where it is gone and its Output never
   * came; `unless` is an unusable Output that counts as none.
   */
  readonly revive: (
    ask: AgentAsk,
    unless?: string | null,
  ) => Effect.Effect<void, AgentUncertain | AgentParked>;
  /**
   * Hands a message, through the one sender, to another Run's live agent in this role here;
   * null where none. Parked where nobody can say whether it arrived.
   */
  readonly handOff: (options: {
    readonly runId: string;
    readonly role: string;
    readonly cwd: string;
    readonly text: string;
  }) => Effect.Effect<Steered | null, AgentParked>;
  /** Closes the panes of this run's live agents, which stops them; `left` may still be running. */
  readonly halt: (runId: string) => Effect.Effect<Halted>;
  /**
   * What the agent wrote, or null where it has written nothing in the time allowed.
   * `unless` is an Output already known to be unusable: the same text again is the agent
   * not having rewritten the file, which is not an answer to having been asked to.
   */
  readonly collect: (
    launched: Launched,
    unless?: string | null,
  ) => Effect.Effect<string | null, AgentUncertain>;
  /** Hands one unusable Output back to the agent that wrote it. False where it could not be asked. */
  readonly repair: (
    launched: Launched,
    problem: string,
  ) => Effect.Effect<boolean, AgentUncertain | AgentParked>;
  /**
   * Says something of a human's to the agent this run has. The request is the claim on
   * the delivery: the same one twice is one message, which is what the ledger refuses a
   * second copy of.
   */
  readonly steer: (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    /** Which of the run's agents; the newest launch where a caller names none. */
    readonly operation?: string;
    /** One of the run's agents by name, which wins over `operation`. */
    readonly agent?: string;
    readonly mode?: DeliveryMode;
  }) => Effect.Effect<Steered>;
}

export type DeliveryMode = "boundary" | "now" | "interrupt";

/**
 * What became of one delivery. `delivered` is what could be got out of herdr about it and
 * never "it was accepted for sending": a queue taking a message is not the agent having
 * been given it.
 */
export interface Steered {
  readonly agent: string;
  readonly delivered: boolean;
  readonly detail: string;
}

/** What a stop closed, and what may still be running after it. */
export interface Halted {
  readonly stopped: ReadonlyArray<string>;
  readonly left: ReadonlyArray<string>;
}

export class Agents extends Context.Service<Agents, AgentsApi>()("collie/Agents") {}

/** What an author asks for: the work, not the steps it takes. */
export interface AgentWork<Output extends OutputContract> {
  /** Stable within the run: the Activity names and the agent's name are derived from it. */
  readonly operation: string;
  /** Where the agent works; the checkout the host placed the Run on where it is left out. */
  readonly cwd?: string;
  /** The Markdown the agent is given, with `{{inputs.x}}` rendered from the decoded input. */
  readonly instructions: string;
  /**
   * What the Output has to be: the prompt carries its drawing, and this decides. Left out,
   * the agent answers in plain text.
   */
  readonly output?: Output;
  readonly inputs?: Readonly<Record<string, Schema.Json>>;
  readonly role?: string;
  /**
   * The agent this work goes to. Several operations naming one agent are one agent's
   * work in order — a list handed to one implementer, each item its own prompt — and
   * leaving it out gives this operation an agent of its own.
   */
  readonly agent?: string;
  readonly workflow?: string;
  /** The skill this work is started with, where the work is one a skill describes. */
  readonly skill?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissions?: PermissionMode;
  /**
   * What the instructions render beside `inputs` — the round it is in, the review before
   * it, what a human disputed — so Markdown keeps the variable names it was written with.
   */
  readonly vars?: Readonly<Record<string, Schema.Json>>;
}

/**
 * One agent, once, and its Output as a value of the author's own type.
 *
 * Launch and collection are separate Activities on purpose: replaying a collection must
 * never start a second agent, and only a recorded launch makes that true. The repair is a
 * third, which is what stops a restart from handing out another one — a workflow that
 * comes back to an Output it has already had repaired finds the repair recorded and is
 * left with the failure, not with a fresh allowance.
 */
export const agentWork = <Output extends OutputContract = typeof Schema.String>(
  given: AgentWork<Output>,
): Effect.Effect<
  Output["Type"],
  WorkflowError,
  Run | Agents | Host | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const host = yield* Host;
    const run = yield* Run;
    const runId = run.id;
    const place = yield* host.place(runId);
    const plain = given.output === undefined;
    // SAFETY: Output defaults to Schema.String exactly where no output was given.
    const contract = (given.output ?? Schema.String) as Output;
    const work = {
      ...given,
      runId,
      cwd: given.cwd ?? place.cwd,
      workflow: given.workflow ?? run.workflow,
      output: contract,
    };
    // A boundary, and the last one before money is spent: a held run parks here rather
    // than starting an agent. Read as a plain Effect because an operator sets a hold
    // between attempts, and an Activity would hand back what the first attempt saw.
    if (yield* host.held(work.runId)) {
      return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
    }
    // The operation is a name of its own before it is anything else: the Output, the
    // prompt and the recorded launch are all kept under it.
    const unsafe = unsafePathComponent(work.operation);
    if (unsafe !== null) {
      return yield* Effect.fail(
        new WorkflowError({ reason: `operation "${work.operation}" ${unsafe}` }),
      );
    }
    const output = agents.outputFor(work.runId, work.operation);
    const role = work.role ?? work.operation;
    // Where each skill the instructions mention lives, so a mention is the path to read
    // rather than a name the agent has to go looking for.
    const skills = yield* agents.skills(skillsIn(work.instructions));
    // An agent already running on this work's name is the conversation this continues, and
    // a conversation cannot become another agent: what is asked for here has to agree with
    // it, and what only defaults below that does not apply.
    const scopes = yield* AgentScopes;
    const held = work.agent === undefined ? null : yield* agents.choiceOf(runId, work.agent);
    const requested = foldPreferences([...scopes, preferencesIn(given)]);
    if (held !== null && !agrees(held, requested)) {
      return yield* new WorkflowError({
        reason: `${work.operation}: ${work.agent} is already running as ${held.harness}/${held.model}, and this work asks for ${requested.harness ?? held.harness}/${requested.model ?? held.model}. A conversation cannot become another agent: give this work an agent of its own, or ask for the one it is.`,
      });
    }
    // Decided and recorded before anything is started, so a recovery, a revival and a
    // restart all start the agent this work was given, whatever is configured by then.
    const choice = yield* Activity.make({
      name: `${work.operation}.agent`,
      success: AgentChoiceSchema,
      error: WorkflowError,
      execute:
        held === null
          ? agents.choose([
              yield* WorkflowAgents,
              preferencesIn(place.options),
              ...scopes,
              preferencesIn(given),
            ])
          : Effect.succeed(held),
    });
    const ask: AgentAsk = {
      runId: work.runId,
      operation: work.operation,
      role,
      agent: work.agent ?? null,
      workflow: work.workflow ?? work.operation,
      task: place.task,
      workspace: place.workspace,
      cwd: work.cwd,
      output,
      prompt: promptFor({
        role,
        instructions: work.instructions,
        inputs: work.inputs,
        vars: work.vars,
        skills,
        cwd: work.cwd,
        output,
        contract: plain ? null : jsonSchemaFor(work.output),
      }),
      skill: work.skill ?? null,
      harness: choice.harness,
      model: choice.model,
      effort: choice.effort,
      permissions: work.permissions ?? null,
    };

    const launched = yield* Activity.make({
      name: `${work.operation}.launch`,
      success: Launched,
      error: AgentUncertain,
      execute: parkedWhenStuck(agents.launch(ask), host, work.runId),
    });
    const first = yield* Activity.make({
      name: `${work.operation}.collect`,
      success: Schema.NullOr(Schema.String),
      error: AgentUncertain,
      execute: stoppable(
        parkedWhenStuck(agents.revive(ask), host, work.runId).pipe(
          Effect.andThen(agents.collect(launched)),
        ),
        host,
        work.runId,
        agents.pollMs,
      ),
    });
    if (first === null) {
      return yield* unusable(launched, `wrote nothing to ${output}`);
    }
    const read = decodeOutput(work.output, first, plain);
    if (read.ok) return read.value;

    // The repair is its own Activity, so what a restart finds is a repair that happened
    // rather than an allowance that has come back.
    const asked = yield* Activity.make({
      name: `${work.operation}.repair`,
      success: Schema.Boolean,
      error: AgentUncertain,
      execute: parkedWhenStuck(agents.repair(launched, read.problem), host, work.runId),
    });
    const again = !asked
      ? null
      : yield* Activity.make({
          name: `${work.operation}.recollect`,
          success: Schema.NullOr(Schema.String),
          error: AgentUncertain,
          execute: stoppable(
            parkedWhenStuck(agents.revive(ask, first), host, work.runId).pipe(
              Effect.andThen(agents.collect(launched, first)),
            ),
            host,
            work.runId,
            agents.pollMs,
          ),
        });
    if (again === null) {
      return yield* unusable(launched, `did not write ${output} again: ${read.problem}`);
    }
    const repaired = decodeOutput(work.output, again, plain);
    if (repaired.ok) return repaired.value;
    return yield* unusable(launched, `${output} is still unusable: ${repaired.problem}`);
  }).pipe(
    Effect.catchTag("AgentUncertain", (cause) =>
      Effect.fail(
        new WorkflowError({
          reason: `${cause.operation}: ${cause.reason}. Nothing here says the agent did no work.`,
        }),
      ),
    ),
  );

/** Whether what is asked for here is what an agent already running is. */
const agrees = (held: AgentChoice, requested: Preferences) =>
  (requested.harness === undefined || requested.harness === held.harness) &&
  (requested.model === undefined || requested.model === held.model) &&
  (requested.effort === undefined || requested.effort === held.effort);

/**
 * A message handed, as an Activity, to another Run's live agent in this role: the agent it
 * reached, or null where there is none to take it. One nobody can say arrived parks the Run.
 */
export const handOffWork = (given: {
  readonly operation: string;
  readonly role: string;
  /** Where the agent to hand to works; the Run's own checkout where it is left out. */
  readonly cwd?: string;
  readonly text: string;
}): Effect.Effect<
  string | null,
  WorkflowError,
  Run | Agents | Host | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const host = yield* Host;
    const runId = (yield* Run).id;
    const options = { ...given, runId, cwd: given.cwd ?? (yield* host.place(runId)).cwd };
    return yield* Activity.make({
      name: `${options.operation}.handoff`,
      success: Schema.NullOr(Schema.String),
      error: AgentUncertain,
      execute: parkedWhenStuck(
        agents
          .handOff(options)
          .pipe(Effect.map((sent) => (sent?.delivered === true ? sent.agent : null))),
        host,
        runId,
      ),
    });
  }).pipe(
    Effect.catchTag("AgentUncertain", (cause) =>
      Effect.fail(new WorkflowError({ reason: `${cause.operation}: ${cause.reason}` })),
    ),
  );

/**
 * Work that cannot go on yet, parked rather than failed. The Activity is left unfinished,
 * so a resume runs it again: the launch finds the agent it started, or its workspace
 * again, and the same delivery goes out.
 */
const parkedWhenStuck = <A>(
  sending: Effect.Effect<A, AgentUncertain | AgentParked>,
  host: HostApi,
  runId: string,
): Effect.Effect<A, AgentUncertain, WorkflowEngine.WorkflowInstance> =>
  sending.pipe(
    Effect.tap(() => host.parked(runId, null)),
    Effect.catchTag("AgentParked", (parked) =>
      Effect.gen(function* () {
        yield* host.parked(runId, parked.reason);
        return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
      }),
    ),
  );

/**
 * A collection an operator can stop while it is out, and resume back into.
 *
 * The suspension is the wait's own instance, never the workflow's: suspending the run
 * from in here would abandon the collection rather than park it, and the next attempt
 * would have nothing to re-enter. The launch is a separate Activity and is already
 * recorded, so what comes back reattaches instead of starting a second agent.
 */
const stoppable = <A, E>(
  collecting: Effect.Effect<A, E, WorkflowEngine.WorkflowInstance>,
  host: HostApi,
  runId: string,
  pollMs: number,
): Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance> =>
  Effect.gen(function* () {
    const wait = yield* WorkflowEngine.WorkflowInstance;
    const raced = yield* Effect.race(
      collecting.pipe(Effect.map((value) => ({ collected: true as const, value }))),
      untilStopped(host, runId, pollMs).pipe(Effect.as({ collected: false as const })),
    );
    if (!raced.collected) return yield* Workflow.suspend(wait);
    return raced.value;
  });

/** Waits for an operator to stop this run, and for nothing else. */
const untilStopped = (host: HostApi, runId: string, pollMs: number) =>
  host.stopRequested(runId).pipe(
    Effect.flatMap((stop) => (stop ? Effect.void : Effect.fail(new Error("not stopped")))),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(pollMs)) }),
    Effect.orDie,
  );

const unusable = (launched: Launched, what: string) =>
  Effect.fail(new WorkflowError({ reason: `output-unusable: ${launched.agent} ${what}` }));

/** What an Output decoded to, or every reason it could not be used. */
type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const asJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));

/**
 * The agent's file as the author's own type. Every issue at once, because an agent fixing
 * them one round trip at a time is the repair being spent on arithmetic.
 */
export function decodeOutput<Output extends OutputContract>(
  contract: Output,
  text: string,
  /** Read the file as the text it is rather than as JSON. */
  plain = false,
): Read<Output["Type"]> {
  if (plain) {
    const decoded = Schema.decodeUnknownResult(contract)(text.trim());
    return decoded._tag === "Success"
      ? { ok: true, value: decoded.success }
      : { ok: false, problem: decoded.failure.message };
  }
  const parsed = asJson(text);
  if (parsed._tag === "Failure") {
    return { ok: false, problem: `it is not JSON: ${parsed.failure.message}` };
  }
  const decoded = Schema.decodeUnknownResult(contract, { errors: "all" })(parsed.success);
  return decoded._tag === "Success"
    ? { ok: true, value: decoded.success }
    : { ok: false, problem: decoded.failure.message };
}

/** Everything a prompt is built from, none of which is an Activity. */
export interface PromptParts {
  readonly role: string;
  readonly instructions: string;
  readonly output: string;
  /** What the Output is drawn to; null asks for plain text. */
  readonly contract: Projection | null;
  readonly inputs?: Readonly<Record<string, Schema.Json>>;
  /** What the instructions render beside `inputs`, as the module supplies them. */
  readonly vars?: Readonly<Record<string, Schema.Json>>;
  /** Where each mentioned skill is installed; a mention of one that is not says so. */
  readonly skills?: ReadonlyMap<string, string>;
  readonly cwd?: string;
}

/**
 * What the agent is asked to do, where the answer goes, and what the answer has to be.
 * Pure, so a test and an author can read one without starting anything, and so a replay
 * never builds a different one. The role is the persona, injected at launch, and
 * reaches a body here as `{{role}}`.
 */
export function promptFor(parts: PromptParts): string {
  const rendered = renderTemplate(
    parts.instructions,
    {
      ...parts.vars,
      inputs: { ...parts.inputs },
      role: parts.role,
      cwd: parts.cwd ?? "",
      output_path: parts.output,
    },
    { skill: skillMention(parts.skills ?? new Map()) },
  );
  return [
    rendered.text.trim(),
    `When you are done, write your result ${parts.contract === null ? "as plain text" : "as JSON"} to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${parts.output}`,
    parts.contract === null ? "" : contractSection(parts.contract),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * What the Output has to be, drawn from the schema that will decode it. The descriptions
 * are the author's own words about each field, and they are the judgment the agent is
 * being asked for — so they travel with the drawing rather than being summarised away.
 */
function contractSection(contract: Projection): string {
  const limits =
    contract.limits.length === 0
      ? ""
      : `\n\nThe drawing says less than the contract does at: ${contract.limits.join("; ")}. Those are still checked.`;
  if (contract.document === null) {
    return `That file is checked against a schema this build cannot draw${limits || "."}`;
  }
  return `That file must match this contract. Where a field carries a description, it is asking for your judgment — answer it, do not fill it in.\n\n\`\`\`json\n${JSON.stringify(contract.document, null, 2)}\n\`\`\`${limits}`;
}

/** What the host has, so an agent it starts is the one the operator configured. */
export interface AgentHost {
  /** The state directory this host owns: prompts, Outputs and the log live under it. */
  readonly dir: string;
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly harness: string;
  readonly model: string;
  /** The operator's effort, where they configured one. */
  readonly effort?: string;
  /** Models the operator added per harness, beside the ones each adapter knows. */
  readonly models?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly permissions: PermissionMode;
  readonly compactAtTokens: number;
  readonly pollMs?: number;
  /** How long an Output may take. Past it the work is uncertain, never finished. */
  readonly collectMs?: number;
  /** How a step's own prompts wait out a pane that says it will clear by itself. */
  readonly patience?: dispatch.Patience;
  /** Each harness's compaction controls; the shipped ones where none are given. */
  readonly ports?: CompactionPorts;
}

type AgentServices = FileSystem.FileSystem | Path.Path | BunServices;

const DEFAULT_POLL_MS = 2000;
const DEFAULT_COLLECT_MS = 2 * 60 * 60 * 1000;

/**
 * The agents a host really starts: herdr's, through the one sender, with the compaction
 * controls and permissions the operator configured. The host's own services are captured
 * here, so a workflow asks for an agent without asking for a filesystem.
 */
export const agentsLayer = (host: AgentHost): Layer.Layer<Agents, never, AgentServices> =>
  Layer.effect(Agents)(
    Effect.gen(function* () {
      const services = yield* Effect.context<AgentServices>();
      return Agents.of(makeAgents(host, (effect) => Effect.provideContext(effect, services)));
    }),
  );

type Under = <A, E>(effect: Effect.Effect<A, E, AgentServices>) => Effect.Effect<A, E>;

const makeAgents = (host: AgentHost, under: Under): AgentsApi => {
  const dirFor = (runId: string) => `${host.dir}/agents/${runId}`;
  const launchPath = (runId: string, operation: string) =>
    `${dirFor(runId)}/${operation}${LAUNCH_SUFFIX}`;
  const outputFor = (runId: string, operation: string) => `${dirFor(runId)}/${operation}.json`;
  const launchOrder = (runId: string) => `${dirFor(runId)}/launches`;
  const log = (runId: string, line: string) => append(`${dirFor(runId)}/agents.log`, line);

  /**
   * Where each named skill is installed. Resolved from the directories the operator's own
   * skills live in, so a mention is the path a harness can actually read and one nobody
   * installed is left out for `skillMention` to say so.
   */
  const skills = Effect.fn("Agents.skills")(function* (names: ReadonlyArray<string>) {
    const found = new Map<string, string>();
    if (names.length === 0) return found;
    const fs = yield* FileSystem.FileSystem;
    const dirs = yield* skillDirs(host.env);
    for (const name of names) {
      if (unsafePathComponent(name) !== null) continue;
      for (const dir of dirs) {
        const file = `${dir}/${name}/SKILL.md`;
        if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
          found.set(name, file);
          break;
        }
      }
    }
    return found;
  });

  /**
   * What this role is, as the persona Markdown for it says — the project's, then this
   * machine's, then the installation's. A role nobody wrote a persona for is still a role:
   * it is stated in one line rather than left blank.
   */
  const personaOf = Effect.fn("Agents.personaOf")(function* (role: string) {
    if (unsafePathComponent(role) !== null) return roleBody(role);
    const fs = yield* FileSystem.FileSystem;
    const where = yield* layers(host.env);
    for (const layer of [...where.all].reverse()) {
      const file = `${layer.dir}/personas/${role}.md`;
      if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) continue;
      const markdown = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const body = contentOf(markdown).preamble;
      if (body.trim() === "") continue;
      const named = yield* skills(skillsIn(body));
      return renderTemplate(body, {}, { skill: skillMention(named) }).text;
    }
    return roleBody(role);
  });

  const deps: dispatch.DispatcherDeps = {
    stateDir: host.env.stateDir,
    herdr: host.herdr,
    log: (line) => append(`${host.dir}/agents/deliveries.log`, line),
  };

  // A harness nobody here has an adapter for falls back to the operator's own, which is
  // the nearest true thing: the agent still starts, on what this machine is set up for.
  const configured = HARNESSES[host.harness] ?? HARNESSES.claude!;
  const adapterFor = (harness: string) => HARNESSES[harness] ?? configured;

  /** Null places it where herdr says the agent is. */
  const entryFor = (
    about: Launched | AgentAsk,
    agent: string,
    place: { readonly paneId: string; readonly workspaceId: string | null } | null,
  ) =>
    dispatch.entryFromLive(deps, {
      role: about.role,
      agent,
      paneId: place?.paneId ?? null,
      workspaceId: place?.workspaceId ?? null,
      runId: about.runId,
      workflow: about.workflow,
    });

  /**
   * The one sender: the first prompt, a repair and a human's own words all go out here.
   * A delivery the ledger already holds under the same claim is refused rather than sent
   * a second time, which is what makes a launch that may already have happened safe to
   * reconcile onto and a retried steer one message rather than two.
   */
  const deliver = Effect.fn("Agents.deliver")(function* (
    about: Launched,
    text: string,
    delivery: {
      readonly kind: "step" | "repair" | "steer";
      /** What this delivery is about; the ledger's causal key is built from it. */
      readonly ref: string;
      readonly mode?: DeliveryMode;
    },
  ) {
    const found = yield* entryFor(about, about.agent, null);
    if (found.entry === null) return { sent: false, why: found.reason ?? "no such agent" };
    const entry = found.entry;
    const draft: dispatch.DeliveryDraft = {
      run: about.runId,
      harness: adapterFor(about.harness).id,
      cause: { kind: delivery.kind, ref: delivery.ref },
      mode: delivery.mode ?? "boundary",
      // A Run of a module has no Intent, so every delivery about one piece of work
      // shares a causal key: that is what makes the second copy refusable.
      intentVersion: 0,
      attempt: 1,
      requestId: `${about.runId}-${delivery.ref}-${delivery.kind}`,
    };
    // A human's own words go out once: they are waiting on the answer, and can say it again.
    const outcome = yield* (
      delivery.kind === "steer"
        ? dispatch.transaction(deps, entry, (channel) => channel.submit(text, draft))
        : dispatch.submitPatiently(deps, entry, text, draft, host.patience)
    ).pipe(Effect.catch((cause) => Effect.succeed(undeliverable(cause))));
    if (outcome.ok) return { sent: true, why: "" };
    // Already sent about this work, on whichever attempt got there first. Sending it
    // again is the second copy this ledger exists to prevent.
    if (outcome.reason === "blocked" && outcome.held !== undefined && SENT_STATES.has(outcome.held))
      return { sent: true, why: outcome.detail };
    return {
      sent: false,
      why: `${outcome.reason}: ${outcome.detail}`,
      refused: outcome.reason === "exhausted",
    };
  });

  /**
   * The workspace this Run's Task lives in. herdr drops a workspace once its last pane
   * closes and never gives its id out again, so one that has gone is reopened on the Run's
   * checkout and written back to the Task, where every Run of it reads the new id. A
   * checkout that has gone too is not guessed at: the work parks.
   */
  const taskWorkspace = Effect.fn("Agents.taskWorkspace")(function* (ask: AgentAsk) {
    const id = ask.task;
    if (id === null) return null;
    const stateDir = host.env.stateDir;
    return yield* withTaskLock(
      stateDir,
      id,
      Effect.gen(function* () {
        const task = yield* readTask(stateDir, id);
        if (task === null) return null;
        const open = yield* host.herdr.workspaceList();
        if (open.some((one) => one.workspaceId === task.workspace)) return task.workspace;
        const fs = yield* FileSystem.FileSystem;
        if (!(yield* fs.exists(ask.cwd).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new AgentParked({
            operation: ask.operation,
            reason: `${id}'s workspace ${task.workspace} has closed and its checkout ${ask.cwd} is gone, so no agent was started. Restore ${ask.cwd} and \`collie run resume ${ask.runId}\`, or begin again with \`collie run start\`.`,
          });
        }
        const reopened = yield* host.herdr.workspaceCreate({ cwd: ask.cwd, label: task.label });
        yield* writeTask(stateDir, { ...task, workspace: reopened.workspaceId });
        yield* log(
          ask.runId,
          `${id}'s workspace ${task.workspace} had closed; reopened on ${ask.cwd} as ${reopened.workspaceId}`,
        );
        return reopened.workspaceId;
      }),
    );
  });

  /** A reused agent's work boundary: compacted past the limit, held while a compaction is unresolved. */
  const boundary = (launched: Launched) =>
    Effect.gen(function* () {
      const found = yield* entryFor(launched, launched.agent, null);
      if (found.entry === null) return { dispatch: true as const };
      return yield* dispatch.transaction(deps, found.entry, (channel) =>
        atBoundary(
          compactionDeps(host, launched.runId),
          { agent: launched.agent, run: launched.runId, step: launched.operation },
          channel,
        ),
      );
    }).pipe(Effect.catch(() => Effect.succeed({ dispatch: true as const })));

  /** A pane, an agent in it, and the registry entry that makes it addressable. */
  const start = Effect.fn("Agents.start")(function* (ask: AgentAsk, agent: string) {
    const adapter = adapterFor(ask.harness ?? host.harness);
    const wanted = ask.permissions ?? undefined;
    const permissions = isPermissionMode(wanted) ? wanted : host.permissions;
    const persona = `${dirFor(ask.runId)}/${ask.operation}.persona.md`;
    yield* write(persona, `${yield* personaOf(ask.role)}\n`);
    return yield* withControlLock(
      host.env.stateDir,
      agent,
      Effect.gen(function* () {
        // Installed before the pane opens, so a failed installation leaves no empty tab.
        const controls = yield* installControls(compactionDeps(host, ask.runId), {
          agent,
          harness: adapter.id,
          cwd: ask.cwd,
        });
        const workspace = ask.workspace ?? (yield* taskWorkspace(ask));
        const tab = yield* host.herdr.tabCreate({ label: ask.role, cwd: ask.cwd, workspace });
        // herdr ignores --cwd on tab create, so the pane is told where it is explicitly.
        yield* host.herdr.paneRun(tab.paneId, `cd ${shellQuote(ask.cwd)}`);
        yield* host.herdr.agentStart({
          name: agent,
          kind: adapter.kind,
          paneId: tab.paneId,
          args: [
            ...startArgs(
              adapter,
              ask.model ?? host.model,
              persona,
              ask.effort ?? undefined,
              permissions,
            ),
            ...controls,
          ],
        });
        yield* log(
          ask.runId,
          `${agent}: ${adapter.id} in ${tab.paneId}, permissions ${permissions}`,
        );
        const found = yield* entryFor(ask, agent, { paneId: tab.paneId, workspaceId: workspace });
        if (found.entry === null) return undefined;
        yield* registerAgent(
          yield* registryPath(host.env.stateDir, scopeFor(host.env, ask.cwd)),
          found.entry,
        );
        return found.entry.incarnation?.terminalId;
      }),
    );
  });

  const launch = (ask: AgentAsk) =>
    under(
      Effect.gen(function* () {
        // Derived, not minted: this is the name a replay looks for rather than starting
        // a second agent, and a run id is already unique.
        const agent = agentName(ask.runId, ask.agent ?? ask.operation, null, 1);
        const listing = yield* host.herdr.agentList().pipe(Effect.result);
        if (listing._tag === "Failure") {
          // Nothing is started on a question nobody answered: a second agent on the same
          // work is worse than work that stops and says why it stopped.
          return yield* new AgentUncertain({
            operation: ask.operation,
            reason: `herdr cannot say which agents it has (${reason(listing.failure)})`,
          });
        }
        const live = listing.success.find((one) => one.name === agent);
        const alive = live !== undefined;
        const fs = yield* FileSystem.FileSystem;
        // A launch file already here is this same work replayed, not new work for the agent.
        const replayed = yield* fs
          .exists(launchPath(ask.runId, ask.operation))
          .pipe(Effect.orElseSucceed(() => false));
        const terminalId = alive ? (live.terminalId ?? undefined) : yield* start(ask, agent);
        const landed: Launched = {
          agent,
          output: ask.output,
          reused: alive,
          runId: ask.runId,
          operation: ask.operation,
          role: ask.role,
          workflow: ask.workflow,
          harness: ask.harness ?? host.harness,
          model: ask.model ?? host.model,
          effort: ask.effort,
        };
        const launched = terminalId === undefined ? landed : { ...landed, terminalId };
        const adapter = adapterFor(launched.harness);
        const prefix = personaPrefix(adapter, yield* personaOf(ask.role));
        const file = `${dirFor(ask.runId)}/${ask.operation}.prompt.md`;
        // Written before it goes out and never rewritten: what a human reads to see what
        // was actually asked, rather than what a prompt would be built as now.
        yield* write(file, prefix === "" ? ask.prompt : `${prefix}\n\n${ask.prompt}`);
        if (alive && !replayed) {
          const due = yield* boundary(launched);
          if (!due.dispatch) {
            return yield* new AgentParked({ operation: ask.operation, reason: due.reason });
          }
        }
        // Beside it, the agent this work landed on, so a human steering this run later
        // reaches the agent that has it rather than one derived from a name again.
        yield* write(launchPath(ask.runId, ask.operation), encodeLaunched(launched));
        if (!replayed) yield* append(launchOrder(ask.runId), ask.operation);
        // The work is the file, and the message says where it is: one send is one
        // message and not a transcript, and a step's prompt carries a whole contract.
        // A skill marked `disable-model-invocation` refuses an agent that invokes it
        // itself; this is the human's channel, so a slash command here runs.
        const started = ask.skill === null ? "" : `${adapter.skillCommand(ask.skill)} `;
        const asked = yield* deliver(
          launched,
          `${started}Your task for this step is in ${file} — read it and follow it.`,
          { kind: "step", ref: ask.operation },
        );
        if (asked.refused) {
          return yield* refusedWith(ask, `${agent} was not given its work (${asked.why})`, file);
        }
        if (!asked.sent) {
          return yield* new AgentUncertain({
            operation: ask.operation,
            reason: `${agent} was not given its work (${asked.why})`,
          });
        }
        yield* log(
          ask.runId,
          `${agent}: ${alive ? "reattached to" : "launched for"} ${ask.operation}`,
        );
        return launched;
      }).pipe(
        Effect.catch((cause) =>
          Effect.fail(isParked(cause) ? cause : asUncertain(ask.operation, cause)),
        ),
      ),
    );

  const collect = (launched: Launched, unless?: string | null) =>
    under(
      waitForOutput(launched.output, unless ?? null, {
        pollMs: host.pollMs ?? DEFAULT_POLL_MS,
        budgetMs: host.collectMs ?? DEFAULT_COLLECT_MS,
      }),
    );

  const repair = (launched: Launched, problem: string) =>
    under(
      Effect.gen(function* () {
        const text = repairText(launched.output, problem);
        const file = `${dirFor(launched.runId)}/${launched.operation}.repair.md`;
        yield* write(file, text);
        const sent = yield* deliver(launched, text, {
          kind: "repair",
          ref: launched.operation,
        });
        yield* log(
          launched.runId,
          sent.sent
            ? `${launched.agent}: asked to write ${launched.operation}.json again`
            : `${launched.agent}: could not be asked to write it again (${sent.why})`,
        );
        if (sent.refused) {
          return yield* refusedWith(
            launched,
            `${launched.agent} was not asked to write ${launched.operation}.json again (${sent.why})`,
            file,
          );
        }
        return sent.sent;
      }).pipe(
        Effect.catch((cause) =>
          isParked(cause)
            ? Effect.fail(cause)
            : log(
                launched.runId,
                `${launched.agent}: could not be asked to write it again (${reason(cause)})`,
              ).pipe(Effect.as(false)),
        ),
      ),
    );

  /** Every agent this run has launched, oldest first, in the order they were launched. */
  const launchesOf = (runId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(dirFor(runId)).pipe(Effect.orElseSucceed(() => []));
      const order = (yield* fs
        .readFileString(launchOrder(runId))
        .pipe(Effect.orElseSucceed(() => ""))).split("\n");
      // A launch from before the order was kept sorts first, by name.
      const rank = (name: string) => order.lastIndexOf(name.slice(0, -LAUNCH_SUFFIX.length));
      const launches: Launched[] = [];
      const launched = names
        .filter((one) => one.endsWith(LAUNCH_SUFFIX))
        .sort()
        .sort((one, other) => rank(one) - rank(other));
      for (const name of launched) {
        const text = yield* fs
          .readFileString(`${dirFor(runId)}/${name}`)
          .pipe(Effect.orElseSucceed(() => ""));
        const read = decodeLaunched(text);
        if (read._tag === "Success") launches.push(read.success);
      }
      return launches;
    });

  const revive = (ask: AgentAsk, unless?: string | null) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const written = yield* fs.readFileString(ask.output).pipe(Effect.orElseSucceed(() => ""));
        if (written.trim() !== "" && written !== unless) return;
        const agent = agentName(ask.runId, ask.agent ?? ask.operation, null, 1);
        const listing = yield* host.herdr.agentList().pipe(Effect.option);
        if (listing._tag === "None" || listing.value.some((one) => one.name === agent)) return;
        yield* log(
          ask.runId,
          `${agent}: gone before ${ask.operation} was written; starting it again`,
        );
        yield* launch(ask);
      }),
    );

  const handOff = (options: {
    readonly runId: string;
    readonly role: string;
    readonly cwd: string;
    readonly text: string;
  }) =>
    under(
      Effect.gen(function* () {
        const alive = yield* host.herdr.agentList();
        const file = yield* registryPath(host.env.stateDir, scopeFor(host.env, options.cwd));
        const entry = yield* liveAgent(file, alive, options.role);
        // Without a proven incarnation the entry names a pane, not the agent now in it.
        if (entry === null || entry.runId === options.runId) return null;
        if (!verifyIncarnation(entry, alive).ok) return null;
        const handed = { agent: entry.agent, delivered: true, detail: "" };
        const earlier = (yield* deliveriesOf(host.env.stateDir, entry.runId)).filter(
          ({ delivery }) =>
            delivery.cause.kind === "handoff" && delivery.cause.ref === options.runId,
        );
        if (earlier.some(({ delivery }) => delivery.note?.startsWith("reconciled as sent"))) {
          return handed;
        }
        const outcome = yield* dispatch.transaction(deps, entry, (channel) =>
          channel.submit(options.text, {
            run: entry.runId,
            cause: { kind: "handoff", ref: options.runId },
            mode: "boundary",
            intentVersion: 0,
            attempt: 1,
            requestId: `${options.runId}-handoff-${entry.agent}`,
          }),
        );
        if (outcome.ok || (outcome.held !== undefined && SENT_STATES.has(outcome.held))) {
          yield* log(options.runId, `handed to ${entry.agent} of ${entry.runId}`);
          return handed;
        }
        if (outcome.reason === "unknown" || outcome.reason === "blocked") {
          return yield* new AgentParked({
            operation: "handoff",
            reason: `Nobody can say whether ${entry.agent} of ${entry.runId} was handed this (${outcome.detail}), so no second agent was started on it. \`collie run deliveries ${entry.runId}\` shows it; settle it with \`--reconcile <id> --as sent\` or \`--as not-sent\`, then \`collie run resume ${options.runId}\`.`,
          });
        }
        yield* log(
          options.runId,
          `could not hand to ${entry.agent} (${outcome.reason}: ${outcome.detail})`,
        );
        return { agent: entry.agent, delivered: false, detail: outcome.detail };
      }).pipe(
        Effect.catch((cause) =>
          isParked(cause)
            ? Effect.fail(cause)
            : Effect.fail(
                new AgentParked({
                  operation: "handoff",
                  reason: `Whether an agent here can take this could not be read (${reason(cause)}).`,
                }),
              ),
        ),
      ),
    );

  const halt = (runId: string) =>
    under(
      Effect.gen(function* () {
        const launches = yield* launchesOf(runId);
        if (launches.length === 0) return { stopped: [], left: [] };
        const listing = yield* host.herdr.agentList().pipe(Effect.result);
        if (listing._tag === "Failure") {
          return {
            stopped: [],
            left: [`herdr cannot say which agents it has (${reason(listing.failure)})`],
          };
        }
        const stopped: string[] = [];
        const left: string[] = [];
        for (const one of listing.success) {
          const ours = launches.findLast((launched) => launched.agent === one.name);
          if (ours === undefined) continue;
          if (ours.terminalId === undefined || one.terminalId === null) {
            left.push(`${one.name} cannot be proven to be this Run's, so it was left running`);
            continue;
          }
          if (ours.terminalId !== one.terminalId) continue;
          const closed = yield* host.herdr.paneClose(one.paneId).pipe(Effect.result);
          if (closed._tag === "Success") stopped.push(one.name);
          else
            left.push(
              `${one.name}'s pane ${one.paneId} would not close (${reason(closed.failure)})`,
            );
        }
        if (stopped.length > 0) yield* log(runId, `stopped ${stopped.join(", ")}`);
        if (left.length > 0) yield* log(runId, `not stopped: ${left.join("; ")}`);
        return { stopped, left };
      }),
    );

  const steer = (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: DeliveryMode;
  }) =>
    under(
      Effect.gen(function* () {
        const launches = yield* launchesOf(options.runId);
        const { operation, agent } = options;
        const launched =
          agent !== undefined
            ? launches.findLast((one) => one.agent === agent)
            : operation !== undefined
              ? launches.find((one) => one.operation === operation)
              : launches.at(-1);
        if (launched === undefined) {
          const about =
            agent !== undefined
              ? ` named "${agent}"`
              : operation !== undefined
                ? ` on "${operation}"`
                : "";
          return {
            agent: "",
            delivered: false,
            detail: `${options.runId} has launched no agent${about}`,
          };
        }
        const sent = yield* deliver(launched, options.text, {
          kind: "steer",
          ref: options.request,
          mode: options.mode,
        });
        yield* log(
          options.runId,
          sent.sent
            ? `${launched.agent}: told "${firstLine(options.text)}"`
            : `${launched.agent}: could not be told "${firstLine(options.text)}" (${sent.why})`,
        );
        return { agent: launched.agent, delivered: sent.sent, detail: sent.why };
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({ agent: "", delivered: false, detail: reason(cause) }),
        ),
      ),
    );

  return {
    outputFor,
    skills: (names) => under(skills(names)),
    askRoute: (role, cwd) =>
      under(
        Effect.gen(function* () {
          const alive = yield* host.herdr.agentList();
          const file = yield* registryPath(host.env.stateDir, scopeFor(host.env, cwd));
          const entry = yield* liveAgent(file, alive, role);
          // A register entry with no incarnation names a pane, and whatever is in that
          // pane now is not the agent it was written about.
          return askRouteTo(entry !== null && verifyIncarnation(entry, alive).ok ? entry : null);
        }).pipe(Effect.orElseSucceed(() => askRouteTo(null))),
      ),
    pollMs: host.pollMs ?? DEFAULT_POLL_MS,
    choose: (layers) => {
      const configured = { harness: host.harness, model: host.model, effort: host.effort };
      const resolved = resolveChoice([configured, ...layers], host.models);
      return resolved.ok
        ? Effect.succeed(resolved.choice)
        : Effect.fail(new WorkflowError({ reason: resolved.problem }));
    },
    choiceOf: (runId, agent) =>
      under(
        Effect.gen(function* () {
          const name = agentName(runId, agent, null, 1);
          const held = (yield* launchesOf(runId)).findLast((one) => one.agent === name);
          if (held === undefined) return null;
          const listing = yield* host.herdr.agentList().pipe(Effect.option);
          const alive = Option.exists(listing, (agents) => agents.some((one) => one.name === name));
          if (!alive || held.model === undefined) return null;
          return { harness: held.harness, model: held.model, effort: held.effort ?? null };
        }),
      ),
    launch,
    revive,
    handOff,
    halt,
    collect,
    repair,
    steer,
  };
};

const LAUNCH_SUFFIX = ".launch.json";
const SENT_STATES: ReadonlySet<string> = new Set(["submitted", "acknowledged", "verified"]);
const LaunchedJson = Schema.fromJsonString(Launched);
const encodeLaunched = Schema.encodeSync(LaunchedJson);
const decodeLaunched = Schema.decodeUnknownResult(LaunchedJson);

/** What a delivery is called in a log: one line of it, so the log stays readable. */
const firstLine = (text: string) => text.split("\n")[0] ?? "";

/** A prompt that is waiting on its pane, said with what picks it up again. */
const refusedWith = (
  about: { readonly runId: string; readonly operation: string },
  what: string,
  file: string,
) =>
  new AgentParked({
    operation: about.operation,
    reason: `${what}. It is alive and what it was to be told is in ${file}; \`collie run resume ${about.runId}\` hands that to it.`,
  });

const isParked = Schema.is(AgentParked);

/** Anything a launch failed on, said as what it means: nobody can be sure what happened. */
const isUncertain = Schema.is(AgentUncertain);
const asUncertain = (operation: string, cause: unknown): AgentUncertain =>
  isUncertain(cause) ? cause : new AgentUncertain({ operation, reason: reason(cause) });

/** What the role is stated as, in the persona and in the prompt alike. */
const roleBody = (role: string) => `You are the ${role}.`;

/**
 * One Output the agent could not write correctly, handed back to that same agent with the
 * reason. It is still in its pane holding the work; starting the work again would throw a
 * whole round away over a write.
 */
export const repairText = (output: string, problem: string): string =>
  `Your Output file is not usable: ${problem}\n\nWrite ${output} again — the JSON the contract described, nothing else. Do not redo the work, do not explain, do not write anything outside that file. It is the only thing missing.\nOUTPUT_PATH: ${output}`;

const compactionDeps = (host: AgentHost, runId: string): CompactionDeps => ({
  ports: host.ports ?? COMPACTION_PORTS,
  stateDir: host.env.stateDir,
  configured: host.compactAtTokens,
  herdr: host.herdr,
  log: (line) => append(`${host.dir}/agents/${runId}/agents.log`, line),
  warn: (line) => append(`${host.dir}/agents/${runId}/agents.log`, line),
  waitMs: COMPACTION_WAIT_MS,
  pollMs: host.pollMs ?? DEFAULT_POLL_MS,
});

const undeliverable = (cause: unknown) => ({
  ok: false as const,
  id: null,
  reason: "failed" as const,
  detail: reason(cause),
});

/**
 * What the agent wrote, once there is something to read. A file that exists but is blank
 * is a write that has not happened — or one caught half done — not an empty answer, and
 * `unless` is the same again: an Output already known to be unusable is the file not
 * having been rewritten. Null where nothing arrived in the time allowed, which says the
 * work is uncertain and never that it did not happen.
 */
const waitForOutput = (
  path: string,
  unless: string | null,
  every: { readonly pollMs: number; readonly budgetMs: number },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const tries = Math.max(1, Math.ceil(every.budgetMs / Math.max(1, every.pollMs)));
    return yield* read.pipe(
      Effect.flatMap((text) =>
        text.trim() === "" || text === unless
          ? Effect.fail(new Error("not yet"))
          : Effect.succeed(text),
      ),
      Effect.retry({ times: tries, schedule: Schedule.spaced(Duration.millis(every.pollMs)) }),
      Effect.orElseSucceed(() => null),
    );
  }).pipe(Effect.orDie);

const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = path.lastIndexOf("/");
    if (at > 0) yield* fs.makeDirectory(path.slice(0, at), { recursive: true });
    yield* fs.writeFileString(path, text);
  }).pipe(Effect.orDie);

const append = (path: string, line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = path.lastIndexOf("/");
    if (at > 0) yield* fs.makeDirectory(path.slice(0, at), { recursive: true });
    yield* fs.writeFileString(path, `${line}\n`, { flag: "a" });
  }).pipe(Effect.ignore);

/**
 * The agents layer as a host builds one, on the harness, model and permissions the
 * operator configured. Read when the host takes its directory: a host serves work for as
 * long as it owns one, and a launch is made under the settings that were in force then.
 */
export const configuredAgents = Effect.fn("Agents.configured")(function* (dir: string) {
  const env = yield* currentEnv.pipe(Effect.orDie);
  const defaults = yield* loadDefaults(env.configDir).pipe(
    Effect.orElseSucceed(() => FALLBACK_DEFAULTS),
  );
  return agentsLayer({
    dir,
    env,
    herdr: new Herdr(env),
    harness: defaults.harness,
    model: defaults.model,
    effort: defaults.effort,
    models: defaults.models,
    permissions: isPermissionMode(defaults.permissions) ? defaults.permissions : "bypass",
    compactAtTokens: defaults.compactAtTokens,
  });
});
