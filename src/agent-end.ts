import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, Data, Effect, FileSystem, Schedule } from "effect";
import { RELAUNCH, RunRecords } from "./run-records";
import { STOP_WAIT_MS, cancelCompaction, notStopped, stopAgent } from "./compaction";
import type { CompactionDeps, SeenProcess } from "./compaction";
import { processOf, sessionOf, startedOf, stillRunning, terminate } from "./processes";
import type { AgentInfo, Herdr, HerdrError } from "./herdr";
import { launchDir, readLaunches, stemOf, withRelaunchLock } from "./launches";
import type { Launched } from "./launches";
import { reason } from "./naming";

export interface EndDeps extends Pick<CompactionDeps, "ports" | "stateDir" | "log" | "account"> {
  readonly herdr: Pick<Herdr, "agentList" | "terminalKill" | "terminalRoot">;
  readonly stopMs?: number;
}

export type Closes = "close" | "caller";

export type Ended =
  | { readonly _tag: "Closed"; readonly ended: boolean }
  | {
      readonly _tag: "NotQuiet";
      readonly reason: string;
      readonly locked?: string;
      readonly left?: ReadonlyArray<SeenProcess>;
    }
  | { readonly _tag: "Unprovable"; readonly reason: string }
  // WARNING: only where the caller closes: another process holds the agent's name, so its panes stay.
  | { readonly _tag: "Replaced"; readonly reason: string };

export const endedLine = (agent: string, why: string) => `${agent} ended: ${why}`;

export const UNPROVABLE = "cannot be proven to be this Run's, so it was left running";

export class AgentsUnlisted extends Data.TaggedError("AgentsUnlisted")<{
  readonly cause: HerdrError;
}> {}

export class PaneOpen extends Data.TaggedError("PaneOpen")<{
  readonly paneId: string;
  readonly cause: HerdrError;
}> {}

export const endAgent = Effect.fn("AgentEnd.end")(function* (
  deps: EndDeps,
  launched: Ending,
  why: string,
  closes: Closes,
  listed?: ReadonlyArray<AgentInfo>,
) {
  const runId = launched.runId;
  if (runId === undefined) {
    return yield* ending(deps, launched, why, closes, listed);
  }
  return yield* withRelaunchLock(
    deps.stateDir,
    runId,
    Effect.succeed<Ended>({
      _tag: "NotQuiet",
      reason: `${launched.agent} could not be stopped while core's recovery starts it again`,
    }),
    Effect.gen(function* () {
      const operation = launched.operation;
      const stem = operation === undefined ? null : stemOf({ ...launched, operation });
      const now = Option.getOrUndefined(
        Arr.findLast(
          yield* readLaunches(runId).pipe(Effect.orElseSucceed(() => [])),
          (one) => stemOf(one) === stem,
        ),
      );
      if (now === undefined || now.terminalId === launched.terminalId) {
        return yield* ending(deps, launched, why, closes, listed);
      }
      return yield* ending(
        deps,
        { ...launched, terminalId: now.terminalId, agentSession: now.agentSession },
        why,
        closes,
      );
    }),
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => unlocked(launched.agent, cause),
      SchemaError: (cause) => unlocked(launched.agent, cause),
    }),
  );
});

const unlocked = (agent: string, cause: unknown) =>
  Effect.succeed<Ended>({
    _tag: "NotQuiet",
    reason: `${agent} could not be stopped (${reason(cause)})`,
    locked: reason(cause),
  });

type Ending = Pick<Launched, "agent" | "terminalId" | "agentSession" | "root"> & {
  readonly harness?: string;
  readonly runId?: string;
  readonly operation?: string;
  readonly sequence?: number;
};

const ending = Effect.fnUntraced(function* (
  deps: EndDeps,
  launched: Ending,
  why: string,
  closes: Closes,
  listed?: ReadonlyArray<AgentInfo>,
) {
  const agents =
    listed ??
    (yield* deps.herdr.agentList().pipe(Effect.mapError((cause) => new AgentsUnlisted({ cause }))));
  const one = Option.getOrUndefined(
    Arr.findFirst(agents, (agent) => agent.name === launched.agent),
  );
  if (one !== undefined && launched.terminalId === undefined) {
    return { _tag: "Unprovable", reason: `${launched.agent} ${UNPROVABLE}` } satisfies Ended;
  }
  if (one !== undefined && one.terminalId !== launched.terminalId) {
    return closes === "caller"
      ? ({
          _tag: "Replaced",
          reason: `${launched.agent} was started again since, and is not this Run's to end`,
        } satisfies Ended)
      : ({ _tag: "Closed", ended: false } satisfies Ended);
  }

  // WARNING: read before the stop, while a harness that answers only alive can still name its records.
  if (deps.account !== undefined) {
    yield* deps.account(launched.agent);
  }
  const reached = yield* stopAgent(deps, launched.agent, deps.stopMs ?? STOP_WAIT_MS).pipe(
    Effect.result,
  );
  if (reached._tag === "Failure") {
    const locked = reason(reached.failure);
    return {
      _tag: "NotQuiet",
      reason: `${launched.agent} could not be stopped (${locked})`,
      locked,
    } satisfies Ended;
  }
  if (reached.success !== null && reached.success.state !== "quiet") {
    return {
      _tag: "NotQuiet",
      reason: notStopped(launched.agent, reached.success, reached.success.target),
      left: reached.success.left,
    } satisfies Ended;
  }

  const pane =
    reached.success === null && closes === "close"
      ? yield* paneProcesses(deps, launched.root, one?.paneId)
      : null;

  if (deps.account !== undefined) {
    yield* deps.account(launched.agent);
  }
  // WARNING: ended on purpose, so nothing may start it again.
  const runId = launched.runId;
  if (runId !== undefined) {
    yield* RunRecords.use((records) => records.setControl(RELAUNCH, runId, null, launched.agent));
  }
  if (one !== undefined && closes === "close") {
    yield* deps.herdr
      .terminalKill(one.paneId)
      .pipe(Effect.mapError((cause) => new PaneOpen({ paneId: one.paneId, cause })));
  }
  const stopMs = deps.stopMs ?? STOP_WAIT_MS;
  const unread = pane !== null && "unread" in pane;
  // WARNING: an unread pane is nothing Collie can say has stopped, so nothing of it is cancelled and no work is handed on.
  if (unread) {
    return { _tag: "Unprovable", reason: `${launched.agent} ${pane.unread}` } satisfies Ended;
  }
  const left =
    pane === null || "empty" in pane || unread
      ? []
      : yield* settled(pane.roots, pane.noted, stopMs);
  // WARNING: only once nothing it started is left running, or an agent still able to finish has its attempt cancelled under it.
  if (left.length === 0) {
    yield* cancelCompaction(deps, launched.agent, why).pipe(Effect.ignore);
  }
  if (left.length > 0) {
    return {
      _tag: "NotQuiet",
      reason: `${launched.agent} is not Quiet: ${Arr.join(
        Arr.map(left, (one) => `pid ${one.pid}`),
        ", ",
      )} of its pane still running ${Math.round(stopMs / 1000)}s after it closed`,
      left,
    } satisfies Ended;
  }
  const ended =
    one !== undefined ||
    reached.success !== null ||
    (pane !== null && "noted" in pane && (pane.noted?.length ?? 0) > 0);
  if (ended && closes === "close") {
    if (pane !== null && "empty" in pane) {
      yield* deps.log(`${launched.agent}: Quiet not confirmed: ${pane.empty}`).pipe(Effect.ignore);
    }
    yield* deps.log(endedLine(launched.agent, why)).pipe(Effect.ignore);
  }
  return { _tag: "Closed", ended } satisfies Ended;
});

// WARNING: a root core could not be asked for is not a pane with nothing in it; only a process that is gone is.
export const rootRead = (herdr: Pick<Herdr, "terminalRoot">, address: string) =>
  Effect.gen(function* () {
    const read = yield* herdr.terminalRoot(address).pipe(Effect.result);
    if (read._tag === "Failure") {
      return { unread: `its pane's root could not be read (${reason(read.failure)})` } as const;
    }
    const pid = read.success;
    if (pid === null) {
      return { none: true } as const;
    }
    const started = yield* startedOf(pid);
    return started === null ? ({ none: true } as const) : ({ pid, started } as const);
  });

export const rootOf = (herdr: Pick<Herdr, "terminalRoot">, address: string) =>
  Effect.map(rootRead(herdr, address), (read) =>
    "unread" in read || "none" in read ? undefined : { pid: read.pid, started: read.started },
  );

const HANGUP_GRACE_MS = 2000;

// WARNING: a root whose pid now belongs to another process names nothing.
const paneProcesses = Effect.fnUntraced(function* (
  deps: Pick<EndDeps, "herdr">,
  recorded: SeenProcess | undefined,
  paneId: string | undefined,
) {
  const read =
    paneId === undefined ? ({ none: true } as const) : yield* rootRead(deps.herdr, paneId);
  if ("unread" in read) {
    return { unread: read.unread };
  }
  const current = "none" in read ? undefined : { pid: read.pid, started: read.started };
  const named = [
    ...(recorded === undefined ? [] : [recorded]),
    ...(current === undefined || current.pid === recorded?.pid ? [] : [current]),
  ];
  if (named.length === 0) {
    return { empty: "no process of its pane could be named" };
  }
  const roots: Array<SeenProcess> = [];
  const noted: Array<SeenProcess> = [];
  for (const root of named) {
    const now = yield* processOf(root.pid);
    if (now !== null && now.started !== root.started) {
      continue;
    }
    const session = yield* sessionOf(root.pid).pipe(Effect.result);
    if (session._tag === "Failure") {
      return {
        unread: `its pane's processes could not be listed (${reason(session.failure)})`,
      };
    }
    roots.push(root);
    if (now !== null) {
      noted.push(root);
    }
    for (const one of session.success) {
      noted.push({ pid: one.pid, started: one.started });
    }
  }
  if (roots.length === 0) {
    return { unread: `its pane's root, pid ${named[0]!.pid}, is now another process` };
  }
  return { roots, noted };
});

// WARNING: each process still running after the hang-up grace gets exactly one SIGTERM.
const settled = Effect.fnUntraced(function* (
  roots: ReadonlyArray<SeenProcess>,
  noted: ReadonlyArray<SeenProcess>,
  budgetMs: number,
) {
  const start = yield* Clock.currentTimeMillis;
  const running = Effect.gen(function* () {
    const found = [...noted];
    // WARNING: a process started as the pane closed is in its session too, while its root's pid is not reused.
    for (const root of roots) {
      const now = yield* processOf(root.pid);
      if (now !== null && now.started !== root.started) {
        continue;
      }
      for (const one of yield* sessionOf(root.pid).pipe(Effect.orElseSucceed(() => []))) {
        found.push({ pid: one.pid, started: one.started });
      }
    }
    const distinct = Arr.dedupeWith(
      found,
      (one, other) => one.pid === other.pid && one.started === other.started,
    );
    return yield* Effect.filter(distinct, stillRunning);
  });
  const until = (end: number) =>
    running.pipe(
      Effect.repeat({
        until: (left) => left.length === 0,
        schedule: Schedule.spaced(50).pipe(Schedule.while(({ now }) => now < end)),
      }),
    );
  const hungUp = yield* until(start + Math.min(HANGUP_GRACE_MS, budgetMs));
  if (hungUp.length === 0) {
    return hungUp;
  }
  for (const one of hungUp) {
    yield* terminate(one.pid);
  }
  return yield* until(
    Math.max(start + budgetMs, (yield* Clock.currentTimeMillis) + HANGUP_GRACE_MS),
  );
});

export const runLog = (stateDir: string, runId: string) => (line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = launchDir(stateDir, runId);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/agents.log`, `${line}\n`, { flag: "a" });
  });
