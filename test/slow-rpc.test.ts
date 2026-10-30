import { expect, test } from "bun:test";
import { Effect, Layer, Logger, Schema, Stream } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { SlowRpcs, slowRpcsLayer } from "../src/host";
import { fastForward, runEffect } from "./support/effect";

const Probe = RpcGroup.make(
  Rpc.make("answer", { payload: { ms: Schema.Finite } }),
  Rpc.make("follow", { success: Schema.Finite, stream: true }),
).middleware(SlowRpcs);

const warnedAsking = <E>(
  ask: (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof Probe>>) => Effect.Effect<unknown, E>,
) =>
  Effect.gen(function* () {
    const warned: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warned.push(String(message));
    });
    yield* Effect.scoped(Effect.flatMap(RpcTest.makeClient(Probe), ask)).pipe(
      Effect.provide(
        Layer.mergeAll(
          Probe.toLayer({
            answer: ({ ms }) => Effect.sleep(ms),
            follow: () => Stream.fromEffect(Effect.sleep("5 minutes").pipe(Effect.as(1))),
          }),
          slowRpcsLayer,
          Logger.layer([logger]),
        ),
      ),
      (asked) => fastForward(asked, 1_000),
    );
    return warned;
  });

test("an RPC that takes over 2 s is logged at warn with its name and how long it took", () =>
  runEffect(
    Effect.gen(function* () {
      const slow = yield* warnedAsking((client) => client.answer({ ms: 3_000 }));
      expect(slow).toHaveLength(1);
      expect(slow[0]).toMatch(/the answer RPC took \d+ ms/);
    }),
  ));

test("a fast RPC, and a stream that stays open for minutes, are not logged", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* warnedAsking((client) => client.answer({ ms: 1_000 }))).toEqual([]);
      expect(yield* warnedAsking((client) => Stream.runDrain(client.follow()))).toEqual([]);
    }),
  ));
