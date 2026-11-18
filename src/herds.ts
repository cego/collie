// This Machine's Herd, as the host sees it: its core session, the agents in it, and core's
// own word when any of them changes.

import * as Arr from "effect/Array";
import { Effect, Stream } from "effect";
import type { PaneAt } from "./board-model";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";
import { verifyIncarnation, type AgentEntry } from "./registry";
import { machineHerd } from "./steering";

/** This Machine's Herd: its core session, under the key its Tasks record. */
export interface LiveHerd {
  /** Null where core's session cannot be named. */
  readonly herd: string | null;
  /** core's name for the session, where it names one. */
  readonly name?: string;
  readonly herdr: Herdr;
}

/** How often the Herd is read again. */
export const SESSIONS_EVERY = "1 minute";

/** This Machine's one Herd, its core's. */
export const liveHerds = Effect.fn("Herds.live")(function* (herdr: Herdr, env: PluginEnv) {
  const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  return [{ herd, herdr }] satisfies ReadonlyArray<LiveHerd>;
});

/**
 * The terminal of the first registered incarnation core still has, as Go to pane attaches
 * to it; an old name never identifies a replacement terminal.
 */
export const focusPane = Effect.fn("Herds.focusPane")(function* (
  sessions: ReadonlyArray<LiveHerd>,
  agents: ReadonlyArray<AgentEntry>,
) {
  for (const { herdr } of sessions) {
    const live = yield* herdr.agentList().pipe(Effect.orElseSucceed(() => []));
    for (const entry of agents) {
      const identified = verifyIncarnation(entry, live);
      if (!identified.ok) continue;
      const agent = identified.info;
      return {
        session: null,
        workspace: agent.name,
        tab: null,
        pane: agent.paneId,
        agent: agent.name,
        core: agent.paneId,
      } satisfies PaneAt;
    }
  }
  return null;
});

/** The agents core has in every Herd; one that does not answer has none. */
export const agentsIn = (sessions: ReadonlyArray<LiveHerd>) =>
  Effect.forEach(
    sessions,
    (session) => session.herdr.agentList().pipe(Effect.orElseSucceed(() => [])),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((each) => ({ alive: Arr.flatten(each) })));

/** Every change core pushes about this Machine's terminals. */
export const herdChanges = (herdr: Herdr) => herdr.changes().pipe(Stream.debounce("200 millis"));
