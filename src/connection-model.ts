import { Schema } from "effect";

export const ConnectionId = Schema.Literals(["gitlab", "github", "linear", "helle", "slack"]);
export type ConnectionId = typeof ConnectionId.Type;

export const ConnectionReading = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ok"), account: Schema.String, detail: Schema.String }),
  Schema.Struct({
    state: Schema.Literals(["absent", "broken"]),
    detail: Schema.String,
    fix: Schema.String,
    reusable: Schema.optionalKey(Schema.Struct({ from: Schema.String })),
  }),
]);
export type ConnectionReading = typeof ConnectionReading.Type;

export const Connection = Schema.Struct({ id: ConnectionId, reading: ConnectionReading });
export type Connection = typeof Connection.Type;

export const connectionsLines = (connections: ReadonlyArray<Connection>): string =>
  connections
    .map(
      ({ id, reading }) =>
        `${id.padEnd(10)}${reading.state}${reading.state === "ok" ? ` · ${reading.account}` : ""}: ${reading.detail}${reading.state === "ok" ? "" : `\n          Fix: ${reading.fix}`}`,
    )
    .join("\n");
