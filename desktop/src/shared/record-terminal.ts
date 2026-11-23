import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { BoardAgent } from "../../../src/board-model";
import { ROLES } from "../../../src/steer-target";

// WARNING: kept while shown, so a dropped connection says why and offers Reattach rather than removing the pane.
export const offersTerminal = (asOf: number | null, chosen: string | undefined) =>
  asOf === null || chosen === "terminal";

export interface AgentTab {
  readonly name: string;
  readonly run: string;
  readonly label: string;
  readonly state: string;
  readonly now: string | null;
  readonly shown: boolean;
}

export const agentTabs = (agents: ReadonlyArray<BoardAgent>, shown: BoardAgent | null) => {
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

export const recipients = (
  launches: ReadonlyArray<{ readonly agent: string }> | undefined,
  live: ReadonlyArray<BoardAgent>,
) => {
  const tabs = new Map(Arr.map(agentTabs(live, null), (tab) => [tab.name, tab]));
  const names = Arr.map(launches ?? [], (launch) => launch.agent);
  const latest = Arr.filter(names, (name, at) => names.lastIndexOf(name) === at);
  return Arr.flatMap(latest, (name) => Arr.ensure(tabs.get(name) ?? []));
};

export interface DeliveryChoice {
  readonly key: string;
  readonly label: string;
  readonly to?: string;
  readonly agent?: string;
}

export interface Address {
  agent?: string;
  to?: string;
}

export const addressOf = (who: Readonly<Address>) => {
  const address: Address = {};
  if (who.agent !== undefined) {
    address.agent = who.agent;
  }
  if (who.to !== undefined) {
    address.to = who.to;
  }
  return address;
};

// WARNING: 4 is the first board protocol whose hosts take a delivery to a role or to no agent; both shipped together.
export const ADDRESSED_DELIVERY = 4;

export const deliveryChoices = (
  launches: ReadonlyArray<{ readonly agent: string }> | undefined,
  live: ReadonlyArray<BoardAgent>,
  protocol: number | null,
  preferred?: "planner",
) => {
  const tabs = recipients(launches, live);
  const byName = Arr.map(tabs, (tab) => ({ key: tab.name, label: tab.label, agent: tab.name }));
  if (tabs.length === 0) {
    return [];
  }
  const roles = new Set(
    Arr.flatMap(tabs, (tab) =>
      Arr.ensure(
        Option.getOrUndefined(Arr.findFirst(live, (one) => one.name === tab.name))?.role ?? [],
      ),
    ),
  );
  const offered: Array<DeliveryChoice> =
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

export const shownAgent = (
  agents: ReadonlyArray<BoardAgent>,
  focused: string | undefined,
  before: BoardAgent | null,
) =>
  Option.getOrUndefined(Arr.findFirst(agents, (one) => one.name === focused)) ??
  (before?.name === focused ? before : null);

export const atWork = (agents: ReadonlyArray<BoardAgent>, run: string) => {
  const blocked = Arr.filter(agents, (one) => one.status === "blocked");
  const candidates =
    blocked.length > 0 ? blocked : Arr.filter(agents, (one) => one.status === "working");
  const own = Arr.filter(candidates, (one) => one.run === run);
  return (own.length > 0 ? own : candidates).at(-1) ?? null;
};

export const askedFor = (
  agents: ReadonlyArray<BoardAgent>,
  run: string,
  picked: AgentTab | null,
  requested?: string,
) => {
  if (picked !== null) {
    return picked;
  }
  if (requested !== undefined) {
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
  }
  const busy = atWork(agents, run);
  return (
    Option.getOrUndefined(
      Arr.findFirst(agentTabs(agents, null), (one) => one.name === busy?.name),
    ) ?? null
  );
};

// WARNING: only the newest waiting switch opens; a stop cancels any that wait.
export const switches = (release: () => Promise<void>) => {
  let newest = 0;
  let released = Promise.resolve();
  const letGo = () => (released = released.then(release));
  return {
    to: (open: () => void) => {
      const mine = ++newest;
      return letGo().then(() => {
        if (mine === newest) {
          open();
        }
      });
    },
    stop: () => {
      newest++;
      return letGo();
    },
  };
};
