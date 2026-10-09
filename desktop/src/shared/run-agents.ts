// The Facts tab's Agents section: one row per agent a Run started, in launch order.

import { ranOn, type RunAgent } from "../../../src/board-model";

export interface AgentRow {
  /** Unique within a Run: an operation's agent can be launched more than once. */
  readonly key: string;
  readonly operation: string;
  readonly ranOn: string;
  readonly agent: string;
}

export const agentRows = (agents: ReadonlyArray<RunAgent>): ReadonlyArray<AgentRow> =>
  agents.map((agent, at) => ({
    key: `${at}:${agent.agent}`,
    operation: agent.operation,
    ranOn: ranOn(agent),
    agent: agent.agent,
  }));
