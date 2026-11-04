import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { Connection, ConnectionId, ConnectionReading } from "../../../src/connection-model";
import { Option, Schema } from "effect";
import {
  Connection as ConnectionSchema,
  ConnectionId as ConnectionIds,
  ConnectionUse,
} from "../../../src/connection-model";

export const ConnectionWorkflow = ConnectionUse;
export type ConnectionWorkflow = typeof ConnectionWorkflow.Type;
export const workflowConnections = (
  workflows: ReadonlyArray<{ readonly id: string; readonly metadata: Schema.Json }>,
) =>
  Arr.flatMap(workflows, ({ id, metadata }) => {
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ connections: ConnectionWorkflow.fields.connections }),
    )(metadata);
    return Option.isSome(decoded) ? [{ id, connections: decoded.value.connections }] : [];
  });

export const connectionUses = (id: ConnectionId, workflows: ReadonlyArray<ConnectionWorkflow>) =>
  Arr.flatMap(workflows, (workflow) => {
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

const names = (values: ReadonlyArray<string>) =>
  pipe(Arr.join(values, ", "), Str.replace(/, ([^,]*)$/, " and $1"));

export const connectionCards = (machines: ReadonlyArray<MachineConnections>) =>
  Arr.map(ConnectionIds.literals, (id) => {
    const readings = Arr.map(machines, (machine) => ({
      ...machine,
      reading: Option.getOrUndefined(Arr.findFirst(machine.connections, (one) => one.id === id))
        ?.reading,
    }));
    const ready = Arr.filter(
      readings,
      (one) => one.problem === null && one.reading?.state === "ok",
    );
    const lacking = Arr.filter(
      readings,
      (one) => one.problem !== null || one.reading?.state !== "ok",
    );
    const source = ready[0];
    const targets = Arr.map(lacking, (one) => one.profile);
    let primary: ConnectionPrimary | null = null;
    if (lacking.length > 0) {
      if ((id === "gitlab" || id === "github") && source !== undefined)
        primary = {
          kind: "reuse",
          label:
            id === "gitlab"
              ? "Use glab's login"
              : `Give to ${names(Arr.map(lacking, (one) => one.name))}`,
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
      account:
        source?.reading?.state === "ok"
          ? id === "slack"
            ? source.reading.detail
            : source.reading.account
          : null,
      where:
        ready.length === machines.length
          ? `On all ${machines.length} Machines`
          : `${ready.length === 0 ? "No login found" : `On ${names(Arr.map(ready, (one) => one.name))}`} · missing on ${names(Arr.map(lacking, (one) => one.name))}`,
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
  return Arr.map([...groups], ([id, readings]) => {
    const ready = Option.getOrUndefined(
      Arr.findFirst(readings, ({ reading }) => reading.state === "ok"),
    );
    const chosen =
      ready ??
      Option.getOrUndefined(Arr.findFirst(readings, ({ reading }) => reading.state === "broken")) ??
      readings[0]!;
    return {
      id,
      state: chosen.reading.state,
      account: chosen.reading.state === "ok" ? chosen.reading.account : null,
      fix: chosen.reading.state === "ok" ? null : chosen.reading.fix,
      machines: Arr.map(readings, ({ machine, reading }) => ({
        machine,
        reading:
          reading.state === "ok" || ready === undefined
            ? reading
            : { ...reading, reusable: { from: ready.machine } },
      })),
    };
  });
};
