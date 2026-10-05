// Desktop's view hears the Flock from its main process over Effect RPC on a channel that
// carries JSON values, as Electrobun's does, and decodes it with the board's own Schemas.

import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { headerSentence, sectionsOf } from "../src/board-model";
import {
  type Channel,
  clientProtocol,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../desktop/src/shared/channel";
import {
  applyMessage,
  DesktopRpcs,
  EMPTY_FLOCK,
  flockOf,
  flockTasks,
  type MachineMessage,
} from "../desktop/src/shared/flock";
import { task } from "./support/task";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

/** Both ends of a channel that copies every frame through JSON, as Electrobun's does. */
const channels = () => {
  let toView: (frame: ToView) => void = () => {};
  let toMain: (frame: ToMain) => void = () => {};
  // SAFETY: what went in is what comes out; the JSON round trip only proves it survives one.
  const copy = <A>(frame: A) => fromJson(asJson(frame)) as A;
  const view: Channel<ToMain, ToView> = {
    send: (frame) => queueMicrotask(() => toMain(copy(frame))),
    listen: (receive) => {
      toView = receive;
    },
  };
  const main: Channel<ToView, ToMain> = {
    send: (frame) => queueMicrotask(() => toView(copy(frame))),
    listen: (receive) => {
      toMain = receive;
    },
  };
  return { view, main };
};

const machine = { installation: "inst-1", name: "mk-pc" };
const asking = task({ id: "t-ask", name: "Ask me", state: "blocked", at: 3 });
const working = task({ id: "t-work", name: "Busy", state: "active", at: 2 });
const told: ReadonlyArray<MachineMessage> = [
  {
    machine,
    message: {
      _tag: "Snapshot",
      installation: "inst-1",
      build: "0.31.0",
      protocol: 1,
      herds: [{ id: "h1" }],
      tasks: [asking, working],
      seq: 2,
    },
  },
  { machine, message: { _tag: "Unknown", kind: "Weather", seq: 3 } },
  { machine, message: { _tag: "Upsert", seq: 4, task: { ...working, state: "blocked" } } },
  { machine, message: { _tag: "Remove", seq: 5, id: "t-ask" } },
];

const served = (main: Channel<ToView, ToMain>) =>
  RpcServer.layer(DesktopRpcs).pipe(
    Layer.provide(DesktopRpcs.toLayer({ flock: () => Stream.fromIterable(told) })),
    Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(main))),
  );

test("the view decodes every board message its main process relays, a reload included", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { view, main } = channels();
      yield* Layer.build(served(main));
      const listen = Effect.gen(function* () {
        const client = yield* RpcClient.make(DesktopRpcs);
        const heard = yield* client.flock().pipe(Stream.take(told.length), Stream.runCollect);
        const boards = yield* flockOf(Stream.fromIterable(heard)).pipe(Stream.runCollect);
        return { heard, flock: boards.at(-1) };
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.effect(RpcClient.Protocol, clientProtocol(view))),
      );

      for (const _view of ["first", "after a reload"]) {
        const { heard, flock } = yield* listen;
        expect(heard).toEqual([...told]);
        const tasks = flockTasks(flock ?? EMPTY_FLOCK);
        expect(tasks.map((one) => [one.id, one.state])).toEqual([["t-work", "blocked"]]);
        expect(sectionsOf(tasks, "").needs.map((one) => one.name)).toEqual(["Busy"]);
        expect(headerSentence(tasks).text).toBe("One task is waiting on you. 0 working.");
      }
    }).pipe(Effect.scoped),
  ));

test("a snapshot replaces what its installation said before, whatever it is called, and leaves other Machines alone", () => {
  const snapshot = (name: string, tasks: ReadonlyArray<typeof asking>): MachineMessage => ({
    machine: { installation: `inst-${name}`, name },
    message: {
      _tag: "Snapshot",
      installation: name,
      build: "0.31.0",
      protocol: 1,
      herds: [],
      tasks,
      seq: 0,
    },
  });
  const flock = [
    snapshot("mk-pc", [asking]),
    snapshot("vm-mk", [working]),
    { ...snapshot("mk-pc", []), machine: { installation: "inst-mk-pc", name: "another route" } },
  ].reduce(applyMessage, EMPTY_FLOCK);
  expect(flockTasks(flock).map((one) => one.id)).toEqual(["t-work"]);
});
