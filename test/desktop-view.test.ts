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
  applyItem,
  DesktopRpcs,
  EMPTY_FLOCK,
  type FlockItem,
  flockCards,
  flockOf,
  type Machine,
  nameAsShown,
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

const machine = { installation: "inst-1", profile: "local", name: "mk-pc" };
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
    Layer.provide(
      DesktopRpcs.toLayer({
        flock: () => Stream.fromIterable(told),
        act: () => Effect.die("not asked"),
        offers: () => Effect.die("not asked"),
        workflows: () => Effect.die("not asked"),
        say: () => Stream.die("not asked"),
        goToPane: () => Effect.die("not asked"),
        openLink: () => Effect.die("not asked"),
        updates: () => Stream.die("not asked"),
        restart: () => Effect.die("not asked"),
        checkForUpdates: () => Effect.die("not asked"),
        onboard: () => Effect.die("not asked"),
        addMachine: () => Effect.die("not asked"),
        answerHerdr: () => Effect.die("not asked"),
        removeMachine: () => Effect.die("not asked"),
        credentials: () => Stream.die("not asked"),
        saveGitlab: () => Effect.die("not asked"),
        saveGitlabHost: () => Effect.die("not asked"),
        saveHelle: () => Effect.die("not asked"),
        checkHelle: () => Effect.die("not asked"),
        openSlack: () => Effect.die("not asked"),
        copyText: () => Effect.die("not asked"),
        claudeLogin: () => Effect.die("not asked"),
        pasteCode: () => Effect.die("not asked"),
        terminal: () => Stream.die("not asked"),
        terminalSend: () => Effect.die("not asked"),
        runDetail: () => Stream.die("not asked"),
        runFile: () => Effect.die("not asked"),
        answer: () => Effect.die("not asked"),
        transcript: () => Effect.die("not asked"),
        conversations: () => Effect.die("not asked"),
        reopen: () => Effect.die("not asked"),
        popOut: () => Effect.die("not asked"),
        popIn: () => Effect.die("not asked"),
        desktopTurns: () => Stream.die("not asked"),
        settings: () => Effect.die("not asked"),
        setSettings: () => Effect.die("not asked"),
      }),
    ),
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
        const tasks = flockCards(flock ?? EMPTY_FLOCK).tasks;
        expect(tasks.map((one) => [one.id, one.state])).toEqual([["t-work", "blocked"]]);
        expect(sectionsOf(tasks, "").needs.map((one) => one.name)).toEqual(["Busy"]);
        expect(headerSentence(tasks).text).toBe("One task is waiting on you. 0 working.");
      }
    }).pipe(Effect.scoped),
  ));

const snapshot = (
  machine: Machine,
  tasks: ReadonlyArray<typeof asking>,
  herds: ReadonlyArray<{ id: string; name?: string }> = [{ id: "default" }],
): MachineMessage => ({
  machine,
  message: {
    _tag: "Snapshot",
    installation: machine.installation,
    build: "0.31.0",
    protocol: 1,
    herds,
    tasks,
    seq: 0,
  },
});
const pc = { installation: "inst-pc", profile: "local", name: "mk-pc" };
const vm = {
  installation: "inst-vm",
  profile: "p-vm",
  name: "vm-mk",
  target: "mk@vm-mk.cegohost.dk",
};
const where = (items: ReadonlyArray<FlockItem>) => {
  const { tasks, placedOf } = flockCards(items.reduce(applyItem, EMPTY_FLOCK));
  return tasks.map((one) => [one.id, placedOf(one).where]);
};

test("a snapshot replaces what its installation said before, whatever it is called, and leaves other Machines alone", () => {
  expect(
    where([
      snapshot(pc, [asking]),
      snapshot(vm, [working]),
      snapshot({ ...pc, name: "renamed in herdr" }, [{ ...asking, id: "t-new" }]),
    ]),
  ).toEqual([
    ["t-new", "renamed in herdr"],
    ["t-work", "vm-mk"],
  ]);
});

test("a card names its Machine only once the Flock has more than one", () => {
  expect(where([snapshot(pc, [asking])])).toEqual([["t-ask", ""]]);
  expect(where([snapshot(pc, [asking]), snapshot(vm, [{ ...working, id: "t-ask" }])])).toEqual([
    ["t-ask", "mk-pc"],
    ["t-ask", "vm-mk"],
  ]);
});

test("a card names its Herd only when its Machine runs several", () => {
  const herds = [{ id: "h1", name: "default" }, { id: "h2", name: "work" }, { id: "h3" }];
  expect(
    where([
      snapshot(pc, [{ ...working, id: "t-pc", herd: "h1", at: 1 }]),
      snapshot(
        vm,
        [
          { ...asking, herd: "h2" },
          { ...working, herd: "h3" },
        ],
        herds,
      ),
    ]),
  ).toEqual([
    ["t-ask", "vm-mk · work"],
    ["t-work", "vm-mk · h3"],
    ["t-pc", "mk-pc"],
  ]);
});

test("Machines that share a name are told apart by how they are reached, and nothing else is renamed", () => {
  const other = { installation: "inst-vm2", profile: "p-vm2", name: "vm-mk", target: "mk@vm-mk2" };
  expect(
    where([
      snapshot({ ...pc, name: "vm-mk" }, [asking]),
      snapshot(vm, [{ ...working, id: "t-vm" }]),
      snapshot(other, [working]),
    ]),
  ).toEqual([
    ["t-ask", "vm-mk (local)"],
    ["t-vm", "vm-mk (mk@vm-mk.cegohost.dk)"],
    ["t-work", "vm-mk (mk@vm-mk2)"],
  ]);
});

test("the chat calls a live Machine what its cards call it, a saved board's Machine among them", () => {
  const away = { installation: "inst-away", profile: "p-away", name: "mk-pc", target: "mk@away" };
  const flock = [
    { _tag: "Saved", machine: away, herds: [{ id: "default" }], tasks: [working], at: 7 } as const,
    snapshot(pc, [asking]),
  ].reduce(applyItem, EMPTY_FLOCK);
  expect(nameAsShown(flock)(pc)).toBe("mk-pc (local)");
  const { tasks, placedOf } = flockCards(flock);
  const card = tasks.find((one) => one.id === "t-ask")!;
  expect(placedOf(card).machine).toBe("mk-pc (local)");
});

test("the sections and the header sentence count every Machine's Tasks", () => {
  const { tasks } = flockCards(
    [snapshot(pc, [asking]), snapshot(vm, [{ ...asking, id: "t-vm" }, working])].reduce(
      applyItem,
      EMPTY_FLOCK,
    ),
  );
  expect(sectionsOf(tasks, "").needs.map((one) => one.id)).toEqual(["t-ask", "t-vm"]);
  expect(headerSentence(tasks).text).toBe("2 tasks are waiting on you. 1 working.");
});

const lostVm = (state: "unreachable" | "sso" | "no-collie", at = 1_000): FlockItem => ({
  _tag: "Lost",
  machine: { profile: vm.profile, name: vm.name, target: vm.target },
  state,
  reason: "ssh: connection refused",
  at,
});
const asOf = (flock: ReturnType<typeof applyItem>) =>
  flockCards(flock).tasks.map((one) => [one.id, flockCards(flock).placedOf(one).asOf]);

test("a route out of reach is said by name until its Machine reports through it again", () => {
  const after = [snapshot(pc, [asking]), lostVm("unreachable")].reduce(applyItem, EMPTY_FLOCK);
  expect([...after.lost.values()]).toEqual([
    { name: "vm-mk", state: "unreachable", reason: "ssh: connection refused" },
  ]);
  expect(flockCards(after).tasks.map((one) => one.id)).toEqual(["t-ask"]);
  expect([...applyItem(after, snapshot(vm, [])).lost]).toEqual([]);
});

test("a Machine that drops keeps its cards as of when, off the machines a run can start on, until it is live again", () => {
  const dropped = [
    snapshot(pc, [asking]),
    snapshot(vm, [working]),
    lostVm("unreachable", 5),
  ].reduce(applyItem, EMPTY_FLOCK);
  expect(asOf(dropped)).toEqual([
    ["t-ask", null],
    ["t-work", 5],
  ]);
  expect(flockCards(dropped).machines.map((one) => one.name)).toEqual(["mk-pc"]);
  // Still out of reach later, it is as of when it dropped.
  expect(asOf(applyItem(dropped, lostVm("sso", 9)))).toEqual([
    ["t-ask", null],
    ["t-work", 5],
  ]);
  expect(asOf(applyItem(dropped, snapshot(vm, [working])))).toEqual([
    ["t-ask", null],
    ["t-work", null],
  ]);
});

test("a saved board stands in, as of when it was saved, until its Machine is live, and never over a live one", () => {
  const saved: FlockItem = {
    _tag: "Saved",
    machine: vm,
    herds: [{ id: "default" }],
    tasks: [working],
    at: 7,
  };
  const launched = [saved].reduce(applyItem, EMPTY_FLOCK);
  expect(asOf(launched)).toEqual([["t-work", 7]]);
  expect(asOf(applyItem(launched, snapshot(vm, [asking])))).toEqual([["t-ask", null]]);
  const live = [snapshot(vm, [asking]), saved].reduce(applyItem, EMPTY_FLOCK);
  expect(asOf(live)).toEqual([["t-ask", null]]);
});

test("a Machine without Collie is known by its herdr profile until its host names its installation", () => {
  const bare = [snapshot(pc, [asking]), lostVm("no-collie")].reduce(applyItem, EMPTY_FLOCK);
  expect([...bare.lost.keys()]).toEqual(["p-vm"]);
  const installed = applyItem(bare, snapshot(vm, [working]));
  expect([...installed.lost]).toEqual([]);
  expect([...installed.machines.keys()]).toEqual(["inst-pc", "inst-vm"]);
  // One that reaches a Machine already shown merges into it.
  const merged = applyItem(bare, {
    _tag: "Merged",
    machine: { profile: "p-vm", name: "vm-mk" },
  });
  expect([...merged.lost]).toEqual([]);
  expect([...merged.machines.keys()]).toEqual(["inst-pc"]);
});
