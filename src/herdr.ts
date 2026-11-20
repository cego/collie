// The only channel to this Machine's herdr-core: every agent, the board and chat are core
// terminals, reached through the core client in `src/hc.ts`. Every fact about a running
// agent is behind this one interface, which is what makes the rig's fake core enough to
// test everything above it.

import * as Arr from "effect/Array";
import type { PlatformServices } from "./platform";
import { Data, Deferred, Effect, Option, Queue, Schedule, Schema, Stream } from "effect";
import type { PluginEnv } from "./env";
import { reason } from "./naming";
import { HerdrMachine } from "./peers-model";
import { viaTarget } from "./ssh-argv";
import {
  applyNote,
  connect as connectCore,
  coreSocket,
  snapshotOf,
  type HcError,
  type HcMachine,
  type HcMethod,
  type HcSnapshot,
  type HcTerminal,
} from "./hc";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly detail: string;
  /** Core's refusal as a code — `agent_not_found` and friends. */
  readonly code?: string;
  /**
   * True where core demonstrably answered. Absent where nobody can say whether the request
   * arrived — a socket that would not open or closed mid-exchange. The difference decides
   * whether a delivery is `failed` (core decided) or `unknown` (nobody knows), and only one
   * of those is safe to send again.
   */
  readonly answered?: true;
}> {}

export function herdrFailureReason(cause: unknown): string {
  if (!(cause instanceof HerdrError)) return reason(cause);
  return cause.detail === "" ? cause.message : `${cause.message}: ${cause.detail}`;
}

type HerdrEffect<A> = Effect.Effect<A, HerdrError, PlatformServices>;

/**
 * What core could tell us about a submission: a turn it saw start after this prompt, or
 * no evidence. `pressed`: no turn started, so one Enter was pressed after it.
 */
export type Submission = "observed" | "unobserved" | "pressed";

/** Between turns, as core says so: anything else may be hiding a turn. */
export const isSettled = (status: AgentStatus) => status === "idle" || status === "done";

function agentStatus(value: string): AgentStatus {
  if (value === "idle" || value === "working" || value === "blocked" || value === "done") {
    return value;
  }
  return "unknown";
}

/** A live agent as core lists it: one of Collie's terminals, named after its agent. */
export interface AgentInfo {
  name: string;
  /** Core's address for its terminal. */
  paneId: string;
  status: AgentStatus;
  /** Core's address for this live process, which an incarnation is matched on. */
  terminalId: string;
  /** Where it was started. */
  cwd: string;
  /** Where what runs in it now is, which an agent that changed directory has moved. */
  foregroundCwd: string | null;
}

/**
 * What became of the agents a Run's record still calls running. The record alone is
 * stale-capable metadata, so it is turned into an answer by asking core, which is the
 * authority on what it still has. `unasked` is the honest value everywhere the question
 * could not change what is safe, and nothing was probed.
 */
export type AgentsAlive = "unasked" | "absent" | "live" | "unverified";

/** Core's refusals as the codes the callers read. */
const coreCode = (kind: string) =>
  kind === "blocked"
    ? "agent_blocked"
    : kind === "not_found" || kind === "finished"
      ? "agent_not_found"
      : kind;

const coreFailure = (cause: HcError) => {
  const failed = {
    message: `core ${cause.method} failed`,
    detail: cause.message,
    code: coreCode(cause.kind),
  };
  return cause.kind === "unreachable"
    ? new HerdrError(failed)
    : new HerdrError({ ...failed, answered: true });
};

const coreCall = <M extends HcMethod>(socket: string, method: M, params: Schema.JsonObject) =>
  Effect.scoped(Effect.flatMap(connectCore(socket), (hc) => hc.call(method, params))).pipe(
    Effect.mapError(coreFailure),
  );

/** A machine core keeps, as the Machine Collie pairs with by core's name for it. */
const rosterEntry = (machine: HcMachine): HerdrMachine => ({
  id: machine.name,
  label: machine.name,
  target: machine.via === true ? viaTarget(machine.target) : machine.target,
  session: machine.session ?? "default",
  enabled: true,
});

/** The label that marks a core terminal as one of Collie's agents, naming its Run. */
export const RUN_LABEL = "run";

const isAgentTerminal = (terminal: HcTerminal) =>
  terminal.state === "live" && Boolean(terminal.name) && terminal.labels[RUN_LABEL] !== undefined;

const coreStatus = (terminal: HcTerminal) => agentStatus(terminal.status?.state ?? "");

const coreAgent = (terminal: HcTerminal): AgentInfo => ({
  name: terminal.name ?? terminal.address,
  paneId: terminal.address,
  status: coreStatus(terminal),
  terminalId: terminal.address,
  cwd: terminal.cwd,
  foregroundCwd: terminal.foreground?.cwd ?? null,
});

/** Each core's terminals as its events describe them, for as long as the stream lasts. */
const watching = new Map<string, Deferred.Deferred<{ current: HcSnapshot }, HerdrError>>();

const watched = (socket: string) =>
  Effect.suspend(() => {
    const found = watching.get(socket);
    if (found !== undefined) return Deferred.await(found);
    const ready = Deferred.makeUnsafe<{ current: HcSnapshot }, HerdrError>();
    watching.set(socket, ready);
    const follow = Effect.gen(function* () {
      const hc = yield* connectCore(socket);
      const view = { current: snapshotOf(yield* hc.call("events.subscribe", {})) };
      yield* Deferred.succeed(ready, view);
      for (;;) view.current = applyNote(view.current, yield* Queue.take(hc.notes));
    }).pipe(
      Effect.scoped,
      Effect.mapError(coreFailure),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          if (watching.get(socket) === ready) watching.delete(socket);
          return exit._tag === "Failure"
            ? Deferred.failCause(ready, exit.cause).pipe(Effect.asVoid)
            : Effect.void;
        }),
      ),
    );
    return Effect.forkDetach(follow).pipe(Effect.andThen(Deferred.await(ready)));
  });

export class Herdr {
  constructor(readonly env: PluginEnv) {}

  private onCore<A, R>(use: (socket: string) => Effect.Effect<A, HerdrError, R>) {
    return Effect.flatMap(coreSocket(this.env.raw), use);
  }

  /**
   * An agent started as a core terminal of its own, which ends with nothing that started it.
   *
   * It is given this host's PATH, under whatever `env` names: core finds the program on the
   * PATH it is handed, and its own may be a bare system one — a core another Machine's SSH
   * dial started has no login shell's PATH, and no harness installed under the home.
   */
  agentLaunch(opts: {
    readonly name: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly labels: Readonly<Record<string, string>>;
  }): HerdrEffect<string> {
    const env: Record<string, string> = {};
    if (this.env.raw.PATH !== undefined) env.PATH = this.env.raw.PATH;
    Object.assign(env, opts.env);
    return this.onCore((socket) =>
      coreCall(socket, "terminal.run", {
        name: opts.name,
        argv: [...opts.argv],
        cwd: opts.cwd,
        env,
        labels: { ...opts.labels },
        no_parent: true,
      }).pipe(Effect.map((started) => started.address)),
    );
  }

  /**
   * A tick each time core's events are followed from the start, which a holder that came back
   * is, and on each event `counts` takes.
   */
  private followed(
    counts: (type: string) => boolean,
  ): Stream.Stream<void, never, PlatformServices> {
    const env = this.env;
    const ticks = Stream.unwrap(
      Effect.gen(function* () {
        const hc = yield* connectCore(yield* coreSocket(env.raw));
        yield* hc.call("events.subscribe", {});
        return Stream.concat(
          Stream.succeed(undefined),
          Stream.fromQueue(hc.notes).pipe(
            Stream.filter(
              (note) =>
                note.method === "missed" || (note.method === "event" && counts(note.params.type)),
            ),
            Stream.as(undefined),
          ),
        );
      }),
    );
    return ticks.pipe(
      Stream.catch(() => Stream.empty),
      Stream.repeat(Schedule.spaced("1 second")),
    );
  }

  /** A tick whenever a terminal on this Machine's core may have gone. */
  terminalsEnded(): Stream.Stream<void, never, PlatformServices> {
    return this.followed((type) => ["finished", "lost", "removed"].includes(type));
  }

  /** A tick whenever anything about this Machine's terminals may have changed. */
  changes(): Stream.Stream<void, never, PlatformServices> {
    return this.followed(() => true);
  }

  /** Whether this Machine's core has a live terminal named `name`. */
  terminalLive(name: string): HerdrEffect<boolean> {
    return this.onCore((socket) =>
      coreCall(socket, "terminal.list", {}).pipe(
        Effect.map((listed) =>
          Arr.some(listed.terminals, (one) => one.state === "live" && one.name === name),
        ),
      ),
    );
  }

  /**
   * One `terminal.send`. A send core saw not start a turn gets one Enter, never the text
   * again: the work would run twice.
   */
  agentPrompt(target: string, text: string): HerdrEffect<Submission> {
    return this.onCore((socket) =>
      Effect.gen(function* () {
        const sent = yield* coreCall(socket, "terminal.send", { terminal: target, text });
        if (sent.started === true) return "observed";
        if (sent.started !== false) return "unobserved";
        yield* coreCall(socket, "terminal.keys", { terminal: target, keys: ["enter"] });
        return "pressed";
      }),
    );
  }

  /** One Enter, for text already in the agent's prompt box. */
  agentPressEnter(target: string): HerdrEffect<void> {
    return this.agentSendKeys(target, ["enter"]);
  }

  /**
   * Raw keys into an agent's terminal. Core answering says the keys were sent, which is not
   * the same as the harness having acted on them: nothing here reports an agent stopped.
   */
  agentSendKeys(target: string, keys: ReadonlyArray<string>): HerdrEffect<void> {
    return this.onCore((socket) =>
      coreCall(socket, "terminal.keys", { terminal: target, keys: [...keys] }).pipe(Effect.asVoid),
    );
  }

  /** Collie's live agents on this Machine's core. */
  agentList(): HerdrEffect<AgentInfo[]> {
    return this.onCore((socket) =>
      coreCall(socket, "terminal.list", {}).pipe(
        Effect.map((listed) => Arr.map(Arr.filter(listed.terminals, isAgentTerminal), coreAgent)),
      ),
    );
  }

  /** The Machines this one may pair with, by core's name for each. */
  machineList() {
    return this.onCore((socket) =>
      coreCall(socket, "machine.list", {}).pipe(
        Effect.map((listed) => Arr.map(listed.machines, rosterEntry)),
      ),
    );
  }

  /** Adds a Machine to core, which reaches it with `via` and never installs hc there. */
  machineAdd(name: string, via: string) {
    return this.onCore((socket) => coreCall(socket, "machine.add", { name, via }));
  }

  /** Has core dial a Machine now rather than at its next retry. */
  machineDial(name: string) {
    return this.onCore((socket) => coreCall(socket, "machine.connect", { machine: name }));
  }

  /** Has core forget a Machine; its terminals keep running there. */
  machineRemove(name: string) {
    return this.onCore((socket) => coreCall(socket, "machine.rm", { machine: name }));
  }

  /**
   * What has become of the agents a Run still has running. One `live` is enough to make
   * a resume unsafe — it would reset the Step under an agent still writing in that
   * worktree — and so is one answer core could not give: "I could not ask" is not
   * evidence that nothing is there. Only when every one of them is conclusively gone is
   * the answer `absent`. An agent core still has but calls `done` counts as gone.
   */
  agentsAlive(names: ReadonlyArray<string>): Effect.Effect<AgentsAlive, never, PlatformServices> {
    const ask = (name: string) => this.agentStatus(name);
    return Effect.gen(function* () {
      if (names.length === 0) return "absent" as const;
      let verdict: AgentsAlive = "absent";
      for (const name of names) {
        const status = yield* ask(name).pipe(
          Effect.catch((cause) =>
            Effect.succeed(cause.code === "agent_not_found" ? ("gone" as const) : null),
          ),
        );
        // Idle is alive: the agent holds its name and its terminal, so a Driver that started
        // another under that name — or restarted its step beneath it — would collide.
        if (status === "working" || status === "blocked" || status === "idle")
          return "live" as const;
        if (status === "gone" || status === "done") continue;
        verdict = "unverified";
      }
      return verdict;
    });
  }

  /** As core's events last said: the status its harness reported through OSC 7501. */
  agentStatus(target: string): HerdrEffect<AgentStatus> {
    return this.onCore((socket) =>
      Effect.gen(function* () {
        const view = yield* watched(socket);
        const named = Arr.filter(
          [...view.current.terminals.values()],
          (one) => one.name === target,
        );
        // An agent started again shares its name with the incarnation core lost.
        const seen = Arr.findFirst(named, (one) => one.state === "live").pipe(
          Option.orElse(() => Arr.head(named)),
          Option.getOrUndefined,
        );
        const terminal = seen ?? (yield* coreCall(socket, "terminal.get", { terminal: target }));
        if (terminal.state !== "live")
          return yield* new HerdrError({
            message: `core has no live ${target}`,
            detail: terminal.state,
            code: "agent_not_found",
            answered: true,
          });
        return coreStatus(terminal);
      }),
    );
  }

  /** The pid of the program in the live terminal at `address`, or null where core names none. */
  terminalRoot(address: string): HerdrEffect<number | null> {
    return this.onCore((socket) =>
      coreCall(socket, "terminal.list", {}).pipe(
        Effect.map(
          (listed) =>
            Option.getOrUndefined(
              Arr.findFirst(
                listed.terminals,
                (one) => one.state === "live" && one.address === address,
              ),
            )?.pid ?? null,
        ),
      ),
    );
  }

  /** Ends the terminal at `address`, and the program in it. */
  terminalKill(address: string): HerdrEffect<void> {
    return this.onCore((socket) =>
      coreCall(socket, "terminal.kill", { terminal: address }).pipe(Effect.asVoid),
    );
  }
}
