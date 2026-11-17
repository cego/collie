// The one way a Run's agent ends (ADR-0059 D1, D4). Every end takes the same steps, in
// this order:
//
// 1. prove the incarnation is this Run's, from its launch record;
// 2. stop it where its work runs;
// 3. require it to be Quiet;
// 4. end its core terminal;
// 5. log the end on the Run's log.
//
// In the caller's mode, steps 4 and 5 are the caller's: it ends the terminals itself once
// every agent has answered, then logs each end with `endedLine`.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Data, Effect, FileSystem } from "effect";
import { RELAUNCH, RunRecords } from "./run-records";
import { STOP_WAIT_MS, notStopped, stopAgent, type CompactionDeps } from "./compaction";
import type { AgentInfo, Herdr, HerdrError } from "./herdr";
import { launchDir, readLaunches, stemOf, withRelaunchLock, type Launched } from "./launches";
import { reason } from "./naming";

export interface EndDeps extends Pick<CompactionDeps, "ports" | "stateDir" | "log"> {
  readonly herdr: Pick<Herdr, "agentList" | "terminalKill">;
  readonly stopMs?: number;
}

/** Who closes the agent's pane: this module, or the caller once every agent has answered. */
export type Closes = "close" | "caller";

export type Ended =
  /** `ended` is false where nothing of this Run's was there to end. */
  | { readonly _tag: "Closed"; readonly ended: boolean }
  /** `locked` is why no stop could be made, where none could. */
  | { readonly _tag: "NotQuiet"; readonly reason: string; readonly locked?: string }
  | { readonly _tag: "Unprovable"; readonly reason: string }
  /** Only where the caller closes: another process has the agent's name, so its panes stay. */
  | { readonly _tag: "Replaced"; readonly reason: string };

export const endedLine = (agent: string, why: string) => `${agent} ended: ${why}`;

export const UNPROVABLE = "cannot be proven to be this Run's, so it was left running";

/** Core would not list its agents, so nothing about this one can be proved. */
export class AgentsUnlisted extends Data.TaggedError("AgentsUnlisted")<{
  readonly cause: HerdrError;
}> {}

export class PaneOpen extends Data.TaggedError("PaneOpen")<{
  readonly paneId: string;
  readonly cause: HerdrError;
}> {}

/**
 * Ends one agent of a Run. `listed` is core's agent list where the caller has already
 * read it for several ends.
 */
export const endAgent = Effect.fn("AgentEnd.end")(function* (
  deps: EndDeps,
  launched: Ending,
  why: string,
  closes: Closes,
  listed?: ReadonlyArray<AgentInfo>,
) {
  const runId = launched.runId;
  if (runId === undefined) return yield* ending(deps, launched, why, closes, listed);
  return yield* withRelaunchLock(
    deps.stateDir,
    runId,
    Effect.succeed<Ended>({
      _tag: "NotQuiet",
      reason: `${launched.agent} could not be stopped while core's recovery starts it again`,
    }),
    Effect.gen(function* () {
      // Recovery rewrites the record with the incarnation it started.
      const operation = launched.operation;
      const stem = operation === undefined ? null : stemOf({ ...launched, operation });
      const now = Option.getOrUndefined(
        Arr.findLast(
          yield* readLaunches(runId).pipe(Effect.orElseSucceed(() => [])),
          (one) => stemOf(one) === stem,
        ),
      );
      if (now === undefined || now.terminalId === launched.terminalId)
        return yield* ending(deps, launched, why, closes, listed);
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

type Ending = Pick<Launched, "agent" | "terminalId" | "agentSession"> & {
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
  if (one !== undefined && launched.terminalId === undefined)
    return { _tag: "Unprovable", reason: `${launched.agent} ${UNPROVABLE}` } satisfies Ended;
  if (one !== undefined && one.terminalId !== launched.terminalId)
    return closes === "caller"
      ? ({
          _tag: "Replaced",
          reason: `${launched.agent} was started again since, and is not this Run's to end`,
        } satisfies Ended)
      : ({ _tag: "Closed", ended: false } satisfies Ended);

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
  if (reached.success !== null && reached.success.state !== "quiet")
    return {
      _tag: "NotQuiet",
      reason: notStopped(launched.agent, reached.success, reached.success.target),
    } satisfies Ended;

  // Ended on purpose, so nothing starts it again.
  const runId = launched.runId;
  if (runId !== undefined)
    yield* RunRecords.use((records) => records.setControl(RELAUNCH, runId, null, launched.agent));
  if (one !== undefined && closes === "close")
    yield* deps.herdr
      .terminalKill(one.paneId)
      .pipe(Effect.mapError((cause) => new PaneOpen({ paneId: one.paneId, cause })));
  const ended = one !== undefined || reached.success !== null;
  if (ended && closes === "close")
    yield* deps.log(endedLine(launched.agent, why)).pipe(Effect.ignore);
  return { _tag: "Closed", ended } satisfies Ended;
});

/** A Run's log, for an end its Agents service does not make. */
export const runLog = (stateDir: string, runId: string) => (line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = launchDir(stateDir, runId);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/agents.log`, `${line}\n`, { flag: "a" });
  });
