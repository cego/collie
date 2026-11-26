import * as Str from "effect/String";
import * as Struct from "effect/Struct";

import { Config, Effect, Option } from "effect";
import { BRIDGE_READY } from "./board-model";
import type { Declaration, FrontDoor, Where } from "./board-model";
import { channelInto } from "./channel";
import { currentEnv } from "./env";
import { HostUnavailable, connect, peerChannel, socketOf } from "./host";
import { ensurePaired, riding } from "./lifecycle";
import { machineName } from "./peers";
import { recordMarks, relayedRecords } from "./record-marks";
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
  if (client !== null) {
    where = { ...where, client };
  }
  if (ssh !== undefined && ssh !== "") {
    where = { ...where, ssh };
  }
  return Struct.keys(where).length === 0 ? undefined : where;
});

export const bridge = Effect.fn("Bridge")(function* (
  as: FrontDoor,
  client: string | null,
  machine: string | null = null,
) {
  const env = yield* currentEnv.pipe(Effect.orDie);
  // WARNING: a host on another build is still piped to; front doors speak a protocol, not a build.
  yield* Effect.scoped(
    connect(env.stateDir, {
      hostEnv: { COLLIE_STATE_DIR: env.stateDir },
    }),
  ).pipe(Effect.catchTag("HostVersionMismatch", () => Effect.void));
  const from = yield* whereFrom(client);
  const declaration: Declaration = from === undefined ? { frontDoor: as } : { frontDoor: as, from };
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
  const mark = yield* recordMarks;
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const relayed = relayedRecords();
  const fromHost = new TextDecoder();
  const toHost = new TextDecoder();
  return yield* channelInto(socket, declaration, {
    ready: () => process.stdout.write(`${BRIDGE_READY}\n`),
    write: (chunk) => {
      process.stdout.write(chunk);
      if (mark !== null) {
        for (const runId of relayed.answered(fromHost.decode(chunk, { stream: true }))) {
          run(mark("bridge:relay", runId));
        }
      }
    },
    end: (done) => {
      process.stdin.destroy();
      process.stdout.write("", done);
    },
    read: (deliver, done) => {
      process.stdin.on("data", (chunk: Buffer) => {
        if (mark !== null) {
          relayed.asked(toHost.decode(chunk, { stream: true }));
        }
        deliver(chunk);
      });
      process.stdin.on("end", done);
    },
  }).pipe(
    Effect.mapError(
      (refused) => new HostUnavailable({ dir: env.stateDir, reason: refused.reason }),
    ),
  );
}, Effect.scoped);
