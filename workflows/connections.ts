import { ConnectionReading, Host, type ConnectionId } from "collie";
import { Effect } from "effect";
import * as Activity from "effect/workflow/Activity";

export const connection = (id: ConnectionId, name = `connection.${id}`) =>
  Activity.make({
    name,
    success: ConnectionReading,
    execute: Effect.flatMap(Host, (host) => host.connection(id)),
  });
