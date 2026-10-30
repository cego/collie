// What a card's record decides about its Terminal tab.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { BoardAgent } from "../../../src/board-model";
import { ROLES } from "../../../src/steer-target";

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
  const ended = shown !== null && !Arr.some(agents, (one) => one.name === shown.name);
  const listed = ended ? [...agents, shown] : agents;
  const roleOf = (agent: BoardAgent) => agent.role ?? agent.name;
  const seen = new Map<string, number>();
  return Arr.map(listed, (agent) => {
    const role = roleOf(agent);
    const nth = (seen.get(role) ?? 0) + 1;
    seen.set(role, nth);
    const shared = Arr.filter(listed, (one) => roleOf(one) === role).length > 1;
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

/** Only the Run's own live launches, newest last even when reused under another Run. */
export const recipients = (
  launches: ReadonlyArray<{ readonly agent: string }> | undefined,
  live: ReadonlyArray<BoardAgent>,
): AgentTab[] => {
  const tabs = new Map(Arr.map(agentTabs(live, null), (tab) => [tab.name, tab]));
  const names = Arr.map(launches ?? [], (launch) => launch.agent);
  const latest = Arr.filter(names, (name, at) => names.lastIndexOf(name) === at);
  return Arr.flatMap(latest, (name) => Arr.ensure(tabs.get(name) ?? []));
};

/** Where a delivery goes: the agent at work, a role, or one agent by name. */
export interface DeliveryChoice {
  readonly key: string;
  readonly label: string;
  readonly to?: string;
  readonly agent?: string;
}

/** Who a delivery names: one agent, or the role `to` names; neither is the agent at work. */
export interface Address {
  agent?: string;
  to?: string;
}

/** A delivery's addressee, with only the fields it names. */
export const addressOf = (who: Readonly<Address>): Address => {
  const address: Address = {};
  if (who.agent !== undefined) address.agent = who.agent;
  if (who.to !== undefined) address.to = who.to;
  return address;
};

/** The first board protocol whose hosts take a delivery to a role or to no agent: both shipped together. */
export const ADDRESSED_DELIVERY = 4;

/**
 * Addressed hosts offer roles and agents; older hosts offer agents only.
 * A live preferred role goes first; otherwise the default is the agent at work, or newest.
 */
export const deliveryChoices = (
  launches: ReadonlyArray<{ readonly agent: string }> | undefined,
  live: ReadonlyArray<BoardAgent>,
  protocol: number | null,
  preferred?: "planner",
): DeliveryChoice[] => {
  const tabs = recipients(launches, live);
  const byName = Arr.map(tabs, (tab) => ({ key: tab.name, label: tab.label, agent: tab.name }));
  if (tabs.length === 0) return [];
  const roles = new Set(
    Arr.flatMap(tabs, (tab) =>
      Arr.ensure(
        Option.getOrUndefined(Arr.findFirst(live, (one) => one.name === tab.name))?.role ?? [],
      ),
    ),
  );
  const offered: DeliveryChoice[] =
    protocol === null || protocol < ADDRESSED_DELIVERY
      ? Arr.reverse(byName)
      : [
          { key: "@work", label: "The agent at work" },
          ...Arr.map(
            Arr.filter(Rec.toEntries(ROLES), ([, covered]) =>
              Arr.some(covered, (role) => roles.has(role)),
            ),
            ([to]) => ({
              key: `@${to}`,
              label: `The ${to}`,
              to,
            }),
          ),
          ...byName,
        ];
  const first =
    preferred === undefined
      ? undefined
      : Option.getOrUndefined(
          Arr.findFirst(
            offered,
            (one) =>
              one.to === preferred ||
              (one.agent !== undefined &&
                Arr.some(live, (agent) => agent.name === one.agent && agent.role === preferred)),
          ),
        );
  return first === undefined ? offered : [first, ...Arr.filter(offered, (one) => one !== first)];
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
  Option.getOrUndefined(Arr.findFirst(agents, (one) => one.name === focused)) ??
  (before?.name === focused ? before : null);

/**
 * The agent the tab opens on: one `blocked`, else one `working`, of the card's own Run first
 * and then the last listed; null where none is either.
 */
export const atWork = (agents: ReadonlyArray<BoardAgent>, run: string): BoardAgent | null => {
  const blocked = Arr.filter(agents, (one) => one.status === "blocked");
  const candidates =
    blocked.length > 0 ? blocked : Arr.filter(agents, (one) => one.status === "working");
  const own = Arr.filter(candidates, (one) => one.run === run);
  return (own.length > 0 ? own : candidates).at(-1) ?? null;
};

/** The agent the tab asks for: the one picked, else the agent at work; null for the Run's newest. */
export const askedFor = (
  agents: ReadonlyArray<BoardAgent>,
  run: string,
  picked: AgentTab | null,
  requested?: string,
): AgentTab | null => {
  if (picked !== null) return picked;
  if (requested !== undefined)
    return (
      Option.getOrUndefined(
        Arr.findFirst(agentTabs(agents, null), (one) => one.name === requested),
      ) ?? {
        name: requested,
        run,
        label: requested,
        state: "ended",
        now: null,
        shown: false,
      }
    );
  const busy = atWork(agents, run);
  return (
    Option.getOrUndefined(
      Arr.findFirst(agentTabs(agents, null), (one) => one.name === busy?.name),
    ) ?? null
  );
};

/**
 * Whether a pane not found opens herdr's own client: for Go to pane until a pick, so a host
 * whose focus names no pane still does what it did before.
 */
export const opensHerdrForNoPane = (wentToPane: boolean, picked: AgentTab | null) =>
  wentToPane && picked === null;

/**
 * The Terminal tab's switches between panes, each started once `release` has let the pane
 * before it go. Only the newest switch still waiting opens; a stop cancels any that wait.
 */
export const switches = (release: () => Promise<void>) => {
  let newest = 0;
  let released = Promise.resolve();
  const letGo = () => (released = released.then(release));
  return {
    to: (open: () => void) => {
      const mine = ++newest;
      return letGo().then(() => {
        if (mine === newest) open();
      });
    },
    stop: () => {
      newest++;
      return letGo();
    },
  };
};
