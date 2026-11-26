import * as Arr from "effect/Array";
import type { PlatformServices } from "./platform";
import type { Schema } from "effect";
import { Config, Data, Deferred, Duration, Effect, Option, Queue, Schedule, Stream } from "effect";
import type { PluginEnv } from "./env";
import { reason } from "./naming";
import type { HerdrMachine } from "./peers-model";
import { viaTarget } from "./ssh-argv";
import { applyNote, connect as connectCore, coreSocket, snapshotOf } from "./hc";
import type { HcError, HcMachine, HcMethod, HcSnapshot, HcTerminal } from "./hc";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly detail: string;
  readonly code?: string;
  // WARNING: Absent where nobody knows whether the request arrived: only a failed send, not an unknown one, is safe to resend.
  readonly answered?: true;
}> {}

export function herdrFailureReason(cause: unknown) {
  if (!(cause instanceof HerdrError)) {
    return reason(cause);
  }
  const returned: string =
    cause.detail === "" ? cause.message : `${cause.message}: ${cause.detail}`;
  return returned;
}

type HerdrEffect<A> = Effect.Effect<A, HerdrError, PlatformServices>;

export type Submission = "observed" | "unobserved" | "pressed";

export const isSettled = (status: AgentStatus) => status === "idle" || status === "done";

function agentStatus(value: string) {
  if (value === "idle" || value === "working" || value === "blocked" || value === "done") {
    const returned: AgentStatus = value;
    return returned;
  }
  const returned: AgentStatus = "unknown";
  return returned;
}

export interface AgentInfo {
  name: string;
  paneId: string;
  status: AgentStatus;
  terminalId: string;
  cwd: string;
  foregroundCwd: string | null;
}

export type AgentsAlive = "unasked" | "absent" | "live" | "unverified";

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

const rosterEntry: (machine: HcMachine) => HerdrMachine = (machine) => ({
  id: machine.name,
  label: machine.name,
  target: machine.via === true ? viaTarget(machine.target) : machine.target,
  session: machine.session ?? "default",
  enabled: true,
});

export const RUN_LABEL = "run";

const ROSTER_WAIT = "5 seconds" as const;

const rosterWait = Config.Duration("COLLIE_ROSTER_READ_WITHIN").pipe(
  Config.withDefault(Duration.fromInputUnsafe(ROSTER_WAIT)),
  // WARNING: a typed failure, not a defect, so a Machine list is still read from the other side.
  Effect.mapError(
    () =>
      new HerdrError({
        message: "core machine.list has no deadline",
        detail: "COLLIE_ROSTER_READ_WITHIN is not a duration",
      }),
  ),
  Effect.filterOrFail(
    (wait) => Duration.isFinite(wait) && Duration.toMillis(wait) > 0,
    (wait) =>
      new HerdrError({
        message: "core machine.list has no deadline",
        detail: `COLLIE_ROSTER_READ_WITHIN is ${Duration.format(wait)}, not a finite positive duration`,
      }),
  ),
);

const isAgentTerminal = (terminal: HcTerminal) =>
  terminal.state === "live" && Boolean(terminal.name) && terminal.labels[RUN_LABEL] !== undefined;

const coreStatus = (terminal: HcTerminal) => agentStatus(terminal.status?.state ?? "");

const coreAgent: (terminal: HcTerminal) => AgentInfo = (terminal) => ({
  name: terminal.name ?? terminal.address,
  paneId: terminal.address,
  status: coreStatus(terminal),
  terminalId: terminal.address,
  cwd: terminal.cwd,
  foregroundCwd: terminal.foreground?.cwd ?? null,
});

const watching = new Map<string, Deferred.Deferred<{ current: HcSnapshot }, HerdrError>>();

const watched = (socket: string) =>
  Effect.suspend(() => {
    const found = watching.get(socket);
    if (found !== undefined) {
      return Deferred.await(found);
    }
    const ready = Deferred.makeUnsafe<{ current: HcSnapshot }, HerdrError>();
    watching.set(socket, ready);
    const follow = Effect.gen(function* () {
      const hc = yield* connectCore(socket);
      const view = { current: snapshotOf(yield* hc.call("events.subscribe", {})) };
      yield* Deferred.succeed(ready, view);
      for (;;) {
        view.current = applyNote(view.current, yield* Queue.take(hc.notes));
      }
    }).pipe(
      Effect.scoped,
      Effect.mapError(coreFailure),
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          if (watching.get(socket) === ready) {
            watching.delete(socket);
          }
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

  // WARNING: Given this host's PATH: a core started over SSH has no login shell's PATH.
  agentLaunch(opts: {
    readonly name: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly labels: Readonly<Record<string, string>>;
  }) {
    const env: Record<string, string> = {};
    if (this.env.raw.PATH !== undefined) {
      env.PATH = this.env.raw.PATH;
    }
    Object.assign(env, opts.env);
    const returned: HerdrEffect<string> = this.onCore((socket) =>
      coreCall(socket, "terminal.run", {
        name: opts.name,
        argv: [...opts.argv],
        cwd: opts.cwd,
        env,
        labels: { ...opts.labels },
        no_parent: true,
      }).pipe(Effect.map((started) => started.address)),
    );
    return returned;
  }

  private followed(counts: (type: string) => boolean) {
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
    const returned: Stream.Stream<void, never, PlatformServices> = ticks.pipe(
      Stream.catch(() => Stream.empty),
      Stream.repeat(Schedule.spaced("1 second")),
    );
    return returned;
  }

  terminalsEnded() {
    const returned: Stream.Stream<void, never, PlatformServices> = this.followed((type) =>
      ["finished", "lost", "removed"].includes(type),
    );
    return returned;
  }

  changes() {
    const returned: Stream.Stream<void, never, PlatformServices> = this.followed(() => true);
    return returned;
  }

  terminalLive(name: string) {
    const returned: HerdrEffect<boolean> = this.onCore((socket) =>
      coreCall(socket, "terminal.list", {}).pipe(
        Effect.map((listed) =>
          Arr.some(listed.terminals, (one) => one.state === "live" && one.name === name),
        ),
      ),
    );
    return returned;
  }

  // WARNING: A send that started no turn gets one Enter, never the text again: the work would run twice.
  agentPrompt(target: string, text: string) {
    const returned: HerdrEffect<Submission> = this.onCore((socket) =>
      Effect.gen(function* () {
        const sent = yield* coreCall(socket, "terminal.send", { terminal: target, text });
        if (sent.started === true) {
          return "observed";
        }
        if (sent.started !== false) {
          return "unobserved";
        }
        yield* coreCall(socket, "terminal.keys", { terminal: target, keys: ["enter"] });
        return "pressed";
      }),
    );
    return returned;
  }

  agentPressEnter(target: string) {
    const returned: HerdrEffect<void> = this.agentSendKeys(target, ["enter"]);
    return returned;
  }

  agentSendKeys(target: string, keys: ReadonlyArray<string>) {
    const returned: HerdrEffect<void> = this.onCore((socket) =>
      coreCall(socket, "terminal.keys", { terminal: target, keys: [...keys] }).pipe(Effect.asVoid),
    );
    return returned;
  }

  agentList() {
    const returned: HerdrEffect<Array<AgentInfo>> = this.onCore((socket) =>
      coreCall(socket, "terminal.list", {}).pipe(
        Effect.map((listed) => Arr.map(Arr.filter(listed.terminals, isAgentTerminal), coreAgent)),
      ),
    );
    return returned;
  }

  machineList() {
    const ask = (within: Duration.Duration) =>
      this.onCore((socket) =>
        coreCall(socket, "machine.list", {}).pipe(
          Effect.timeoutOrElse({
            duration: within,
            orElse: () =>
              Effect.fail(
                new HerdrError({
                  message: "core machine.list did not answer",
                  detail: `no reply within ${Duration.format(within)}`,
                }),
              ),
          }),
          Effect.map((listed) => Arr.map(listed.machines, rosterEntry)),
        ),
      );
    return Effect.flatMap(rosterWait, ask);
  }

  machineAdd(name: string, via: string) {
    return this.onCore((socket) => coreCall(socket, "machine.add", { name, via }));
  }

  machineDial(name: string) {
    return this.onCore((socket) => coreCall(socket, "machine.connect", { machine: name }));
  }

  machineRemove(name: string) {
    return this.onCore((socket) => coreCall(socket, "machine.rm", { machine: name }));
  }

  // WARNING: Anything that could not be asked may be live: 'could not ask' is not 'absent'.
  agentsAlive(names: ReadonlyArray<string>) {
    const ask = (name: string) => this.agentStatus(name);
    const returned: Effect.Effect<AgentsAlive, never, PlatformServices> = Effect.gen(function* () {
      if (names.length === 0) {
        return "absent" as const;
      }
      let verdict: AgentsAlive = "absent";
      for (const name of names) {
        const status = yield* ask(name).pipe(
          Effect.catch((cause) =>
            Effect.succeed(cause.code === "agent_not_found" ? ("gone" as const) : null),
          ),
        );
        // WARNING: Idle is alive: it holds its name and terminal, so a new start under that name would collide.
        if (status === "working" || status === "blocked" || status === "idle") {
          return "live" as const;
        }
        if (status === "gone" || status === "done") {
          continue;
        }
        verdict = "unverified";
      }
      return verdict;
    });
    return returned;
  }

  agentStatus(target: string) {
    const returned: HerdrEffect<AgentStatus> = this.onCore((socket) =>
      Effect.gen(function* () {
        const view = yield* watched(socket);
        const named = Arr.filter(
          [...view.current.terminals.values()],
          (one) => one.name === target,
        );
        // WARNING: A restarted agent shares its name with the incarnation core lost: prefer the live one.
        const seen = Arr.findFirst(named, (one) => one.state === "live").pipe(
          Option.orElse(() => Arr.head(named)),
          Option.getOrUndefined,
        );
        const terminal = seen ?? (yield* coreCall(socket, "terminal.get", { terminal: target }));
        if (terminal.state !== "live") {
          return yield* new HerdrError({
            message: `core has no live ${target}`,
            detail: terminal.state,
            code: "agent_not_found",
            answered: true,
          });
        }
        return coreStatus(terminal);
      }),
    );
    return returned;
  }

  terminalRoot(address: string) {
    const returned: HerdrEffect<number | null> = this.onCore((socket) =>
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
    return returned;
  }

  terminalKill(address: string) {
    const returned: HerdrEffect<void> = this.onCore((socket) =>
      coreCall(socket, "terminal.kill", { terminal: address }).pipe(Effect.asVoid),
    );
    return returned;
  }
}
