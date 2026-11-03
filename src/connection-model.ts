import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Schema, SchemaGetter } from "effect";

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

/**
 * A host's Connections as sent. A protocol-4 host's `slack` is its bot and `slack-user` the
 * human, who is `slack` now; an id this build does not know is dropped.
 */
export const HostConnections = Schema.Array(
  Schema.Struct({ id: Schema.String, reading: ConnectionReading }),
).pipe(
  Schema.decodeTo(Schema.Array(Connection), {
    decode: SchemaGetter.transform((sent) => {
      const protocol4 = Arr.some(sent, ({ id }) => id === "slack-user");
      return Arr.flatMap(sent, ({ id, reading }) => {
        const now =
          protocol4 && id === "slack-user" ? "slack" : protocol4 && id === "slack" ? "" : id;
        return Schema.is(ConnectionId)(now) ? [{ id: now, reading }] : [];
      });
    }),
    encode: SchemaGetter.passthroughSupertype(),
  }),
);

export const ConnectionLogin = Schema.Struct({ host: Schema.String, token: Schema.String });
export type ConnectionLogin = typeof ConnectionLogin.Type;

export const ConnectionUse = Schema.Struct({
  id: Schema.String,
  connections: Schema.Struct({
    needs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({ with: Schema.String }))),
    uses: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ with: Schema.String, without: Schema.String })),
    ),
  }),
});
export const HOST_CONNECTION_USES: ReadonlyArray<typeof ConnectionUse.Type> = [
  {
    id: "Notifications",
    connections: {
      uses: { slack: { with: "Posts the toasts you keep on, as you", without: "Toasts only" } },
    },
  },
];

export const connectionsLines = (connections: ReadonlyArray<Connection>): string =>
  Arr.join(
    Arr.map(
      connections,
      ({ id, reading }) =>
        `${pipe(`${id} `, Str.padEnd(10))}${reading.state}${reading.state === "ok" ? ` · ${reading.account}` : ""}: ${reading.detail}${reading.state === "ok" ? "" : `\n          Fix: ${reading.fix}`}`,
    ),
    "\n",
  );
