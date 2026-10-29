import type { Connection, ConnectionId, ConnectionReading } from "../../../src/connection-model";

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
