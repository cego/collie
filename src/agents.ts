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
  Clock,
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
import * as Activity from "effect/workflow/Activity";
import { attachmentsDir, listAttachments, type Attachment } from "./attachments";
import { Launched, LAUNCH_ORDER, LAUNCH_SUFFIX, launchDir, readLaunches, stemOf } from "./launches";
export { Launched } from "./launches";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import {
  COMPACTION_WAIT_MS,
  atBoundary,
  awaitReady,
  controlDir,
  installControls,
  withControlLock,
  type CompactionDeps,
  type CompactionPorts,
} from "./compaction";
import { COMPACTION_PORTS, ranOutSince, submittedDelivery } from "./compactors";
import { kindForRole } from "./cards";
import { Oversight } from "./oversight";
import { FALLBACK_DEFAULTS, loadDefaults, readConfig, type Defaults } from "./config";
import { RanOn } from "./board-model";
import * as dispatch from "./dispatcher";
import type * as Types from "effect/Types";
import { bodySections, layers, personaHoles, skillDirs } from "./definitions";
import { currentEnv, type PluginEnv } from "./env";
import {
  HARNESSES,
  foldPreferences,
  isPermissionMode,
  permissionsAsWritten,
  personaPrefix,
  ceilingIn,
  DEFAULT_MODEL,
  pinned,
  preferencesIn,
  resolveWithRoom,
  said,
  startArgs,
  type AgentChoice,
  type HarnessAdapter,
  type PermissionMode,
  type Preferences,
} from "./harness";
import { Herdr, herdrFailureReason, type AgentInfo, type HerdrError, type PaneInfo } from "./herdr";
import { agentName, agentTabLabel, reason, shellQuote, unsafePathComponent } from "./naming";
import { askRouteTo } from "./handoff";
import { nowIso } from "./time";
import { roomFor, subscriptionOf, type UsageReading } from "./usage-model";
import { ownCodexReading } from "./usage";
import { lineageAgent, registerAgent, registryPath, scopeFor, verifyIncarnation } from "./registry";
import {
  jsonSchemaFor,
  AgentScopes,
  Host,
  Run,
  WorkflowAgents,
  Template,
  WorkflowError,
  panelOf,
  type HostApi,
  type Projection,
  type Seat,
} from "./sdk";
import { causalKey, deliveriesOf, SENT_STATES, toldLine } from "./steering";
import { readTask, taskOfWorkspace, withTaskLock, writeTask } from "./task";
import { malformedIn, renderTemplate, skillMention, skillsIn } from "./template";

/** A schema that decodes an agent's Output without services of the author's own. */
export type OutputContract = Schema.Codec<unknown, unknown, never, never>;

/** One piece of agent work, named so that replaying it finds what it already did. */
export interface AgentAsk {
  readonly runId: string;
  readonly operation: string;
  /** What this agent is being asked to be, stated rather than inferred from a name. */
  readonly role: string;
  /** The persona it is started as, where it is not its role's. */
  readonly persona?: string | null;
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
  /** What this work fell back from, and why, where it did. */
  readonly from?: AgentChoice;
  readonly why?: string;
  /** Which agent of this work it is: past 1, one taking over from an agent that ran out. */
  readonly sequence?: number;
}

/**
 * The agent chosen for one piece of work, recorded before anything starts it, with what it
 * fell back from and why.
 */
export const AgentChoiceSchema = Schema.Struct({
  ...RanOn.fields,
  from: Schema.optionalKey(RanOn),
  why: Schema.optionalKey(Schema.String),
});
export type ChosenAgent = typeof AgentChoiceSchema.Type;

/** An agent that stopped because its subscription ran out, before it wrote its Output. */
export const RanOut = Schema.TaggedStruct("RanOut", {
  why: Schema.String,
  /** Where its harness keeps the conversation, where it said. */
  transcript: Schema.NullOr(Schema.String),
});
export type RanOut = typeof RanOut.Type;
const isRanOut = Schema.is(RanOut);

/** A collection: the Output's text, nothing in the time allowed, or the agent ran out. */
export const Collected = Schema.Union([Schema.String, Schema.Null, RanOut]);

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
  /** What this Run's `attachments/` holds now, which its next prompt lists. */
  readonly attachments: (runId: string) => Effect.Effect<ReadonlyArray<Attachment>>;
  /**
   * What an agent is told about asking for a decision its work does not cover: the pane
   * of whoever is live in that role in this Run's lineage — `Place.lineage` — and
   * otherwise to decide and record it under `assumptions` in its Output. A role, not a bare route: who may be asked is the
   * workflow's own declaration.
   */
  readonly askRoute: (role: string, lineage: ReadonlyArray<string>) => Effect.Effect<string>;
  /** How often anything here looks again, which a workflow's own watch for a stop shares. */
  readonly pollMs: number;
  /**
   * The agent these preferences come to over the operator's configuration, lowest first,
   * moved on to one with room where its Subscription is spent.
   */
  readonly choose: (
    layers: ReadonlyArray<Preferences | undefined>,
    work: { readonly runId: string; readonly operation: string },
    /** Agents that ran out on this work, and why; their Subscriptions count as Exhausted. */
    spent?: ReadonlyArray<{ readonly on: AgentChoice; readonly why: string }>,
  ) => Effect.Effect<ChosenAgent, WorkflowError>;
  /**
   * What this Run's agent of that name runs on, as its newest incarnation, where it is
   * running; null where it is not.
   */
  readonly choiceOf: (
    runId: string,
    agent: string,
  ) => Effect.Effect<(ChosenAgent & { readonly sequence: number }) | null>;
  /**
   * Once this agent has run out — its harness said so since it was given this work, or
   * its Subscription reads Exhausted for it — why. Never succeeds otherwise.
   */
  readonly ranOut: (launched: Launched) => Effect.Effect<RanOut>;
  /** Closes this one agent's pane, with `line` in the Run's log; parks unless it is gone. */
  readonly retire: (launched: Launched, line: string) => Effect.Effect<void, AgentParked>;
  /** A line in the Run's log. */
  readonly say: (runId: string, line: string) => Effect.Effect<void>;
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
   * Hands a message, through the one sender, to the live agent in this role of a Run this
   * one came from; null where none. Parked where nobody can say whether it arrived.
   */
  readonly handOff: (options: {
    readonly runId: string;
    readonly role: string;
    /** The Run and the Runs it came from, nearest first: `Place.lineage`. */
    readonly lineage: ReadonlyArray<string>;
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
  ) => Effect.Effect<string | null, AgentUncertain | AgentParked>;
  /**
   * Hands one unusable Output back to the agent that wrote it. True where it was asked, or
   * where the Output is already something other than `unusable`; false where it could not
   * be asked.
   */
  readonly repair: (
    launched: Launched,
    problem: string,
    unusable: string,
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
  /** The agent this Run launched last, which is whose work a correction is about; null for none. */
  readonly newest: (runId: string) => Effect.Effect<Launched | null>;
  /** One correction Collie decided on, to that agent, through the one sender; whether it went. */
  readonly correct: (
    runId: string,
    correction: {
      readonly text: string;
      readonly constraint: string;
      readonly requestId: string;
      readonly attempt: number;
      readonly intentVersion: number;
      readonly mode: DeliveryMode;
    },
  ) => Effect.Effect<boolean>;
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
  /** Not delivered because no incarnation of the agent is alive. */
  readonly gone?: boolean;
}

/** What a stop closed, and what may still be running after it. */
export interface Halted {
  readonly stopped: ReadonlyArray<string>;
  readonly left: ReadonlyArray<string>;
}

export class Agents extends Context.Service<Agents, AgentsApi>()("collie/Agents") {}

/** What an author asks for: the work, not the steps it takes. */
export type AgentWork<
  Output extends OutputContract,
  Input extends Readonly<Record<string, Schema.Json>> = never,
> = Doing<Output> & Told<Input>;

/**
 * What the agent is told: a template and the input it declares, or text of the author's
 * own — a template literal, say — with `input` for any `{{name}}` in it. Either way an
 * expression nothing fills is refused before an agent starts.
 */
export type Told<Input extends Readonly<Record<string, Schema.Json>>> =
  | { readonly instructions: Template<Input>; readonly input: Input }
  | { readonly instructions: string; readonly input?: Readonly<Record<string, Schema.Json>> };

interface Doing<Output extends OutputContract> {
  /** Stable within the run: the Activity names and the agent's name are derived from it. */
  readonly operation: string;
  /** Where the agent works; the checkout the host placed the Run on where it is left out. */
  readonly cwd?: string;
  /**
   * What the Output has to be: the prompt carries its drawing, and this decides. Left out,
   * the agent answers in plain text.
   */
  readonly output?: Output;
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
   * The panel seat this work sits at: its agent over the role's, and its persona and
   * instructions where it names them. Work for a role given none takes the agent of the
   * role's first seat, and keeps its own persona and instructions.
   */
  readonly seat?: Seat;
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
export const agentWork = <
  Output extends OutputContract = typeof Schema.String,
  Input extends Readonly<Record<string, Schema.Json>> = never,
>(
  given: AgentWork<Output, Input>,
): Effect.Effect<
  Output["Type"],
  WorkflowError,
  Run | Agents | Host | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const host = yield* Host;
    const oversight = yield* Effect.serviceOption(Oversight);
    const run = yield* Run;
    const runId = run.id;
    const place = yield* host.place(runId);
    const plain = given.output === undefined;
    // SAFETY: Output defaults to Schema.String exactly where no output was given.
    const contract = (given.output ?? Schema.String) as Output;
    const told = given.seat?.instructions ?? given.instructions;
    const work = {
      ...given,
      instructions: told instanceof Template ? told.text : told,
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
    const parts: PromptParts = {
      role,
      instructions: work.instructions,
      input: work.input,
      skills,
      cwd: work.cwd,
      output,
      contract: plain ? null : jsonSchemaFor(work.output),
      attachments: yield* agents.attachments(runId),
    };
    const prompt = renderPrompt(parts);
    if (prompt.unfilled.length > 0) {
      return yield* new WorkflowError({
        reason: `${work.operation}: its instructions name ${prompt.unfilled.join(", ")}, which nothing this work was given fills`,
      });
    }
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
    // A boundary: the work so far is judged against the Intent before more is started.
    // Recorded, because a judgement is paid for and a replay must not pay again.
    if (Option.isSome(oversight)) {
      yield* Activity.make({
        name: `${work.operation}.boundary`,
        execute: oversight.value.drift(work.runId, `boundary before ${work.operation}`, "boundary"),
      });
    }
    // Decided and recorded before anything is started, so a recovery, a revival and a
    // restart all start the agent this work was given, whatever is configured by then.
    const preferred = yield* WorkflowAgents;
    const seated = given.seat ?? (yield* panelOf(role))[0];
    const layers = [
      preferred,
      ceilingIn(seated),
      preferencesIn(place.options),
      ...scopes,
      ceilingIn(given),
    ];
    const choice = yield* Activity.make({
      name: `${work.operation}.agent`,
      success: AgentChoiceSchema,
      error: WorkflowError,
      execute: held === null ? agents.choose(layers, work) : Effect.succeed(held),
    });
    const ask: Types.Mutable<AgentAsk> = {
      runId: work.runId,
      operation: work.operation,
      role,
      persona: given.seat?.persona ?? null,
      agent: work.agent ?? null,
      workflow: work.workflow ?? work.operation,
      task: place.task,
      workspace: place.workspace,
      cwd: work.cwd,
      output,
      prompt: prompt.text,
      skill: work.skill ?? null,
      harness: choice.harness,
      model: choice.model,
      effort: choice.effort,
      permissions: work.permissions ?? null,
    };
    fellBack(ask, choice.from, choice.why);
    if (held !== null && held.sequence > 1) ask.sequence = held.sequence;

    // Tickets an agent says it finished are carded while it is still working, so a human
    // sees each one land rather than waiting for the whole piece — and looked for once
    // more at the end, for one written just before the Output.
    const watching = <A, E, R>(collecting: Effect.Effect<A, E, R>) => {
      if (Option.isNone(oversight)) return collecting;
      const look = oversight.value.checkpoints(work.runId, work.operation);
      // First to finish, failure included: a collection raised to a human must not wait on a watch that never ends.
      return Effect.raceFirst(
        collecting,
        look.pipe(
          Effect.repeat(Schedule.spaced(Duration.millis(agents.pollMs))),
          Effect.andThen(Effect.never),
        ),
      ).pipe(Effect.tap(() => look));
    };
    // Its own Activity, so a replay that comes back through here writes no second card.
    // The work's rules are checked against what it left before the card is written, so
    // the card says what drifted.
    const carded = <A>(value: A) =>
      Option.isNone(oversight)
        ? Effect.succeed(value)
        : Activity.make({
            name: `${work.operation}.card`,
            execute: oversight.value.drift(work.runId, `${work.operation} collected`, "none").pipe(
              Effect.andThen(
                oversight.value.card(work.runId, {
                  kind: kindForRole(role),
                  step: work.operation,
                  claims: [`wrote ${output}`],
                }),
              ),
            ),
          }).pipe(Effect.as(value));

    // An agent past its budget may still be working: park for a resume, never record null.
    const written =
      (on: Launched, why = "") =>
      (text: string | null) =>
        text !== null
          ? Effect.succeed(text)
          : Effect.fail(
              new AgentParked({
                operation: work.operation,
                reason:
                  why ||
                  `${on.agent} has written nothing to ${output} yet. If it is still working, resume once it has written it; if it has stopped, ask it to write it and resume.`,
              }),
            );
    /** Its Output, or that it ran out; with `waiting`, only its Output, parking with that. */
    const collecting = (on: Launched, from: AgentAsk, waiting?: string) => {
      const output = watching(agents.collect(on)).pipe(Effect.flatMap(written(on, waiting)));
      return stoppable(
        parkedWhenStuck(
          agents
            .revive(from)
            .pipe(
              Effect.andThen(
                waiting === undefined ? Effect.raceFirst(output, agents.ranOut(on)) : output,
              ),
            ),
          host,
          work.runId,
        ),
        host,
        work.runId,
        agents.pollMs,
      );
    };
    let current = yield* Activity.make({
      name: `${work.operation}.launch`,
      success: Launched,
      error: AgentUncertain,
      execute: parkedWhenStuck(agents.launch(ask), host, work.runId),
    });
    let currentAsk: AgentAsk = ask;
    let collected = yield* Activity.make({
      name: `${work.operation}.collect`,
      success: Collected,
      error: AgentUncertain,
      execute: collecting(current, ask),
    });
    // Each agent that ran out is closed and replaced by one on the next choice with room
    // (ADR-0049 D8), every step its own Activity so a replay starts no third agent.
    const spent: Array<{ readonly on: AgentChoice; readonly why: string }> = [];
    for (let n = 1; isRanOut(collected); n++) {
      const out = collected;
      const on = choiceOfLaunch(current);
      spent.push({ on, why: out.why });
      const next = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.agent`,
        success: AgentChoiceSchema,
        error: WorkflowError,
        execute: agents.choose(layers, work, spent),
      });
      if (nothingHasRoom(next)) {
        collected = yield* Activity.make({
          name: `${work.operation}.fallback-${n}.collect`,
          success: Collected,
          error: AgentUncertain,
          execute: agents
            .say(runId, `${work.operation}: ${said(on)} ran out (${out.why}); ${next.why}`)
            .pipe(
              Effect.andThen(
                collecting(
                  current,
                  currentAsk,
                  `${current.agent} ran out (${out.why}) before writing ${output}; ${next.why}. Resume once it has written it.`,
                ),
              ),
            ),
        });
        break;
      }
      const sequence = (current.sequence ?? 1) + 1;
      const successor = agentName(runId, work.agent ?? work.operation, null, sequence);
      const nextAsk: Types.Mutable<AgentAsk> = {
        ...currentAsk,
        harness: next.harness,
        model: next.model,
        effort: next.effort,
        sequence,
        prompt: renderPrompt({
          ...parts,
          handover: handover({ on, why: out.why, transcript: out.transcript }),
        }).text,
        // The chain's first agent, which is what a later ask for this agent may still name.
        from: currentAsk.from ?? on,
        why: out.why,
      };
      yield* Activity.make({
        name: `${work.operation}.fallback-${n}.close`,
        error: AgentUncertain,
        execute: parkedWhenStuck(
          agents.retire(
            current,
            `${work.operation}: ${said(on)} ran out (${out.why}) — continuing on ${said(next)} as ${successor}`,
          ),
          host,
          work.runId,
        ),
      });
      current = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.launch`,
        success: Launched,
        error: AgentUncertain,
        execute: parkedWhenStuck(agents.launch(nextAsk), host, work.runId),
      });
      currentAsk = nextAsk;
      collected = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.collect`,
        success: Collected,
        error: AgentUncertain,
        execute: collecting(current, nextAsk),
      });
    }
    const first = isRanOut(collected) ? null : collected;
    if (first === null) {
      return yield* unusable(current, `wrote nothing to ${output}`);
    }
    const read = decodeOutput(work.output, first, plain);
    if (read.ok) return yield* carded(read.value);

    // The repair is its own Activity, so what a restart finds is a repair that happened
    // rather than an allowance that has come back.
    const asked = yield* Activity.make({
      name: `${work.operation}.repair`,
      success: Schema.Boolean,
      error: AgentUncertain,
      execute: stoppable(
        parkedWhenStuck(
          agents
            .revive(currentAsk, first)
            .pipe(Effect.andThen(agents.repair(current, read.problem, first))),
          host,
          work.runId,
        ),
        host,
        work.runId,
        agents.pollMs,
      ),
    });
    const again = !asked
      ? null
      : yield* Activity.make({
          name: `${work.operation}.recollect`,
          success: Schema.NullOr(Schema.String),
          error: AgentUncertain,
          execute: stoppable(
            // Null here is also the same unusable Output written again, which a repair
            // has had its one chance at, so it ends the work rather than parking it.
            parkedWhenStuck(
              agents
                .revive(currentAsk, first)
                .pipe(Effect.andThen(watching(agents.collect(current, first)))),
              host,
              work.runId,
            ),
            host,
            work.runId,
            agents.pollMs,
          ),
        });
    if (again === null) {
      return yield* unusable(current, `did not write ${output} again: ${read.problem}`);
    }
    const repaired = decodeOutput(work.output, again, plain);
    if (repaired.ok) return yield* carded(repaired.value);
    return yield* unusable(current, `${output} is still unusable: ${repaired.problem}`);
  }).pipe(
    Effect.catchTag("AgentUncertain", (cause) =>
      Effect.fail(
        new WorkflowError({
          reason: `${cause.operation}: ${cause.reason}. Nothing here says the agent did no work.`,
        }),
      ),
    ),
  );

/** Notes on a choice, an ask or a launch what it fell back from and why, where there is either. */
const fellBack = (
  onto: { from?: AgentChoice; why?: string },
  from: AgentChoice | null | undefined,
  why: string | null | undefined,
) => {
  if (from !== null && from !== undefined) onto.from = from;
  if (why !== null && why !== undefined) onto.why = why;
};

/**
 * Whether what is asked for here is what an agent already running is, or, for one that
 * took over from an agent that ran out, what that agent was.
 */
const agrees = (held: ChosenAgent, requested: Preferences): boolean => {
  const is = (on: AgentChoice) =>
    (requested.harness === undefined || requested.harness === on.harness) &&
    (requested.model === undefined || requested.model === on.model) &&
    (requested.effort === undefined || requested.effort === on.effort);
  return is(held) || (held.from !== undefined && is(held.from));
};

/**
 * A message handed, as an Activity, to the live agent in this role of a Run this one came
 * from: the agent it reached, or null where there is none to take it. One nobody can say
 * arrived parks the Run.
 */
export const handOffWork = (given: {
  readonly operation: string;
  readonly role: string;
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
    const options = { ...given, runId, lineage: (yield* host.place(runId)).lineage };
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
 * A collection or a repair an operator can stop while it is out, and resume back into.
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
      collecting.pipe(
        Effect.exit,
        Effect.map((exit) => ({ collected: true as const, exit })),
      ),
      untilStopped(host, runId, pollMs).pipe(Effect.as({ collected: false as const })),
    );
    // A stop closes the agent, which can fail this before the stop is seen: the stop is
    // what happened, so the work waits for the resume either way.
    if (!raced.collected || (yield* host.stopRequested(runId)))
      return yield* Workflow.suspend(wait);
    return yield* raced.exit;
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
  /** What the instructions' `{{name}}` expressions read, as the module supplies it. */
  readonly input?: Readonly<Record<string, Schema.Json>>;
  /** Where each mentioned skill is installed; a mention of one that is not says so. */
  readonly skills?: ReadonlyMap<string, string>;
  readonly cwd?: string;
  /** The Run's attachments when this step is launched. */
  readonly attachments?: ReadonlyArray<Attachment>;
  /** What an agent taking over this work from one that ran out is told first. */
  readonly handover?: string;
}

/**
 * What the agent is asked to do, where the answer goes, and what the answer has to be.
 * Pure, so a test and an author can read one without starting anything, and so a replay
 * never builds a different one. The role is the persona, injected at launch, and
 * reaches a body here as `{{role}}`.
 */
export function promptFor(parts: PromptParts): string {
  return renderPrompt(parts).text;
}

/** The prompt, and every expression in the instructions nothing filled. */
function renderPrompt(parts: PromptParts) {
  const given = {
    ...parts.input,
    role: parts.role,
    cwd: parts.cwd ?? "",
    output_path: parts.output,
  };
  const rendered = renderTemplate(parts.instructions, given, {
    skill: skillMention(parts.skills ?? new Map()),
  });
  const unfilled = [
    ...rendered.missing.map((name) => `{{${name}}}`),
    ...malformedIn(parts.instructions),
  ];
  const text = [
    rendered.text.trim(),
    attachmentsSection(parts.attachments ?? []),
    parts.handover ?? "",
    `When you are done, write your result ${parts.contract === null ? "as plain text" : "as JSON"} to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${parts.output}`,
    parts.contract === null ? "" : contractSection(parts.contract),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return { text, unfilled };
}

/** What an agent taking over from one that ran out is told (ADR-0049 D8). */
export function handover(ranOut: {
  readonly on: AgentChoice;
  readonly why: string;
  readonly transcript: string | null;
}): string {
  const where =
    ranOut.transcript === null
      ? ""
      : ` Its conversation is at ${ranOut.transcript}; read it if you need what it was told or decided.`;
  return `Another agent (${said(ranOut.on)}) started this work and stopped because its subscription ran out (${ranOut.why}). Whatever it changed is in the checkout: read \`git status\` and \`git diff\` before you start, and carry on rather than start over.${where}`;
}

function attachmentsSection(attachments: ReadonlyArray<Attachment>): string {
  if (attachments.length === 0) return "";
  return [
    "Files given to this Run, which you can open like any other:",
    ...attachments.map((one) => `- ${one.name} (${one.mediaType}, ${one.size} bytes): ${one.path}`),
  ].join("\n");
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
  /** This Machine's Usage readings; none where left out. */
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  /** A running agent's own reading, where its harness serves one; none where left out. */
  readonly ownReading?: (agent: string) => Effect.Effect<UsageReading | null>;
  /** The human's Fallback chain; the configured `fallbacks`, read at every choice, where left out. */
  readonly fallbacks?: Effect.Effect<ReadonlyArray<string>>;
  readonly permissions: PermissionMode;
  /** `auto` where not given. */
  readonly trust?: Defaults["trust"];
  readonly compactAtTokens: number;
  readonly pollMs?: number;
  /** How long an Output may take. Past it the work is uncertain, never finished. */
  readonly collectMs?: number;
  /** How long a new agent's harness has to show it can take its first prompt. */
  readonly readyMs?: number;
  /** How long a settled agent may show neither an unobserved prompt nor a turn from it. */
  readonly confirmGraceMs?: number;
  /** How a step's own prompts wait out a pane that says it will clear by itself. */
  readonly patience?: dispatch.Patience;
  /** Each harness's compaction controls; the shipped ones where none are given. */
  readonly ports?: CompactionPorts;
}

type AgentServices = FileSystem.FileSystem | Path.Path | BunServices;

const DEFAULT_POLL_MS = 2000;
const READING_EVERY_MS = 60_000;

/** What a launch ran on, as a choice. */
const choiceOfLaunch = (launched: Launched): AgentChoice => ({
  harness: launched.harness,
  model: launched.model ?? DEFAULT_MODEL,
  effort: launched.effort ?? null,
});

/** A choice that stayed on its preferred agent only because nothing else had room. */
const nothingHasRoom = (chosen: ChosenAgent) =>
  chosen.from === undefined && chosen.why !== undefined;

/** Whether two choices draw on the same usage: the same agent, or the same Subscription. */
const sameUsage = (one: AgentChoice, other: AgentChoice) => {
  const drawn = subscriptionOf(one);
  return said(one) === said(other) || (drawn !== null && drawn === subscriptionOf(other));
};

/**
 * How long a harness may take to be ready. In a checkout it has never opened it settles
 * trust, loads plugins and starts MCP servers, which outlasts herdr's own 30s.
 */
const START_TIMEOUT_MS = 180_000;

/** Past herdr's own start, which has already waited for the harness to be ready. */
const READY_TIMEOUT_MS = 120_000;

/** Longer than herdr takes to see a taken prompt become a turn, even under load. */
const CONFIRM_GRACE_MS = 15_000;

/** herdr says this of a pane that exists but whose shell has not come up yet. */
const paneNotReady = (error: HerdrError) =>
  /agent_pane_busy|not an available shell/.test(error.detail);

/**
 * herdr keeps the name of an agent blocked during startup — a first-run dialog in its
 * pane — so it is there, and its prompt waits for it as any blocked agent's does.
 */
const blockedAtStartup = (error: HerdrError) =>
  error.code === "agent_not_ready" || /blocked during startup/.test(error.detail);
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
  const dirFor = (runId: string) => launchDir(host.dir, runId);
  const launchPath = (runId: string, operation: string) =>
    `${dirFor(runId)}/${operation}${LAUNCH_SUFFIX}`;
  const outputFor = (runId: string, operation: string) => `${dirFor(runId)}/${operation}.json`;
  const launchOrder = (runId: string) => `${dirFor(runId)}/${LAUNCH_ORDER}`;
  /** What went out as a step's prompt or its repair, kept so a resend is the same words. */
  const sentPath = (about: Launched, kind: "step" | "repair") =>
    `${dirFor(about.runId)}/${stemOf(about)}.${kind}.md`;
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
      const body = bodySections(markdown.replace(PERSONA_FRONT_MATTER, "")).preamble;
      if (body.trim() === "") continue;
      const unfilled = personaHoles(body);
      if (unfilled.length > 0) {
        return yield* new AgentParked({
          operation: role,
          reason: `the ${role} persona in ${file} names ${unfilled.join(", ")}, and a persona is told nothing but {{skill:name}}: fix it, then resume this Run`,
        });
      }
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
      readonly kind: "step" | "repair" | "steer" | "correction";
      /** What this delivery is about; the ledger's causal key is built from it. */
      readonly ref: string;
      readonly mode?: DeliveryMode;
      /** A correction is about one version of the Intent, and counts its attempts. */
      readonly intentVersion?: number;
      readonly attempt?: number;
      readonly requestId?: string;
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
      // Work, a repair and a steer share a causal key per thing they are about, which is
      // what makes the second copy refusable; a correction's is its constraint's.
      intentVersion: delivery.intentVersion ?? 0,
      attempt: delivery.attempt ?? 1,
      requestId: delivery.requestId ?? `${about.runId}-${delivery.ref}-${delivery.kind}`,
    };
    // A human's own words go out once: they are waiting on the answer, and can say it again.
    // So does a correction: another attempt at one is Collie's to decide, not a retry's.
    const outcome = yield* (
      delivery.kind === "steer" || delivery.kind === "correction"
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
        yield* writeTask(stateDir, {
          ...task,
          workspace: reopened.workspaceId,
          root_pane: reopened.rootTab?.paneId ?? null,
        });
        yield* log(
          ask.runId,
          `${id}'s workspace ${task.workspace} had closed; reopened on ${ask.cwd} as ${reopened.workspaceId}`,
        );
        return reopened.workspaceId;
      }),
    );
  });

  /**
   * The shell pane the Task's workspace was made with, for its first agent to take over
   * rather than leave an empty first tab beside one of its own. Taken once, under the
   * Task's lock, and used only while it is still there with nothing running in it.
   */
  const rootPane = Effect.fn("Agents.rootPane")(function* (ask: AgentAsk) {
    const id = ask.task;
    if (id === null) return null;
    const stateDir = host.env.stateDir;
    const taken = yield* withTaskLock(
      stateDir,
      id,
      Effect.gen(function* () {
        const task = yield* readTask(stateDir, id);
        const pane = task?.root_pane ?? null;
        if (task === null || pane === null) return null;
        yield* writeTask(stateDir, { ...task, root_pane: null });
        return pane;
      }),
    );
    if (taken === null) return null;
    const panes = yield* host.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
    const pane = panes.find((one) => one.paneId === taken && one.agent === null);
    return pane === undefined ? null : { tabId: pane.tabId, paneId: pane.paneId };
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

  const checkedTrust = new Set<string>();

  /**
   * The harness's own "may I work here", answered before it can ask. A grant that cannot be
   * written never stops the launch: the harness then asks in its own pane.
   */
  const ensureTrusted = Effect.fn("Agents.ensureTrusted")(function* (
    runId: string,
    adapter: HarnessAdapter,
    cwd: string,
  ) {
    if (host.trust === "never") return;
    const trust = adapter.trust?.(host.env.home, host.env.stateDir);
    const key = `${runId}\0${adapter.id}\0${cwd}`;
    if (trust === undefined || checkedTrust.has(key)) return;
    checkedTrust.add(key);
    const asks = `${adapter.id} will ask in its own pane`;
    const message = yield* trust.state(cwd).pipe(
      Effect.flatMap((state) =>
        state === "untrusted"
          ? trust.grant(cwd).pipe(Effect.map((result) => result.message))
          : Effect.succeed(
              state === "unknown"
                ? `${adapter.id}'s record of trusted directories is missing or not readable; nothing written for ${cwd}, ${asks}`
                : null,
            ),
      ),
      Effect.catch((cause) =>
        Effect.succeed(`could not record trust for ${cwd} (${reason(cause)}); ${asks}`),
      ),
    );
    if (message !== null) yield* log(runId, `trust ${adapter.id}: ${message}`);
  });

  /** A pane, an agent in it, and the registry entry that makes it addressable. */
  const start = Effect.fn("Agents.start")(function* (
    ask: AgentAsk,
    agent: string,
    alive: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
  ) {
    const adapter = adapterFor(ask.harness ?? host.harness);
    const wanted = ask.permissions ?? undefined;
    // Read at each start rather than kept from the host's: a host outlives the
    // Settings change that flips this, and every agent after it has to see the change.
    const written = yield* readConfig(host.env.userDir).pipe(
      Effect.map((config) => permissionsAsWritten(config.permissions)),
      Effect.orElseSucceed(() => undefined),
    );
    const asked = isPermissionMode(wanted)
      ? wanted
      : isPermissionMode(written)
        ? written
        : host.permissions;
    const forbidden =
      asked === "bypass" && adapter.bypassForbidden !== undefined
        ? yield* adapter.bypassForbidden(host.env)
        : false;
    const permissions = forbidden ? "auto" : asked;
    yield* ensureTrusted(ask.runId, adapter, ask.cwd);
    const persona = `${dirFor(ask.runId)}/${stemOf(ask)}.persona.md`;
    yield* write(persona, `${yield* personaOf(ask.persona ?? ask.role)}\n`);
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
        const reused = ask.workspace ? null : yield* rootPane(ask);
        const label = agentTabLabel(ask);
        if (reused !== null) yield* Effect.ignore(host.herdr.tabRename(reused.tabId, label));
        const tab = reused ?? (yield* host.herdr.tabCreate({ label, cwd: ask.cwd, workspace }));
        // herdr ignores --cwd on tab create, so the pane is told where it is explicitly.
        yield* host.herdr.paneRun(tab.paneId, `cd ${shellQuote(ask.cwd)}`);
        yield* host.herdr
          .agentStart({
            name: agent,
            kind: adapter.kind,
            paneId: tab.paneId,
            timeoutMs: START_TIMEOUT_MS,
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
          })
          .pipe(
            Effect.retry({ while: paneNotReady, times: 5, schedule: Schedule.spaced("1 second") }),
            Effect.catchIf(blockedAtStartup, () =>
              log(ask.runId, `${agent}: blocked during startup in ${tab.paneId}; its prompt waits`),
            ),
          );
        yield* log(
          ask.runId,
          `${agent}: ${adapter.id} in ${tab.paneId}, permissions ${permissions}${forbidden ? `: ${adapter.id}'s managed settings forbid bypass` : ""}`,
        );
        const found = yield* entryFor(ask, agent, { paneId: tab.paneId, workspaceId: workspace });
        if (found.entry === null) return undefined;
        yield* registerAgent(
          yield* registryPath(host.env.stateDir, scopeFor(host.env, ask.cwd)),
          found.entry,
          alive,
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
        const agent = agentName(ask.runId, ask.agent ?? ask.operation, null, ask.sequence ?? 1);
        const listedAt = yield* nowIso();
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
          .exists(launchPath(ask.runId, stemOf(ask)))
          .pipe(Effect.orElseSucceed(() => false));
        const terminalId = alive
          ? (live.terminalId ?? undefined)
          : yield* start(ask, agent, { agents: listing.success, listedAt });
        const landed: Types.Mutable<Launched> = {
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
        if ((ask.sequence ?? 1) > 1) landed.sequence = ask.sequence;
        landed.at = yield* Clock.currentTimeMillis;
        fellBack(landed, ask.from, ask.why);
        const launched = terminalId === undefined ? landed : { ...landed, terminalId };
        const adapter = adapterFor(launched.harness);
        const prefix = personaPrefix(adapter, yield* personaOf(ask.persona ?? ask.role));
        const file = `${dirFor(ask.runId)}/${stemOf(ask)}.prompt.md`;
        // Written before it goes out and never rewritten: what a human reads to see what
        // was actually asked, rather than what a prompt would be built as now.
        yield* write(file, prefix === "" ? ask.prompt : `${prefix}\n\n${ask.prompt}`);
        if (!alive || !replayed) {
          const late = yield* awaitReady(
            compactionDeps(host, ask.runId),
            agent,
            host.readyMs ?? READY_TIMEOUT_MS,
          );
          if (late !== null) {
            const pane = (yield* entryFor(ask, agent, null)).entry?.paneId ?? "unknown";
            return yield* new AgentParked({
              operation: ask.operation,
              reason: `${agent} in pane ${pane} was started, but ${late}, so nothing was typed into it. Look at the pane; once it shows its prompt, \`collie run resume ${ask.runId}\`.`,
            });
          }
        }
        if (alive && !replayed) {
          const due = yield* boundary(launched);
          if (!due.dispatch) {
            return yield* new AgentParked({ operation: ask.operation, reason: due.reason });
          }
        }
        // Beside it, the agent this work landed on, so a human steering this run later
        // reaches the agent that has it rather than one derived from a name again.
        yield* write(launchPath(ask.runId, stemOf(ask)), encodeLaunched(launched));
        if (!replayed) yield* append(launchOrder(ask.runId), stemOf(ask));
        // The work is the file, and the message says where it is: one send is one
        // message and not a transcript, and a step's prompt carries a whole contract.
        // A skill marked `disable-model-invocation` refuses an agent that invokes it
        // itself; this is the human's channel, so a slash command here runs.
        const started = ask.skill === null ? "" : `${adapter.skillCommand(ask.skill)} `;
        const pointer = `${started}${stepPointer(file)}`;
        yield* write(sentPath(launched, "step"), pointer);
        const asked = yield* deliver(launched, pointer, { kind: "step", ref: stemOf(ask) });
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

  /**
   * The step's prompt, or the repair when `unless` is set, that herdr could not see taken,
   * checked while its Output is awaited: taken, finished with one Enter, or raised to a
   * human. Never silent. One a human settled as not sent goes out once more first.
   */
  const confirmed = (launched: Launched, unless: string | null) =>
    Effect.gen(function* () {
      const found = yield* entryFor(launched, launched.agent, null);
      if (found.entry === null) return;
      const dir = yield* controlDir(host.env.stateDir, launched.agent);
      const kind = unless === null ? "step" : "repair";
      const key = causalKey(launched.runId, { kind, ref: stemOf(launched) }, 0);
      // Only this agent's own ledger: another incarnation's is listed in no time order.
      const last = (yield* deliveriesOf(host.env.stateDir, launched.runId))
        .filter(
          ({ delivery }) =>
            delivery.causal_key === key &&
            delivery.incarnation === found.entry?.incarnation?.terminalId,
        )
        .at(-1)?.delivery;
      // Settled as not sent, or refused by herdr on the last resend: not delivered either way.
      const resend =
        last?.note?.startsWith("reconciled as not-sent") === true ||
        (last?.state === "failed" && last.attempt > 1);
      if (last !== undefined && resend) {
        const fs = yield* FileSystem.FileSystem;
        // Sent before its words were kept: the pointer without a skill command.
        const unkept: Effect.Effect<string, null> =
          kind === "step"
            ? Effect.succeed(stepPointer(`${dirFor(launched.runId)}/${stemOf(launched)}.prompt.md`))
            : Effect.fail(null);
        const again = yield* fs.readFileString(sentPath(launched, kind)).pipe(
          Effect.catch(() => unkept),
          Effect.flatMap((text) =>
            deliver(launched, text, { kind, ref: stemOf(launched), attempt: last.attempt + 1 }),
          ),
          Effect.orElseSucceed(() => ({ sent: false, why: "what was sent is not on file" })),
        );
        if (!again.sent) {
          return yield* new AgentParked({
            operation: launched.operation,
            reason: `${launched.agent} in pane ${found.entry.paneId} could not be sent ${kind === "step" ? "its step's prompt" : "its repair"} again (${again.why}). \`collie run resume ${launched.runId}\` tries again.`,
          });
        }
      }
      yield* dispatch.confirmSubmitted(
        {
          stateDir: host.env.stateDir,
          herdr: host.herdr,
          log: (line) => log(launched.runId, line),
          taken: (delivery) =>
            submittedDelivery(dir, delivery.id).pipe(
              Effect.map((recorded) => (recorded ? "its submit hook recorded it" : null)),
              Effect.orElseSucceed(() => null),
            ),
          pollMs: host.pollMs ?? DEFAULT_POLL_MS,
          graceMs: host.confirmGraceMs ?? CONFIRM_GRACE_MS,
        },
        found.entry,
        [key],
      );
    }).pipe(
      Effect.catchIf(
        (cause) => !(cause instanceof dispatch.Unconfirmed) && !isParked(cause),
        (cause) =>
          log(
            launched.runId,
            `${launched.agent}: could not check its prompt was taken (${reason(cause)})`,
          ),
      ),
      Effect.catchTag("Unconfirmed", (unconfirmed) =>
        Effect.fail(
          new AgentParked({
            operation: launched.operation,
            reason: `${unconfirmed.agent} in pane ${unconfirmed.pane} was sent delivery ${unconfirmed.delivery}, and nothing shows it took it: ${unconfirmed.why}. Look at the pane, then settle it with \`collie run deliveries ${launched.runId} --reconcile ${unconfirmed.delivery} --as sent|not-sent\`: \`sent\` once the agent has it (press Enter if the prompt is still in its box), \`not-sent\` to have the resume send it once more. Then \`collie run resume ${launched.runId}\`.`,
          }),
        ),
      ),
    );

  const collect = (launched: Launched, unless?: string | null) =>
    under(
      Effect.raceFirst(
        waitForOutput(launched.output, unless ?? null, {
          pollMs: host.pollMs ?? DEFAULT_POLL_MS,
          budgetMs: host.collectMs ?? DEFAULT_COLLECT_MS,
        }),
        confirmed(launched, unless ?? null).pipe(Effect.andThen(Effect.never)),
      ),
    );

  const repair = (launched: Launched, problem: string, unusable: string) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* fs.readFileString(launched.output).pipe(Effect.orElseSucceed(() => ""));
        // Rewritten while nobody was asking, as across a stop: that Output is the one to read.
        if (now.trim() !== "" && now !== unusable) return true;
        const text = repairText(launched.output, problem);
        const file = sentPath(launched, "repair");
        yield* write(file, text);
        const sent = yield* deliver(launched, text, {
          kind: "repair",
          ref: stemOf(launched),
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

  const launchesOf = (runId: string) => readLaunches(host.dir, runId);

  const revive = (ask: AgentAsk, unless?: string | null) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const written = yield* fs.readFileString(ask.output).pipe(Effect.orElseSucceed(() => ""));
        if (written.trim() !== "" && written !== unless) return;
        const agent = agentName(ask.runId, ask.agent ?? ask.operation, null, ask.sequence ?? 1);
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
    readonly lineage: ReadonlyArray<string>;
    readonly text: string;
  }) =>
    under(
      Effect.gen(function* () {
        const alive = yield* host.herdr.agentList();
        const others = options.lineage.filter((runId) => runId !== options.runId);
        const entry = yield* lineageAgent(host.env.stateDir, alive, options.role, others);
        // Without a proven incarnation the entry names a pane, not the agent now in it.
        if (entry === null) return null;
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

  /**
   * herdr drops a workspace with its last pane, and a stop never takes a Task's workspace:
   * where this pane is the last one in its workspace, a shell is opened there first, and
   * left as the Task's first pane for its next agent to take over.
   */
  const keepWorkspace = (paneId: string, panes: ReadonlyArray<PaneInfo>) =>
    Effect.gen(function* () {
      const pane = panes.find((one) => one.paneId === paneId);
      const workspace = pane?.workspaceId ?? null;
      if (pane === undefined || workspace === null) return;
      if (panes.some((one) => one.workspaceId === workspace && one.paneId !== paneId)) return;
      const shell = yield* host.herdr.tabCreate({
        label: "shell",
        cwd: pane.cwd ?? host.env.cwd,
        workspace,
      });
      const stateDir = host.env.stateDir;
      const task = yield* taskOfWorkspace(stateDir, workspace);
      if (task === null) return;
      yield* withTaskLock(
        stateDir,
        task.id,
        Effect.gen(function* () {
          const current = yield* readTask(stateDir, task.id);
          if (current !== null) yield* writeTask(stateDir, { ...current, root_pane: shell.paneId });
        }),
      );
    }).pipe(Effect.ignore);

  const ranOut = (launched: Launched) =>
    under(
      Effect.gen(function* () {
        const dir = yield* controlDir(host.env.stateDir, launched.agent);
        const on = pinned(choiceOfLaunch(launched));
        let readAt = Number.NEGATIVE_INFINITY;
        for (;;) {
          const reported = yield* ranOutSince(dir, launched.at ?? 0);
          const now = yield* Clock.currentTimeMillis;
          // The Machine's reading at most once a minute, and whenever the harness reports.
          let exhausted: string | null = null;
          if (reported !== null || now - readAt >= READING_EVERY_MS) {
            readAt = now;
            const machine = yield* host.readings ?? Effect.succeed([]);
            const own =
              host.ownReading === undefined ? null : yield* host.ownReading(launched.agent);
            const readings =
              own === null
                ? machine
                : [own, ...machine.filter((one) => one.subscription !== own.subscription)];
            const judged = roomFor(readings, now)(on, undefined);
            exhausted = judged.room ? null : judged.why;
          }
          if (reported !== null)
            return RanOut.make({ why: exhausted ?? reported.why, transcript: reported.transcript });
          if (exhausted !== null) return RanOut.make({ why: exhausted, transcript: null });
          yield* Effect.sleep(Duration.millis(host.pollMs ?? DEFAULT_POLL_MS));
        }
      }).pipe(Effect.orDie),
    );

  const retire = (launched: Launched, line: string) =>
    under(
      Effect.gen(function* () {
        const parked = (why: string) =>
          new AgentParked({
            operation: launched.operation,
            reason: `${launched.agent} ran out and must stop before another agent takes its work, but ${why}. Close it and resume.`,
          });
        const listing = yield* host.herdr
          .agentList()
          .pipe(
            Effect.mapError((cause) =>
              parked(`herdr cannot say whether it is running (${herdrFailureReason(cause)})`),
            ),
          );
        const one = listing.find((agent) => agent.name === launched.agent);
        // Another process under the same name is not the agent that ran out.
        const running =
          one !== undefined &&
          (launched.terminalId === undefined ||
            one.terminalId === null ||
            one.terminalId === launched.terminalId);
        if (running) {
          const panes = yield* host.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
          yield* keepWorkspace(one.paneId, panes);
          yield* host.herdr
            .paneClose(one.paneId)
            .pipe(
              Effect.mapError((cause) =>
                parked(`its pane ${one.paneId} would not close (${herdrFailureReason(cause)})`),
              ),
            );
        }
        yield* log(launched.runId, line);
      }),
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
        let panes = yield* host.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
        for (const one of listing.success) {
          const ours = launches.findLast((launched) => launched.agent === one.name);
          if (ours === undefined) continue;
          if (ours.terminalId === undefined || one.terminalId === null) {
            left.push(`${one.name} cannot be proven to be this Run's, so it was left running`);
            continue;
          }
          if (ours.terminalId !== one.terminalId) continue;
          yield* keepWorkspace(one.paneId, panes);
          const closed = yield* host.herdr.paneClose(one.paneId).pipe(Effect.result);
          panes = panes.filter((pane) => pane.paneId !== one.paneId);
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
              ? launches.findLast((one) => one.operation === operation)
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
            gone: true,
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
            ? toldLine(launched.agent, options.text)
            : `${launched.agent}: could not be told "${firstLine(options.text)}" (${sent.why})`,
        );
        if (sent.sent) return { agent: launched.agent, delivered: true, detail: "" };
        const alive = yield* host.herdr.agentList().pipe(Effect.orElseSucceed(() => []));
        return {
          agent: launched.agent,
          delivered: false,
          detail: sent.why,
          gone: !alive.some((one) => one.name === launched.agent),
        };
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({ agent: "", delivered: false, detail: reason(cause) }),
        ),
      ),
    );

  return {
    outputFor,
    skills: (names) => under(skills(names)),
    attachments: (runId) =>
      under(listAttachments(attachmentsDir(`${host.dir}/runs/${runId}`))).pipe(
        Effect.orElseSucceed(() => []),
      ),
    askRoute: (role, lineage) =>
      under(
        Effect.gen(function* () {
          const alive = yield* host.herdr.agentList();
          const entry = yield* lineageAgent(host.env.stateDir, alive, role, lineage);
          // A register entry with no incarnation names a pane, and whatever is in that
          // pane now is not the agent it was written about.
          return askRouteTo(entry !== null && verifyIncarnation(entry, alive).ok ? entry : null);
        }).pipe(Effect.orElseSucceed(() => askRouteTo(null))),
      ),
    pollMs: host.pollMs ?? DEFAULT_POLL_MS,
    choose: (layers, { runId, operation }, spent = []) =>
      under(
        Effect.gen(function* () {
          const configured = { harness: host.harness, model: host.model, effort: host.effort };
          const readings = yield* host.readings ?? Effect.succeed([]);
          const chain =
            host.fallbacks ??
            loadDefaults(host.env.userDir).pipe(
              Effect.map(({ fallbacks }) => fallbacks),
              Effect.orElseSucceed(() => []),
            );
          const read = roomFor(readings, yield* Clock.currentTimeMillis);
          const out = spent.map(({ on, why }) => ({ on: pinned(on), why }));
          const resolved = resolveWithRoom(
            [configured, ...layers],
            yield* chain,
            (choice, upTo) => {
              const judged = read(choice, upTo);
              const ran = out.find(({ on }) => sameUsage(on, choice));
              return judged.room && ran !== undefined ? { room: false, why: ran.why } : judged;
            },
            host.models,
          );
          if (!resolved.ok) return yield* new WorkflowError({ reason: resolved.problem });
          const { choice, from, why, skipped } = resolved.chosen;
          for (const line of skipped) yield* log(runId, `${operation}: ${line}`);
          // Chosen mid-work, the work's own line says what came of it.
          if (spent.length === 0 && from !== null) {
            yield* log(
              runId,
              `${operation}: fell back from ${said(from)} to ${said(choice)}: ${why}`,
            );
          } else if (spent.length === 0 && why !== null) {
            yield* log(runId, `${operation}: stays on ${said(choice)}: ${why}`);
          }
          const chosen: Types.Mutable<ChosenAgent> = { ...choice };
          fellBack(chosen, from, why);
          return chosen;
        }),
      ),
    choiceOf: (runId, agent) =>
      under(
        Effect.gen(function* () {
          const held = (yield* launchesOf(runId)).findLast(
            (one) => one.agent === agentName(runId, agent, null, one.sequence ?? 1),
          );
          if (held === undefined) return null;
          const listing = yield* host.herdr.agentList().pipe(Effect.option);
          const alive = Option.exists(listing, (agents) =>
            agents.some((one) => one.name === held.agent),
          );
          if (!alive || held.model === undefined) return null;
          const running: Types.Mutable<ChosenAgent & { sequence: number }> = {
            harness: held.harness,
            model: held.model,
            effort: held.effort ?? null,
            sequence: held.sequence ?? 1,
          };
          fellBack(running, held.from, held.why);
          return running;
        }),
      ),
    launch,
    revive,
    ranOut,
    retire,
    say: (runId, line) => under(log(runId, line)),
    handOff,
    halt,
    collect,
    repair,
    steer,
    newest: (runId) =>
      under(launchesOf(runId).pipe(Effect.map((launches) => launches.at(-1) ?? null))).pipe(
        Effect.orElseSucceed(() => null),
      ),
    correct: (runId, correction) =>
      under(
        Effect.gen(function* () {
          const launched = (yield* launchesOf(runId)).at(-1);
          if (launched === undefined) return false;
          const sent = yield* deliver(launched, correction.text, {
            kind: "correction",
            ref: correction.constraint,
            mode: correction.mode,
            intentVersion: correction.intentVersion,
            attempt: correction.attempt,
            requestId: correction.requestId,
          });
          yield* log(
            runId,
            sent.sent
              ? `${launched.agent}: corrected about ${correction.constraint}`
              : `${launched.agent}: could not be corrected about ${correction.constraint} (${sent.why})`,
          );
          return sent.sent;
        }),
      ).pipe(Effect.orElseSucceed(() => false)),
  };
};

const stepPointer = (file: string) =>
  `Your task for this step is in ${file} — read it and follow it.`;
const encodeLaunched = Schema.encodeSync(Schema.fromJsonString(Launched));

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
  isUncertain(cause) ? cause : new AgentUncertain({ operation, reason: herdrFailureReason(cause) });

/** A persona's own front matter, which its definition reads and its agent is not told. */
const PERSONA_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

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
export const configuredAgents = Effect.fn("Agents.configured")(function* (
  dir: string,
  readings: Effect.Effect<ReadonlyArray<UsageReading>>,
) {
  const env = yield* currentEnv.pipe(Effect.orDie);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const defaults = yield* loadDefaults(env.userDir).pipe(
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
    permissions: isPermissionMode(defaults.permissions) ? defaults.permissions : "auto",
    trust: defaults.trust,
    compactAtTokens: defaults.compactAtTokens,
    readings,
    ownReading: (agent) =>
      ownCodexReading(env.stateDir, agent).pipe(Effect.provideContext(services)),
  });
});
