// `collie bridge`: a front door on any computer reaches this Machine's host through one
// command's stdio. The bridge is the Machine's own binary, so starting the host is done
// here, never by the client at the other end of the stream.

import { createConnection } from "node:net";
import { Config, Effect, Option, Schema } from "effect";
import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import { BRIDGE_READY, type Declaration, type FrontDoor, type Where } from "./board-model";
import { currentEnv } from "./env";
import { Herdr } from "./herdr";
import { HostUnavailable, connect, socketOf } from "./host";

const DECLARE_REQUEST = "bridge";

const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The host's answer to the declaration, as much of it as says whether it was taken. */
const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.Literal("Exit"),
      requestId: Schema.Union([Schema.String, Schema.Number]),
      exit: Schema.Struct({ _tag: Schema.String }),
    }),
  ),
);

/** Where this channel came from: the computer the front door names, and the SSH client sshd saw. */
const whereFrom = Effect.fn("Bridge.whereFrom")(function* (client: string | null) {
  const connection = yield* Config.option(Config.String("SSH_CONNECTION")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const ssh = Option.getOrUndefined(connection)?.split(" ")[0];
  let where: Where = {};
  if (client !== null) where = { ...where, client };
  if (ssh !== undefined && ssh !== "") where = { ...where, ssh };
  return Object.keys(where).length === 0 ? undefined : where;
});

export const bridge = Effect.fn("Bridge")(function* (as: FrontDoor, client: string | null) {
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
  const from = as === "desktop" ? yield* whereFrom(client) : undefined;
  const payload: Declaration =
    from === undefined ? { frontDoor: as, session } : { frontDoor: as, session, from };
  const declare: RpcMessage.RequestEncoded = {
    _tag: "Request",
    id: DECLARE_REQUEST,
    tag: "declare",
    payload,
    headers: [],
  };
  return yield* relay(env.stateDir, `${encodeFrame(declare)}\n`);
});

/**
 * Declares the channel, says it is ready, then copies bytes both ways until either end
 * hangs up. The declaration is the bridge's, so nothing at the other end can change it.
 */
const relay = (dir: string, declaration: string) =>
  Effect.callback<void, HostUnavailable>((resume) => {
    const refuse = (reason: string) => resume(Effect.fail(new HostUnavailable({ dir, reason })));
    const conn = createConnection(socketOf(dir));
    let reply = "";
    let ready = false;
    const handshake = (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      const end = reply.indexOf("\n");
      if (end === -1) return;
      conn.off("data", handshake);
      const line = reply.slice(0, end);
      const answer = decodeReply(line);
      if (Option.isNone(answer) || answer.value.requestId !== DECLARE_REQUEST) {
        return refuse(`the host answered the declaration with ${line}`);
      }
      if (answer.value.exit._tag !== "Success") {
        return refuse(`the host refused the declaration: ${line}`);
      }
      ready = true;
      process.stdout.write(`${BRIDGE_READY}\n`);
      const rest = reply.slice(end + 1);
      if (rest !== "") process.stdout.write(rest);
      conn.pipe(process.stdout, { end: false });
      process.stdin.pipe(conn);
    };
    conn.on("data", handshake);
    conn.on("connect", () => conn.write(declaration));
    conn.on("error", (cause) => refuse(String(cause)));
    conn.on("close", () => {
      process.stdin.unpipe(conn);
      process.stdin.destroy();
      if (!ready) return refuse("the host hung up before it answered the declaration");
      process.stdout.write("", () => resume(Effect.void));
    });
    return Effect.sync(() => conn.destroy());
  });
