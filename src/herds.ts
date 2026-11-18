import * as Arr from "effect/Array";
import { Effect, Stream } from "effect";
import type { PaneAt } from "./board-model";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";
import { verifyIncarnation, type AgentEntry } from "./registry";
import { machineHerd } from "./steering";

export interface LiveHerd {
  readonly herd: string | null;
  readonly name?: string;
  readonly herdr: Herdr;
}

export const SESSIONS_EVERY = "1 minute";

export const liveHerds = Effect.fn("Herds.live")(function* (herdr: Herdr, env: PluginEnv) {
  const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  return [{ herd, herdr }] satisfies ReadonlyArray<LiveHerd>;
});

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

export const agentsIn = (sessions: ReadonlyArray<LiveHerd>) =>
  Effect.forEach(
    sessions,
    (session) => session.herdr.agentList().pipe(Effect.orElseSucceed(() => [])),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((each) => ({ alive: Arr.flatten(each) })));

export const herdChanges = (herdr: Herdr) => herdr.changes().pipe(Stream.debounce("200 millis"));
