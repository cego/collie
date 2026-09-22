// An agent a native workflow operates, and the Output it is held to.
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

import { Context, Duration, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import {
  COMPACTION_WAIT_MS,
  installControls,
  withControlLock,
  type CompactionDeps,
} from "./compaction";
import { COMPACTION_PORTS } from "./compactors";
import { FALLBACK_DEFAULTS, loadDefaults } from "./config";
import * as dispatch from "./dispatcher";
import { currentEnv, type PluginEnv } from "./env";
import {
  HARNESSES,
  isPermissionMode,
  personaPrefix,
  startArgs,
  type PermissionMode,
} from "./harness";
import { Herdr } from "./herdr";
import { agentName, reason, shellQuote, unsafePathComponent } from "./naming";
import { registerAgent, registryPath, scopeFor } from "./registry";
import {
  jsonSchemaFor,
  NativeHost,
  WorkflowError,
  type NativeHostApi,
  type Projection,
} from "./sdk";
import { renderTemplate } from "./template";

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
  readonly cwd: string;
  readonly prompt: string;
  readonly output: string;
  /** Null takes the host's own configured default, which is the operator's. */
  readonly harness: string | null;
  readonly model: string | null;
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

/** What a host lends a workflow that needs an agent. */
export interface AgentsApi {
  /** Where this operation's Output goes — known before anything starts, so a prompt can name it. */
  readonly outputFor: (runId: string, operation: string) => string;
  /** How often anything here looks again, which a workflow's own watch for a stop shares. */
  readonly pollMs: number;
  readonly launch: (ask: AgentAsk) => Effect.Effect<Launched, AgentUncertain>;
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
  readonly repair: (launched: Launched, problem: string) => Effect.Effect<boolean, AgentUncertain>;
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

export class NativeAgents extends Context.Service<NativeAgents, AgentsApi>()(
  "collie/NativeAgents",
) {}

/** What an author asks for: the work, not the steps it takes. */
export interface AgentWork<Output extends OutputContract> {
  readonly runId: string;
  /** Stable within the run: the Activity names and the agent's name are derived from it. */
  readonly operation: string;
  readonly cwd: string;
  /** The Markdown the agent is given, with `{{inputs.x}}` rendered from the decoded input. */
  readonly instructions: string;
  /** What the Output has to be. The prompt carries its drawing; this decides. */
  readonly output: Output;
  readonly inputs?: Readonly<Record<string, Schema.Json>>;
  readonly role?: string;
  /**
   * The agent this work goes to. Several operations naming one agent are one agent's
   * work in order — a list handed to one implementer, each item its own prompt — and
   * leaving it out gives this operation an agent of its own.
   */
  readonly agent?: string;
  readonly workflow?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly permissions?: PermissionMode;
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
export const agentWork = <Output extends OutputContract>(
  work: AgentWork<Output>,
): Effect.Effect<
  Output["Type"],
  WorkflowError,
  NativeAgents | NativeHost | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> =>
  Effect.gen(function* () {
    const agents = yield* NativeAgents;
    const host = yield* NativeHost;
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
    const ask: AgentAsk = {
      runId: work.runId,
      operation: work.operation,
      role,
      agent: work.agent ?? null,
      workflow: work.workflow ?? work.operation,
      cwd: work.cwd,
      output,
      prompt: promptFor({
        role,
        instructions: work.instructions,
        inputs: work.inputs,
        cwd: work.cwd,
        output,
        contract: jsonSchemaFor(work.output),
      }),
      harness: work.harness ?? null,
      model: work.model ?? null,
      permissions: work.permissions ?? null,
    };

    const launched = yield* Activity.make({
      name: `${work.operation}.launch`,
      success: Launched,
      error: AgentUncertain,
      execute: agents.launch(ask),
    });
    const first = yield* Activity.make({
      name: `${work.operation}.collect`,
      success: Schema.NullOr(Schema.String),
      error: AgentUncertain,
      execute: stoppable(agents.collect(launched), host, work.runId, agents.pollMs),
    });
    if (first === null) {
      return yield* unusable(launched, `wrote nothing to ${output}`);
    }
    const read = decodeOutput(work.output, first);
    if (read.ok) return read.value;

    // The repair is its own Activity, so what a restart finds is a repair that happened
    // rather than an allowance that has come back.
    const again = yield* Activity.make({
      name: `${work.operation}.repair`,
      success: Schema.NullOr(Schema.String),
      error: AgentUncertain,
      execute: agents
        .repair(launched, read.problem)
        .pipe(
          Effect.flatMap((asked) =>
            asked ? agents.collect(launched, first) : Effect.succeed(null),
          ),
        ),
    });
    if (again === null) {
      return yield* unusable(launched, `did not write ${output} again: ${read.problem}`);
    }
    const repaired = decodeOutput(work.output, again);
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

/**
 * A collection an operator can stop while it is out, and resume back into.
 *
 * The suspension is the wait's own instance, never the workflow's: suspending the run
 * from in here would abandon the collection rather than park it, and the next attempt
 * would have nothing to re-enter. The launch is a separate Activity and is already
 * recorded, so what comes back reattaches instead of starting a second agent.
 */
const stoppable = <A, E>(
  collecting: Effect.Effect<A, E>,
  host: NativeHostApi,
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
const untilStopped = (host: NativeHostApi, runId: string, pollMs: number) =>
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
): Read<Output["Type"]> {
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
  readonly contract: Projection;
  readonly inputs?: Readonly<Record<string, Schema.Json>>;
  readonly cwd?: string;
}

/**
 * What the agent is asked to do, where the answer goes, and what the answer has to be.
 * Pure, so a test and an author can read one without starting anything, and so a replay
 * never builds a different one. The role is the persona, injected at launch the way a
 * Step's is, and reaches a body here as `{{role}}`.
 */
export function promptFor(parts: PromptParts): string {
  const rendered = renderTemplate(parts.instructions, {
    inputs: { ...parts.inputs },
    role: parts.role,
    cwd: parts.cwd ?? "",
    output_path: parts.output,
  });
  return [
    rendered.text.trim(),
    `When you are done, write your result as JSON to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${parts.output}`,
    contractSection(parts.contract),
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
  readonly permissions: PermissionMode;
  readonly compactAtTokens: number;
  readonly pollMs?: number;
  /** How long an Output may take. Past it the work is uncertain, never finished. */
  readonly collectMs?: number;
}

type AgentServices = FileSystem.FileSystem | Path.Path | BunServices;

const DEFAULT_POLL_MS = 2000;
const DEFAULT_COLLECT_MS = 2 * 60 * 60 * 1000;

/**
 * The agents a host really starts: herdr's, through the one sender, with the compaction
 * controls and permissions the operator configured. The host's own services are captured
 * here, so a workflow asks for an agent without asking for a filesystem.
 */
export const agentsLayer = (host: AgentHost): Layer.Layer<NativeAgents, never, AgentServices> =>
  Layer.effect(NativeAgents)(
    Effect.gen(function* () {
      const services = yield* Effect.context<AgentServices>();
      return NativeAgents.of(makeAgents(host, (effect) => Effect.provideContext(effect, services)));
    }),
  );

type Under = <A, E>(effect: Effect.Effect<A, E, AgentServices>) => Effect.Effect<A, E>;

const makeAgents = (host: AgentHost, under: Under): AgentsApi => {
  const dirFor = (runId: string) => `${host.dir}/agents/${runId}`;
  const launchPath = (runId: string, operation: string) =>
    `${dirFor(runId)}/${operation}${LAUNCH_SUFFIX}`;
  const outputFor = (runId: string, operation: string) => `${dirFor(runId)}/${operation}.json`;
  const log = (runId: string, line: string) => append(`${dirFor(runId)}/agents.log`, line);

  const deps: dispatch.DispatcherDeps = {
    stateDir: host.env.stateDir,
    herdr: host.herdr,
    log: (line) => append(`${host.dir}/agents/deliveries.log`, line),
  };

  // A harness nobody here has an adapter for falls back to the operator's own, which is
  // the nearest true thing: the agent still starts, on what this machine is set up for.
  const configured = HARNESSES[host.harness] ?? HARNESSES.claude!;
  const adapterFor = (harness: string) => HARNESSES[harness] ?? configured;

  const entryFor = (about: Launched | AgentAsk, agent: string, paneId: string | null) =>
    dispatch.entryFromLive(deps, {
      role: about.role,
      agent,
      paneId,
      workspaceId: host.env.workspaceId,
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
    const outcome = yield* dispatch
      .transaction(deps, found.entry, (channel) =>
        channel.submit(text, {
          run: about.runId,
          harness: adapterFor(about.harness).id,
          cause: { kind: delivery.kind, ref: delivery.ref },
          mode: delivery.mode ?? "boundary",
          // A native run has no Intent yet, so every delivery about one piece of work
          // shares a causal key: that is what makes the second copy refusable.
          intentVersion: 0,
          attempt: 1,
          requestId: `${about.runId}-${delivery.ref}-${delivery.kind}`,
        }),
      )
      .pipe(Effect.catch((cause) => Effect.succeed(undeliverable(cause))));
    if (outcome.ok) return { sent: true, why: "" };
    // Already in flight about this work: it went out, on whichever attempt got there
    // first. Sending it again is the second copy this ledger exists to prevent.
    if (outcome.reason === "blocked") return { sent: true, why: outcome.detail };
    return { sent: false, why: `${outcome.reason}: ${outcome.detail}` };
  });

  /** A pane, an agent in it, and the registry entry that makes it addressable. */
  const start = Effect.fn("Agents.start")(function* (ask: AgentAsk, agent: string) {
    const adapter = adapterFor(ask.harness ?? host.harness);
    const wanted = ask.permissions ?? undefined;
    const permissions = isPermissionMode(wanted) ? wanted : host.permissions;
    const persona = `${dirFor(ask.runId)}/${ask.operation}.persona.md`;
    yield* write(persona, `${roleBody(ask.role)}\n`);
    yield* withControlLock(
      host.env.stateDir,
      agent,
      Effect.gen(function* () {
        // Installed before the pane opens, so a failed installation leaves no empty tab.
        const controls = yield* installControls(compactionDeps(host, ask.runId), {
          agent,
          harness: adapter.id,
          cwd: ask.cwd,
        });
        const tab = yield* host.herdr.tabCreate({ label: ask.role, cwd: ask.cwd });
        // herdr ignores --cwd on tab create, so the pane is told where it is explicitly.
        yield* host.herdr.paneRun(tab.paneId, `cd ${shellQuote(ask.cwd)}`);
        yield* host.herdr.agentStart({
          name: agent,
          kind: adapter.kind,
          paneId: tab.paneId,
          args: [
            ...startArgs(adapter, ask.model ?? host.model, persona, undefined, permissions),
            ...controls,
          ],
        });
        yield* log(
          ask.runId,
          `${agent}: ${adapter.id} in ${tab.paneId}, permissions ${permissions}`,
        );
        const found = yield* entryFor(ask, agent, tab.paneId);
        if (found.entry !== null) {
          yield* registerAgent(
            yield* registryPath(host.env.stateDir, scopeFor(host.env, ask.cwd)),
            found.entry,
          );
        }
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
        const alive = listing.success.some((one) => one.name === agent);
        if (!alive) yield* start(ask, agent);
        const launched: Launched = {
          agent,
          output: ask.output,
          reused: alive,
          runId: ask.runId,
          operation: ask.operation,
          role: ask.role,
          workflow: ask.workflow,
          harness: ask.harness ?? host.harness,
        };
        const adapter = adapterFor(launched.harness);
        const prefix = personaPrefix(adapter, roleBody(ask.role));
        const text = prefix === "" ? ask.prompt : `${prefix}\n\n${ask.prompt}`;
        // Written before it goes out and never rewritten: what a human reads to see what
        // was actually asked, rather than what a prompt would be built as now.
        yield* write(`${dirFor(ask.runId)}/${ask.operation}.prompt.md`, text);
        // Beside it, the agent this work landed on, so a human steering this run later
        // reaches the agent that has it rather than one derived from a name again.
        yield* write(launchPath(ask.runId, ask.operation), encodeLaunched(launched));
        const asked = yield* deliver(launched, text, { kind: "step", ref: ask.operation });
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
      }).pipe(Effect.catch((cause) => Effect.fail(asUncertain(ask.operation, cause)))),
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
        yield* write(`${dirFor(launched.runId)}/${launched.operation}.repair.md`, text);
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
        return sent.sent;
      }).pipe(
        Effect.catch((cause) =>
          log(
            launched.runId,
            `${launched.agent}: could not be asked to write it again (${reason(cause)})`,
          ).pipe(Effect.as(false)),
        ),
      ),
    );

  /** Every agent this run has launched, oldest first, as the launches recorded them. */
  const launchesOf = (runId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = yield* fs.readDirectory(dirFor(runId)).pipe(Effect.orElseSucceed(() => []));
      const launches: Launched[] = [];
      for (const name of names.filter((one) => one.endsWith(LAUNCH_SUFFIX)).sort()) {
        const text = yield* fs
          .readFileString(`${dirFor(runId)}/${name}`)
          .pipe(Effect.orElseSucceed(() => ""));
        const read = decodeLaunched(text);
        if (read._tag === "Success") launches.push(read.success);
      }
      return launches;
    });

  const steer = (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly operation?: string;
    readonly mode?: DeliveryMode;
  }) =>
    under(
      Effect.gen(function* () {
        const launches = yield* launchesOf(options.runId);
        const wanted = options.operation;
        const launched =
          wanted === undefined ? launches.at(-1) : launches.find((one) => one.operation === wanted);
        if (launched === undefined) {
          const about = wanted === undefined ? "" : ` on "${wanted}"`;
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

  return { outputFor, pollMs: host.pollMs ?? DEFAULT_POLL_MS, launch, collect, repair, steer };
};

const LAUNCH_SUFFIX = ".launch.json";
const LaunchedJson = Schema.fromJsonString(Launched);
const encodeLaunched = Schema.encodeSync(LaunchedJson);
const decodeLaunched = Schema.decodeUnknownResult(LaunchedJson);

/** What a delivery is called in a log: one line of it, so the log stays readable. */
const firstLine = (text: string) => text.split("\n")[0] ?? "";

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
  ports: COMPACTION_PORTS,
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
    permissions: isPermissionMode(defaults.permissions) ? defaults.permissions : "bypass",
    compactAtTokens: defaults.compactAtTokens,
  });
});
