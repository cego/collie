// Every Herd on this Machine, as the host sees them: each running herdr session, the
// agents in it, and herdr's own word when any of them changes.

import { Effect, Schedule, Stream } from "effect";
import type { PaneAt } from "./board-model";
import type { PluginEnv } from "./env";
import type { AgentInfo, Herdr, PaneInfo } from "./herdr";
import { herdOf } from "./steering";

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
 * list its sessions.
 */
export const liveHerds = Effect.fn("Herds.live")(function* (herdr: Herdr, env: PluginEnv) {
  const listed = yield* herdr.sessionList().pipe(Effect.orElseSucceed(() => []));
  if (listed.length === 0) {
    const herd = yield* herdOf(env.socketPath).pipe(Effect.orElseSucceed(() => null));
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
  return sessions;
});

/**
 * Focuses the first of `agents` a session still has, else `workspace`, in the first
 * session that holds either; null where none does.
 */
export const focusPane = Effect.fn("Herds.focusPane")(function* (
  sessions: ReadonlyArray<LiveHerd>,
  agents: ReadonlyArray<string>,
  workspace: string | null,
) {
  for (const session of sessions) {
    const { herdr } = session;
    const live = yield* herdr.agentList().pipe(Effect.orElseSucceed((): AgentInfo[] => []));
    const agent = agents.flatMap((name) => live.filter((one) => one.name === name))[0];
    const pane =
      agent === undefined
        ? undefined
        : (yield* herdr.paneList().pipe(Effect.orElseSucceed((): PaneInfo[] => []))).find(
            (one) => one.paneId === agent.paneId,
          );
    const workspaceId = pane?.workspaceId ?? agent?.workspaceId ?? workspace;
    if (workspaceId === null) continue;
    const named = (yield* herdr.workspaceList().pipe(Effect.orElseSucceed(() => []))).find(
      (one) => one.workspaceId === workspaceId,
    );
    if (named === undefined) continue;
    yield* agent === undefined ? herdr.workspaceFocus(workspaceId) : herdr.agentFocus(agent.name);
    const tab =
      pane === undefined
        ? null
        : ((yield* herdr.tabList(workspaceId).pipe(Effect.orElseSucceed(() => []))).find(
            (one) => one.tabId === pane.tabId,
          )?.label ?? null);
    return {
      session: session.default === true ? null : (session.name ?? null),
      workspace: named.label,
      tab,
    } satisfies PaneAt;
  }
  return null;
});

/** The live agents of every session together; a session that does not answer has none. */
export const aliveIn = (sessions: ReadonlyArray<LiveHerd>) =>
  Effect.forEach(
    sessions,
    (session) => session.herdr.agentList().pipe(Effect.orElseSucceed((): AgentInfo[] => [])),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((each) => each.flat()));

/**
 * One element each time herdr reports a change in this session. Subscribed again after
 * every event, so an agent pane that appeared since is watched too.
 */
// ponytail: an event between two subscriptions is missed; the board's tick catches it.
const changesIn = (session: LiveHerd) =>
  Stream.fromEffectRepeat(
    Effect.gen(function* () {
      const agents = yield* session.herdr.agentList();
      yield* session.herdr.waitForEvent([
        ...PANE_EVENTS,
        ...agents.map((agent) => ({ type: "pane.agent_status_changed", pane_id: agent.paneId })),
      ]);
    }).pipe(Effect.retry(Schedule.spaced("5 seconds"))),
  );

/** How often the list of sessions is read again, so a session started later is watched. */
const SESSIONS_EVERY = "1 minute";

/** Every change herdr pushes in any of this Machine's sessions. */
export const herdChanges = (herdr: Herdr, env: PluginEnv) =>
  Stream.unwrap(
    liveHerds(herdr, env).pipe(
      Effect.map((sessions) =>
        Stream.mergeAll(sessions.map(changesIn), { concurrency: "unbounded" }),
      ),
    ),
  ).pipe(
    Stream.interruptWhen(Effect.sleep(SESSIONS_EVERY)),
    Stream.repeat(Schedule.forever),
    Stream.debounce("200 millis"),
  );
