// What a card's record decides about its Terminal tab.

import type { BoardAgent } from "../../../src/board-model";

/**
 * Offered while the Run's Machine is reached, and kept while it is the tab shown, so a
 * dropped connection says why and offers Reattach rather than taking the pane away.
 */
export const offersTerminal = (asOf: number | null, chosen: string | undefined) =>
  asOf === null || chosen === "terminal";

/** Only Go to pane, finding no pane to show, opens herdr's own client instead. */
export const opensHerdrWithoutPane = (asked: string | null) => asked === "terminal";

/** One live agent of the Task, as the Terminal tab's switcher offers it. */
export interface AgentTab {
  readonly name: string;
  readonly run: string;
  readonly label: string;
  /** herdr's status, or `ended` for the agent shown once the board no longer lists it. */
  readonly state: string;
  readonly now: string | null;
  readonly shown: boolean;
}

/**
 * The card's live agents, and the one `shown` kept while it is shown though it has ended.
 * Each is its role, numbered where several share one; its herdr name where it has none.
 */
export const agentTabs = (
  agents: ReadonlyArray<BoardAgent>,
  shown: BoardAgent | null,
): AgentTab[] => {
  const ended = shown !== null && !agents.some((one) => one.name === shown.name);
  const listed = ended ? [...agents, shown] : agents;
  const roleOf = (agent: BoardAgent) => agent.role ?? agent.name;
  const seen = new Map<string, number>();
  return listed.map((agent) => {
    const role = roleOf(agent);
    const nth = (seen.get(role) ?? 0) + 1;
    seen.set(role, nth);
    const shared = listed.filter((one) => roleOf(one) === role).length > 1;
    return {
      name: agent.name,
      run: agent.run,
      label: shared ? `${role} ${nth}` : role,
      state: ended && agent === shown ? "ended" : agent.status,
      now: agent.now,
      shown: agent.name === shown?.name,
    };
  });
};

/**
 * The agent `focused` names, as the board lists it, or as it was last listed once the board
 * no longer does; null until the board has listed it at all.
 */
export const shownAgent = (
  agents: ReadonlyArray<BoardAgent>,
  focused: string | undefined,
  before: BoardAgent | null,
): BoardAgent | null =>
  agents.find((one) => one.name === focused) ?? (before?.name === focused ? before : null);
