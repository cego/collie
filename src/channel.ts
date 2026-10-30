// A channel into a host: a fresh connection to its socket, declared, then piped to a byte
// stream at the far end. `collie bridge` hands over its stdio this way, and a paired
// Machine's link its WebSocket (ADR-0057 D4). The declaration is made here, from what this
// end knows, so nothing at the far end can change it.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { createConnection, type Socket } from "node:net";
import { Data, Effect, Option, Schema, flow, Result } from "effect";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import type { Declaration } from "./board-model";
import { isString } from "./schema";

const DECLARE_REQUEST = "bridge";

const encodeFrame = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

/** The host's answer to the declaration, as much of it as says whether it was taken. */
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

/** The byte stream at the far end of a channel. */
export interface FarEnd {
  /** Bytes from the host, in order. */
  readonly write: (chunk: Uint8Array) => void;
  /** The host hung up; `done` once what was written has gone. */
  readonly end: (done: () => void) => void;
  /** Hands each chunk from the far end to `deliver` from now on, and calls `done` once it hangs up. */
  readonly read: (deliver: (chunk: Uint8Array) => void, done: () => void) => void;
  /** Told once the host has taken the declaration, before any of its bytes. */
  readonly ready?: () => void;
}

/** The declaration as the first frame on the connection. */
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

/**
 * Declares a channel on `socket`, then copies bytes both ways until either end hangs up.
 * Refused, with the host's words, when the declaration is not taken.
 */
export const channelInto = (socket: string | Socket, declaration: Declaration, far: FarEnd) =>
  Effect.callback<void, ChannelRefused>((resume) => {
    const refuse = (reason: string) => resume(Effect.fail(new ChannelRefused({ reason })));
    const conn = isString(socket) ? createConnection(socket) : socket;
    let reply = "";
    let ready = false;
    const handshake = (chunk: Buffer) => {
      reply += chunk.toString("utf8");
      const end = Option.getOrElse(pipe(reply, Str.indexOf("\n")), () => -1);
      if (end === -1) return;
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
      if (rest !== "") far.write(Buffer.from(rest, "utf8"));
      conn.on("data", (more: Buffer) => far.write(more));
      far.read(
        (chunk) => conn.write(chunk),
        () => conn.end(),
      );
    };
    conn.on("data", handshake);
    if (conn.connecting) conn.once("connect", () => conn.write(frameOf(declaration)));
    else conn.write(frameOf(declaration));
    conn.on("error", (cause) => refuse(String(cause)));
    conn.on("close", () => {
      if (!ready) return refuse("the host hung up before it answered the declaration");
      far.end(() => resume(Effect.void));
    });
    conn.resume();
    return Effect.sync(() => conn.destroy());
  });
