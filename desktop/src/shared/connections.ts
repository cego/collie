import type { Connection, ConnectionId, ConnectionReading } from "../../../src/connection-model";
import { Option, Schema } from "effect";
import {
  Connection as ConnectionSchema,
  ConnectionId as ConnectionIds,
} from "../../../src/connection-model";

export const ConnectionWorkflow = Schema.Struct({
  id: Schema.String,
  connections: Schema.Struct({
    needs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ with: Schema.String }))),
    uses: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ with: Schema.String, without: Schema.String })),
    ),
  }),
});
export type ConnectionWorkflow = typeof ConnectionWorkflow.Type;
export const workflowConnections = (
  workflows: ReadonlyArray<{ readonly id: string; readonly metadata: Schema.Json }>,
) =>
  workflows.flatMap(({ id, metadata }) => {
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ connections: ConnectionWorkflow.fields.connections }),
    )(metadata);
    return Option.isSome(decoded) ? [{ id, connections: decoded.value.connections }] : [];
  });

export const connectionUses = (id: ConnectionId, workflows: ReadonlyArray<ConnectionWorkflow>) =>
  workflows.flatMap((workflow) => {
    const needs = workflow.connections.needs?.[id];
    if (needs !== undefined)
      return [{ id: workflow.id, declares: "needs", with: needs.with, without: "Does not start" }];
    const uses = workflow.connections.uses?.[id];
    return uses === undefined ? [] : [{ id: workflow.id, declares: "uses", ...uses }];
  });
export const MachineConnections = Schema.Struct({
  profile: Schema.String,
  name: Schema.String,
  connections: Schema.Array(ConnectionSchema),
  workflows: Schema.Array(ConnectionWorkflow),
  problem: Schema.NullOr(Schema.String),
});
export type MachineConnections = typeof MachineConnections.Type;

export const CONNECTION_NAMES = {
  gitlab: "GitLab",
  github: "GitHub",
  linear: "Linear",
  helle: "Helle",
  slack: "Slack",
} satisfies Record<ConnectionId, string>;

export type ConnectionPrimary =
  | {
      readonly kind: "reuse";
      readonly label: string;
      readonly from: string;
      readonly to: ReadonlyArray<string>;
    }
  | { readonly kind: "login" | "setup"; readonly label: string; readonly to: ReadonlyArray<string> }
  | { readonly kind: "connect"; readonly label: string };

const names = (values: ReadonlyArray<string>) => values.join(", ").replace(/, ([^,]*)$/, " and $1");

export const connectionCards = (machines: ReadonlyArray<MachineConnections>) =>
  ConnectionIds.literals.map((id) => {
    const readings = machines.map((machine) => ({
      ...machine,
      reading: machine.connections.find((one) => one.id === id)?.reading,
    }));
    const ready = readings.filter((one) => one.problem === null && one.reading?.state === "ok");
    const lacking = readings.filter((one) => one.problem !== null || one.reading?.state !== "ok");
    const source = ready[0];
    const targets = lacking.map((one) => one.profile);
    let primary: ConnectionPrimary | null = null;
    if (lacking.length > 0) {
      if ((id === "gitlab" || id === "github") && source !== undefined)
        primary = {
          kind: "reuse",
          label:
            id === "gitlab"
              ? "Use glab's login"
              : `Give to ${names(lacking.map((one) => one.name))}`,
          from: source.profile,
          to: targets,
        };
      else if (id === "github" || id === "linear")
        primary = {
          kind: id === "github" ? "login" : "setup",
          label: `${id === "github" ? "Sign in on" : "Set up on"} ${lacking[0]!.name}`,
          to: [lacking[0]!.profile],
        };
      else primary = { kind: "connect", label: "Connect" };
    }
    return {
      id,
      name: CONNECTION_NAMES[id],
      primary,
      needsYou: lacking.length > 0,
      state:
        machines.length === 0
          ? "Not read yet"
          : lacking.length === 0
            ? "Connected"
            : ready.length > 0
              ? `On ${ready.length} of ${machines.length} Machines`
              : "Not set up",
      account: source?.reading?.state === "ok" ? source.reading.account : null,
      where:
        ready.length === machines.length
          ? `On all ${machines.length} Machines`
          : `${ready.length === 0 ? "No login found" : `On ${names(ready.map((one) => one.name))}`} · missing on ${names(lacking.map((one) => one.name))}`,
      machines: readings,
    };
  });

export interface FlockConnection {
  readonly id: ConnectionId;
  readonly state: ConnectionReading["state"];
  readonly account: string | null;
  readonly fix: string | null;
  readonly machines: ReadonlyArray<{
    readonly machine: string;
    readonly reading: ConnectionReading;
  }>;
}

export const mergeConnections = (
  machines: ReadonlyArray<{
    readonly machine: string;
    readonly connections: ReadonlyArray<Connection>;
  }>,
): ReadonlyArray<FlockConnection> => {
  const groups = new Map<ConnectionId, FlockConnection["machines"][number][]>();
  for (const { machine, connections } of machines)
    for (const { id, reading } of connections) {
      const group = groups.get(id) ?? [];
      group.push({ machine, reading });
      groups.set(id, group);
    }
  return [...groups].map(([id, readings]) => {
    const ready = readings.find(({ reading }) => reading.state === "ok");
    const chosen =
      ready ?? readings.find(({ reading }) => reading.state === "broken") ?? readings[0]!;
    return {
      id,
      state: chosen.reading.state,
      account: chosen.reading.state === "ok" ? chosen.reading.account : null,
      fix: chosen.reading.state === "ok" ? null : chosen.reading.fix,
      machines: readings.map(({ machine, reading }) => ({
        machine,
        reading:
          reading.state === "ok" || ready === undefined
            ? reading
            : { ...reading, reusable: { from: ready.machine } },
      })),
    };
  });
};
