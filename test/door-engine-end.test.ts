import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { engineEnd } from "../src/door";
import type { FromDoor, ToDoor } from "../src/door";
import { runEffect } from "./support/effect";

const Ping = Rpc.make("ping", { success: Schema.String });
const Ticks = Rpc.make("ticks", { success: Schema.Finite, stream: true });
const Group = RpcGroup.make(Ping, Ticks);

const handlers = Group.toLayer({
  ping: () => Effect.succeed("pong"),
  ticks: () => Stream.never,
});

const until = (done: () => boolean) =>
  Effect.gen(function* () {
    while (!done()) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeout("2 seconds"));

const served = Effect.gen(function* () {
  const told: Array<ToDoor> = [];
  let receive: (message: FromDoor) => void = () => {};
  const engine = yield* engineEnd({
    post: (message) => void told.push(message),
    listen: (deliver) => {
      receive = deliver;
    },
  });
  yield* Layer.build(
    RpcServer.layer(Group).pipe(Layer.provide(handlers), Layer.provide(engine.protocol)),
  ).pipe(Effect.forkScoped);
  receive({ _tag: "Listening" });
  const frame = (conn: number, frame: RpcMessage.FromClientEncoded) =>
    receive({ _tag: "Request", conn, frame });
  const request = (conn: number, id: string, tag: string) =>
    frame(conn, { _tag: "Request", id, tag, payload: null, headers: [] });
  const answered = (conn: number, id: string) =>
    Arr.some(
      told,
      (one) =>
        one._tag === "Response" &&
        one.conn === conn &&
        one.frame._tag === "Exit" &&
        String(one.frame.requestId) === id,
    );
  return { frame, request, answered };
});

test("a client that half-closed and still writes leaves every other client answered", () =>
  runEffect(
    Effect.gen(function* () {
      const { frame, request, answered } = yield* served;

      request(1, "a", "ping");
      yield* until(() => answered(1, "a"));

      // WARNING: One client's frame must not end the shared loop: a half-closed connection's late frame is refused for that connection alone.
      request(2, "s", "ticks");
      frame(2, { _tag: "Eof" });
      frame(2, { _tag: "Ack", requestId: "gone" });

      request(3, "b", "ping");
      yield* until(() => answered(3, "b"));
      expect(answered(3, "b")).toBe(true);
    }),
  ));
