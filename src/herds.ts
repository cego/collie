// Every Herd on this Machine, as the host sees them: each running herdr session, the
// agents in it, and herdr's own word when any of them changes.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schedule, Stream } from "effect";
import type { PaneAt } from "./board-model";
import type { PluginEnv } from "./env";
import type { AgentInfo, Herdr, PaneInfo } from "./herdr";
import { terminalBackend } from "./config";
import { herdOf, machineHerd } from "./steering";

/** One Herd the host reads: its herdr session, under the key its Tasks record. */
export interface LiveHerd {
  /** Null for the session this process inherited without a socket to name it by. */
  readonly herd: string | null;
  /** herdr's name for the session, where herdr names its sessions. */
  readonly name?: string;
  /** herdr's default session, which a client reaches without naming one. */
  readonly default?: boolean;
  readonly herdr: Herdr;
}

/** What herdr is subscribed to: a pane coming or going, and each agent pane's status. */
export const PANE_EVENTS = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.agent_detected" },
] as const;

/**
 * Every running herdr session, or only the one this process inherited where herdr cannot
 * list its sessions; on a Machine set to core, its core Herd too.
 */
export const liveHerds = Effect.fn("Herds.live")(function* (herdr: Herdr, env: PluginEnv) {
  const listed = yield* herdr.sessionList().pipe(Effect.orElseSucceed(() => []));
  if (listed.length === 0) {
    const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
    return [{ herd, herdr }];
  }
  const sessions: LiveHerd[] = [];
  for (const one of listed) {
    const herd = yield* herdOf(one.socketPath).pipe(Effect.orElseSucceed(() => null));
    sessions.push({
      herd,
      name: one.name,
      default: one.default,
      herdr: herdr.inSession(one.socketPath),
    });
  }
  if ((yield* terminalBackend(env.userDir)) === "core") {
    const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
    if (herd !== null && !Arr.some(sessions, (one) => one.herd === herd))
      sessions.push({ herd, herdr });
  }
  return sessions;
});

/**
 * Focuses the first of `agents` a session still has, else `workspace` in the Task's own
 * `herd` (undefined where the Task recorded none), in the first session that holds either;
 * null where none does.
 */
export const focusPane = Effect.fn("Herds.focusPane")(function* (
  sessions: ReadonlyArray<LiveHerd>,
  agents: ReadonlyArray<string>,
  workspace: string | null,
  herd: string | null | undefined,
) {
  for (const session of sessions) {
    const { herdr } = session;
    const live = yield* herdr.agentList().pipe(Effect.orElseSucceed((): AgentInfo[] => []));
    const agent = Arr.flatMap(agents, (name) => Arr.filter(live, (one) => one.name === name))[0];
    const pane =
      agent === undefined
        ? undefined
        : Option.getOrUndefined(
            Arr.findFirst(
              yield* herdr.paneList().pipe(Effect.orElseSucceed((): PaneInfo[] => [])),
              (one) => one.paneId === agent.paneId,
            ),
          );
    // Workspace ids are only unique within a session.
    const home = herd === undefined ? sessions.length === 1 : session.herd === herd;
    const workspaceId = pane?.workspaceId ?? agent?.workspaceId ?? (home ? workspace : null);
    if (workspaceId === null) continue;
    const named = Option.getOrUndefined(
      Arr.findFirst(
        yield* herdr.workspaceList().pipe(Effect.orElseSucceed(() => [])),
        (one) => one.workspaceId === workspaceId,
      ),
    );
    if (named === undefined) continue;
    yield* agent === undefined ? herdr.workspaceFocus(workspaceId) : herdr.agentFocus(agent.name);
    const tab =
      pane === undefined
        ? null
        : (Option.getOrUndefined(
            Arr.findFirst(
              yield* herdr.tabList(workspaceId).pipe(Effect.orElseSucceed(() => [])),
              (one) => one.tabId === pane.tabId,
            ),
          )?.label ?? null);
    const at: PaneAt = {
      session: session.default === true ? null : (session.name ?? null),
      workspace: named.label,
      tab,
    };
    return agent === undefined ? at : { ...at, pane: agent.paneId, agent: agent.name };
  }
  return null;
});

/**
 * The agents herdr names in every session, and the terminal and status of each pane it
 * restored on a harness session without the name; a session that does not answer has none.
 */
export const agentsIn = (sessions: ReadonlyArray<LiveHerd>) =>
  Effect.forEach(
    sessions,
    (session) =>
      session.herdr.agentList().pipe(
        Effect.flatMap((alive) =>
          restoredPanes(session, alive).pipe(
            Effect.map((panes) =>
              Arr.map(panes, (pane) => ({
                terminalId: pane.terminalId,
                status: pane.agentStatus ?? null,
              })),
            ),
            Effect.orElseSucceed(() => []),
            Effect.map((restored) => ({ alive, restored })),
          ),
        ),
        Effect.orElseSucceed(() => ({ alive: [], restored: [] })),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((each) => ({
      alive: Arr.flatMap(each, (one) => one.alive),
      restored: Arr.flatMap(each, (one) => one.restored),
    })),
  );

/** Panes herdr restored on a harness session without the agent's name, which `agentList` omits. */
const restoredPanes = (session: LiveHerd, agents: ReadonlyArray<AgentInfo>) =>
  session.herdr
    .paneList()
    .pipe(
      Effect.map((panes) =>
        Arr.filter(
          panes,
          (pane) =>
            pane.agentSession !== null &&
            !Arr.some(agents, (agent) => agent.paneId === pane.paneId),
        ),
      ),
    );

/**
 * One element each time herdr reports a change in this session. Subscribed again after
 * every event, so an agent pane that appeared since is watched too.
 */
// ponytail: an event between two subscriptions is missed; the board's tick catches it.
const changesIn = (session: LiveHerd) =>
  Stream.fromEffectRepeat(
    session.herdr
      .waitForEvent(
        Effect.gen(function* () {
          const agents = yield* session.herdr.agentList();
          const restored = yield* restoredPanes(session, agents);
          return [
            ...PANE_EVENTS,
            ...Arr.map([...agents, ...restored], (one) => ({
              type: "pane.agent_status_changed",
              pane_id: one.paneId,
            })),
          ];
        }),
      )
      .pipe(Effect.retry(Schedule.spaced("5 seconds"))),
  );

/** How often the list of sessions is read again, so a session started later is watched. */
export const SESSIONS_EVERY = "1 minute";

/** Every change herdr pushes in any of this Machine's sessions. */
export const herdChanges = (herdr: Herdr, env: PluginEnv) =>
  Stream.unwrap(
    liveHerds(herdr, env).pipe(
      Effect.map((sessions) =>
        Stream.mergeAll(Arr.map(sessions, changesIn), { concurrency: "unbounded" }),
      ),
    ),
  ).pipe(
    Stream.interruptWhen(Effect.sleep(SESSIONS_EVERY)),
    Stream.repeat(Schedule.forever),
    Stream.debounce("200 millis"),
  );
