// `collie bridge`: a front door on any computer reaches this Machine's host through one
// command's stdio. The bridge is the Machine's own binary, so starting the host is done
// here, never by the client at the other end of the stream.

import * as Str from "effect/String";
import * as Struct from "effect/Struct";

import { Config, Effect, Option } from "effect";
import { BRIDGE_READY, type Declaration, type FrontDoor, type Where } from "./board-model";
import { channelInto } from "./channel";
import { currentEnv } from "./env";
import { Herdr } from "./herdr";
import { HostUnavailable, connect, peerChannel, socketOf } from "./host";
import { ensurePaired, riding } from "./lifecycle";
import { machineName } from "./peers";
/** Where this channel came from: the computer the front door names, and the SSH client sshd saw. */
const whereFrom = Effect.fn("Bridge.whereFrom")(function* (client: string | null) {
  const connection = yield* Config.option(Config.String("SSH_CONNECTION")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const ssh = Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(Option.getOrUndefined(connection)),
      (present) => Str.split(present, " ")[0],
    ),
  );
  let where: Where = {};
  if (client !== null) where = { ...where, client };
  if (ssh !== undefined && ssh !== "") where = { ...where, ssh };
  return Struct.keys(where).length === 0 ? undefined : where;
});

export const bridge = Effect.fn("Bridge")(function* (
  as: FrontDoor,
  client: string | null,
  machine: string | null = null,
) {
  const env = yield* currentEnv.pipe(Effect.orDie);
  // A login over SSH is handed no herdr socket; herdr's own status says where it listens.
  const session =
    env.socketPath ??
    (yield* new Herdr(env).serverInfo().pipe(
      Effect.map((server) => (server.socket === "" ? null : server.socket)),
      Effect.orElseSucceed(() => null),
    ));
  // A host on another build is still one to pipe: front doors speak a protocol, not a build.
  yield* Effect.scoped(
    connect(env.stateDir, {
      hostEnv:
        session === null
          ? { HERDR_PLUGIN_STATE_DIR: env.stateDir }
          : { HERDR_PLUGIN_STATE_DIR: env.stateDir, HERDR_SOCKET_PATH: session },
    }),
  ).pipe(Effect.catchTag("HostVersionMismatch", () => Effect.void));
  const from = yield* whereFrom(client);
  const declaration: Declaration =
    from === undefined ? { frontDoor: as, session } : { frontDoor: as, session, from };
  const socket =
    machine === null
      ? socketOf(env.stateDir)
      : yield* ensurePaired({ ...env, pairs: true }, machine).pipe(
          Effect.andThen(
            riding(
              { ...env, pairs: true },
              machine,
              peerChannel(env.stateDir, machine, { as, client: client ?? machineName() }),
            ),
          ),
        );
  return yield* channelInto(socket, declaration, {
    ready: () => process.stdout.write(`${BRIDGE_READY}\n`),
    write: (chunk) => process.stdout.write(chunk),
    end: (done) => {
      process.stdin.destroy();
      process.stdout.write("", done);
    },
    read: (deliver, done) => {
      process.stdin.on("data", deliver);
      process.stdin.on("end", done);
    },
  }).pipe(
    Effect.mapError(
      (refused) => new HostUnavailable({ dir: env.stateDir, reason: refused.reason }),
    ),
  );
}, Effect.scoped);
