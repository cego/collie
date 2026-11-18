import * as Arr from "effect/Array";
import { ranOn, type RunAgent } from "../../../src/board-model";

export interface AgentRow {
  readonly key: string;
  readonly operation: string;
  readonly ranOn: string;
  readonly agent: string;
}

export const agentRows = (agents: ReadonlyArray<RunAgent>) =>
  Arr.map(agents, (agent, at) => ({
    key: `${at}:${agent.agent}`,
    operation: agent.operation,
    ranOn: ranOn(agent),
    agent: agent.agent,
  }));
