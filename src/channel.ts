import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { Data, Effect, Option, Schema, flow, Result } from "effect";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import type { Declaration } from "./board-model";
import { isString } from "./schema";

const DECLARE_REQUEST = "bridge";

const encodeFrame = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.TaggedStruct("Exit", {
      requestId: Schema.Union([Schema.String, Schema.Finite]),
      exit: Schema.Struct({ _tag: Schema.String }),
    }),
  ),
);

export class ChannelRefused extends Data.TaggedError("ChannelRefused")<{
  readonly reason: string;
}> {}

export interface FarEnd {
  readonly write: (chunk: Uint8Array) => void;
  readonly end: (done: () => void) => void;
  readonly read: (deliver: (chunk: Uint8Array) => void, done: () => void) => void;
  // WARNING: called once the host takes the declaration, before any of its bytes.
  readonly ready?: () => void;
}

const frameOf = (payload: Declaration) => {
  const declare: RpcMessage.RequestEncoded = {
    _tag: "Request",
    id: DECLARE_REQUEST,
    tag: "declare",
    payload,
    headers: [],
  };
  return `${encodeFrame(declare)}\n`;
};

// WARNING: the declaration is made here from this end's knowledge, so the far end cannot change it.
export const channelInto = (socket: string | Socket, declaration: Declaration, far: FarEnd) =>
  Effect.callback<void, ChannelRefused>((resume) => {
    const refuse = (reason: string) => resume(Effect.fail(new ChannelRefused({ reason })));
    const conn = isString(socket) ? createConnection(socket) : socket;
    let reply = "";
    let ready = false;
    const handshake = (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      const end = Option.getOrElse(pipe(reply, Str.indexOf("\n")), () => -1);
      if (end === -1) {
        return;
      }
      conn.off("data", handshake);
      const line = pipe(reply, Str.slice(0, end));
      const answer = decodeReply(line);
      if (Option.isNone(answer) || answer.value.requestId !== DECLARE_REQUEST) {
        return refuse(`the host answered the declaration with ${line}`);
      }
      if (answer.value.exit._tag !== "Success") {
        return refuse(`the host refused the declaration: ${line}`);
      }
      ready = true;
      far.ready?.();
      const rest = pipe(reply, Str.slice(end + 1));
      if (rest !== "") {
        far.write(Buffer.from(rest, "utf8"));
      }
      conn.on("data", (more: Buffer) => far.write(more));
      far.read(
        (chunk) => conn.write(chunk),
        () => conn.end(),
      );
    };
    conn.on("data", handshake);
    if (conn.connecting) {
      conn.once("connect", () => conn.write(frameOf(declaration)));
    } else {
      conn.write(frameOf(declaration));
    }
    conn.on("error", (cause) => refuse(String(cause)));
    conn.on("close", () => {
      if (!ready) {
        return refuse("the host hung up before it answered the declaration");
      }
      far.end(() => resume(Effect.void));
    });
    conn.resume();
    return Effect.sync(() => conn.destroy());
  });
