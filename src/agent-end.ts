// The one way a Run's agent ends (ADR-0059 D1, D4). Every end takes the same steps, in
// this order:
//
// 1. prove the incarnation is this Run's, from its launch record;
// 2. stop it where its work runs;
// 3. require it to be Quiet;
// 4. keep its Task's workspace, where the caller wants it kept;
// 5. close its pane;
// 6. log the end on the Run's log.
//
// In the caller's mode, steps 4 to 6 are the caller's: it closes the panes itself once
// every agent has answered, then logs each end with `endedLine`. Ticket 07's unit stop goes
// after step 5, or after the caller's own close; ticket 08's Closure is written with step 6.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Data, Effect, FileSystem, Result } from "effect";
import type { PlatformServices } from "./platform";
import { STOP_WAIT_MS, notStopped, stopAgent, type CompactionDeps } from "./compaction";
import type { AgentInfo, Herdr, HerdrError, PaneInfo } from "./herdr";
import { launchDir, sameSession, type Launched } from "./launches";
import { reason } from "./naming";
import { readTask, taskOfWorkspace, withTaskLock, writeTask } from "./task";

export interface EndDeps extends Pick<CompactionDeps, "ports" | "stateDir" | "log"> {
  readonly herdr: Pick<Herdr, "agentList" | "paneList" | "paneClose" | "tabCreate">;
  /** Where a shell kept open for a workspace starts, where its pane names no directory. */
  readonly cwd: string;
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

/** herdr would not list its agents, so nothing about this one can be proved. */
export class AgentsUnlisted extends Data.TaggedError("AgentsUnlisted")<{
  readonly cause: HerdrError;
}> {}

export class PaneOpen extends Data.TaggedError("PaneOpen")<{
  readonly paneId: string;
  readonly cause: HerdrError;
}> {}

/**
 * Ends one agent of a Run. `listed` is herdr's agent list where the caller has already
 * read it for several ends.
 */
export const endAgent = Effect.fn("AgentEnd.end")(function* (
  deps: EndDeps,
  launched: Pick<Launched, "agent" | "terminalId" | "agentSession"> & { readonly harness?: string },
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
  const restored =
    one !== undefined && one.terminalId !== null && one.terminalId === launched.terminalId
      ? undefined
      : yield* restoredPane(deps, launched);
  if (restored === undefined) {
    if (one !== undefined && (launched.terminalId === undefined || one.terminalId === null))
      return { _tag: "Unprovable", reason: `${launched.agent} ${UNPROVABLE}` } satisfies Ended;
    if (one !== undefined && one.terminalId !== launched.terminalId)
      return closes === "caller"
        ? ({
            _tag: "Replaced",
            reason: `${launched.agent} was started again since, and is not this Run's to end`,
          } satisfies Ended)
        : ({ _tag: "Closed", ended: false } satisfies Ended);
  }
  const paneId = restored?.paneId ?? one?.paneId;
  // Another agent started on the name since has the controls kept under it.
  const theirs = restored !== undefined && one !== undefined && one.paneId !== restored.paneId;
  // Closing the pane stops only a harness whose work is in it.
  if (
    theirs &&
    (launched.harness === undefined || deps.ports[launched.harness]?.stop !== undefined)
  )
    return {
      _tag: "NotQuiet",
      reason: `${launched.agent} could not be stopped (its controls are those of the agent started on its name since)`,
    } satisfies Ended;

  const reached = theirs
    ? Result.succeed(null)
    : yield* stopAgent(deps, launched.agent, deps.stopMs ?? STOP_WAIT_MS).pipe(Effect.result);
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

  if (paneId !== undefined && closes === "close") {
    // Core has no workspace to keep.
    if (one?.backend === undefined) {
      const panes = yield* deps.herdr.paneList().pipe(Effect.orElseSucceed(() => []));
      yield* keepWorkspace(deps, paneId, panes);
    }
    yield* deps.herdr
      .paneClose(paneId, restored === undefined ? one?.backend : undefined)
      .pipe(Effect.mapError((cause) => new PaneOpen({ paneId, cause })));
  }
  const ended = paneId !== undefined || reached.success !== null;
  if (ended && closes === "close")
    yield* deps.log(endedLine(launched.agent, why)).pipe(Effect.ignore);
  return { _tag: "Closed", ended } satisfies Ended;
});

/** A pane herdr restored resuming the harness session recorded for this agent, if any. */
const restoredPane = (
  deps: EndDeps,
  launched: Pick<Launched, "agentSession">,
): Effect.Effect<PaneInfo | undefined, never, PlatformServices> =>
  launched.agentSession === undefined
    ? Effect.as(Effect.void, undefined)
    : deps.herdr.paneList().pipe(
        Effect.map((panes) =>
          Option.getOrUndefined(
            Arr.findFirst(panes, (pane) => sameSession(pane.agentSession, launched.agentSession)),
          ),
        ),
        Effect.orElseSucceed(() => undefined),
      );

/**
 * herdr drops a workspace with its last pane, and an end never takes a Task's workspace:
 * where this pane is the last one in its workspace, a shell is opened there first, and
 * left as the Task's first pane for its next agent to take over.
 */
const keepWorkspace = (deps: EndDeps, paneId: string, panes: ReadonlyArray<PaneInfo>) =>
  Effect.gen(function* () {
    const pane = Option.getOrUndefined(Arr.findFirst(panes, (one) => one.paneId === paneId));
    const workspace = pane?.workspaceId ?? null;
    if (pane === undefined || workspace === null) return;
    if (Arr.some(panes, (one) => one.workspaceId === workspace && one.paneId !== paneId)) return;
    const shell = yield* deps.herdr.tabCreate({
      label: "shell",
      cwd: pane.cwd ?? deps.cwd,
      workspace,
    });
    const task = yield* taskOfWorkspace(deps.stateDir, workspace);
    if (task === null) return;
    yield* withTaskLock(
      deps.stateDir,
      task.id,
      Effect.gen(function* () {
        const current = yield* readTask(deps.stateDir, task.id);
        if (current !== null)
          yield* writeTask(deps.stateDir, { ...current, root_pane: shell.paneId });
      }),
    );
  }).pipe(Effect.ignore);

/** A Run's log, for an end its Agents service does not make. */
export const runLog = (stateDir: string, runId: string) => (line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = launchDir(stateDir, runId);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/agents.log`, `${line}\n`, { flag: "a" });
  });
