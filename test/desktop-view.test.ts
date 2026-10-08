// Desktop's view hears the Flock from its main process over Effect RPC on a channel that
// carries JSON values, as Electrobun's does, and decodes it with the board's own Schemas.

import { expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";
import { headerSentence, sectionsOf } from "../src/board-model";
import { afterGesture, type BoardState } from "../desktop/src/shared/board-clicks";
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
  machineRows,
  type MachineRow,
  nameAsShown,
  type MachineMessage,
  machineToAdd,
} from "../desktop/src/shared/flock";
import {
  buildOf,
  flockInSync,
  flockInSyncSaid,
  inSync,
  syncable,
} from "../desktop/src/shared/in-sync";
import { agentRows } from "../desktop/src/shared/run-agents";
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
        syncNow: () => Effect.die("not asked"),
        credentials: () => Stream.die("not asked"),
        flockSettings: () => Stream.die("not asked"),
        setFlockSetting: () => Effect.die("not asked"),
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
        usage: () => Effect.die("not asked"),
        stage: () => Effect.die("not asked"),
        attachmentFile: () => Effect.die("not asked"),
        stagePaths: () => Effect.die("not asked"),
        pickFiles: () => Effect.die("not asked"),
        clipboardFiles: () => Effect.die("not asked"),
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

test("a Flock that has heard nothing draws no board, not an empty one", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const boards = yield* flockOf(Stream.empty).pipe(Stream.runCollect);
      expect(boards).toEqual([]);
    }),
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

test("a Machine's row says why it isn't live, and nothing once it is", () => {
  const lost = [routed(vm), lostVm("unreachable")].reduce(applyItem, EMPTY_FLOCK);
  expect(machineRows(lost)[0]).toMatchObject({
    state: "unreachable",
    reason: "ssh: connection refused",
  });
  expect(machineRows(applyItem(lost, snapshot(vm, [])))[0]).toMatchObject({
    state: "live",
    reason: null,
  });
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

const built = (machine: Machine, build: string, development: string): MachineMessage => ({
  machine,
  message: {
    _tag: "Snapshot",
    installation: machine.installation,
    build,
    development,
    protocol: 1,
    herds: [],
    tasks: [],
    seq: 0,
  },
});
const routed = (machine: Machine): FlockItem => ({
  _tag: "Routed",
  machine: { profile: machine.profile, name: machine.name, target: machine.target },
});

test("a Machine's build is kept from its Snapshot, and a saved board's stands in until it is live", () => {
  const saved: FlockItem = {
    _tag: "Saved",
    machine: vm,
    herds: [],
    tasks: [],
    build: "0.34.0",
    development: null,
    at: 7,
  };
  const rowOf = (items: ReadonlyArray<FlockItem>) =>
    machineRows(items.reduce(applyItem, EMPTY_FLOCK)).find(({ profile }) => profile === vm.profile);
  expect(rowOf([routed(vm)])).toMatchObject({ build: null, development: null });
  expect(rowOf([routed(vm), saved])).toMatchObject({ build: "0.34.0", development: null });
  expect(rowOf([routed(vm), saved, built(vm, "0.35.0+abc1234", "0.35.0+abc1234")])).toMatchObject({
    state: "live",
    build: "0.35.0+abc1234",
    development: "0.35.0+abc1234",
  });
});

const row = (over: Partial<MachineRow> = {}): MachineRow => ({
  profile: "p-vm",
  name: "vm-mk",
  target: "mk@vm-mk",
  state: "live",
  onboarded: null,
  build: "0.35.0",
  development: null,
  settings: null,
  credentials: {},
  reason: null,
  ...over,
});
const doctored = (ready: boolean) => ({
  steps: ready
    ? []
    : [{ step: "helle", title: "Helle", status: "failed" as const, command: "collie onboard" }],
  asked: null,
  ready,
  reason: null,
  at: 1,
});
const DESKTOP = { version: "0.35.0", credentials: ["gitlab", "helle"] as const };

test("a live Machine on Desktop's release, doctored onboarded, is in sync", () => {
  expect(inSync(row({ onboarded: doctored(true) }), DESKTOP)).toEqual({
    state: "in-sync",
    behind: [],
  });
});

test("an older release is behind on its version, saying both", () => {
  expect(inSync(row({ build: "0.34.0" }), DESKTOP)).toEqual({
    state: "behind",
    behind: [{ part: "version", said: "Runs Collie 0.34.0; Desktop is 0.35.0", steps: [] }],
  });
  expect(inSync(row({ build: "0.9.0" }), { ...DESKTOP, version: "0.10.0" }).state).toBe("behind");
  expect(inSync(row({ build: "0.36.0" }), DESKTOP).state).toBe("in-sync");
});

test("a development checkout, or a Desktop that isn't a release, is never behind on its version", () => {
  expect(
    inSync(row({ build: "0.34.0+abc1234", development: "0.34.0+abc1234" }), DESKTOP).state,
  ).toBe("in-sync");
  expect(inSync(row({ build: "0.34.0" }), { ...DESKTOP, version: "0.35.0+def5678" }).state).toBe(
    "in-sync",
  );
});

test("a Machine doctor doesn't find onboarded is behind on onboarding, with its steps; one not yet doctored isn't", () => {
  const verdict = inSync(row({ onboarded: doctored(false) }), DESKTOP);
  expect(verdict.state).toBe("behind");
  expect(verdict.behind).toEqual([
    expect.objectContaining({ part: "onboarding", steps: doctored(false).steps }),
  ]);
  expect(inSync(row({ onboarded: null }), DESKTOP).state).toBe("in-sync");
});

test("a Machine not live is its state, and one connecting has no verdict", () => {
  for (const state of ["unreachable", "sso", "no-collie", "update-desktop"] as const)
    expect(inSync(row({ state, build: "0.30.0" }), DESKTOP)).toEqual({ state, behind: [] });
  expect(inSync(row({ state: "connecting" }), DESKTOP)).toEqual({
    state: "connecting",
    behind: [],
  });
});

test("the Flock's summary names Desktop's version, or each Machine that lags and how", () => {
  const level = flockInSync(
    [row({ name: "mk-pc" }), row({ state: "connecting", name: "vm-b" })],
    DESKTOP,
  );
  expect(level).toEqual({ said: "Every Machine is in sync with Desktop 0.35.0", count: 0 });
  const mixed = flockInSync(
    [
      row({ name: "mk-pc" }),
      row({ build: "0.34.0", onboarded: doctored(false) }),
      row({ name: "vm-c", state: "unreachable" }),
      row({ name: "vm-d", state: "connecting" }),
    ],
    DESKTOP,
  );
  expect(mixed).toEqual({
    said: "Not in sync with Desktop 0.35.0: vm-mk: behind on version and onboarding; vm-c: Out of reach",
    count: 2,
  });
});

test("a row says the Collie it runs, a development build's own, or that it isn't known yet", () => {
  expect(buildOf(row())).toBe("Collie 0.35.0");
  expect(buildOf(row({ development: "0.35.0+abc1234" }))).toBe("development build 0.35.0+abc1234");
  expect(buildOf(row({ build: null }))).toBe("Build not known yet");
});

test("Sync now is offered for what connecting redoes, and not for onboarding alone", () => {
  expect(syncable(inSync(row({ build: "0.34.0" }), DESKTOP))).toBe(true);
  expect(syncable(inSync(row({ settings: { failed: "host refused" } }), DESKTOP))).toBe(true);
  expect(syncable(inSync(row({ onboarded: doctored(false) }), DESKTOP))).toBe(false);
  expect(syncable(inSync(row(), DESKTOP))).toBe(false);
});

test("the Flock chat reads the summary, then why each lagging Machine is behind", () => {
  expect(
    flockInSyncSaid(
      [row({ name: "mk-pc" }), row({ settings: { failed: "host refused" } })],
      DESKTOP,
    ),
  ).toBe(
    "Not in sync with Desktop 0.35.0: vm-mk: behind on settings. vm-mk: Settings didn't sync: host refused",
  );
});

test("a Machine whose last settings sync failed is behind on settings, with why; one not yet synced isn't", () => {
  expect(inSync(row({ settings: { failed: "host refused" } }), DESKTOP)).toEqual({
    state: "behind",
    behind: [{ part: "settings", said: "Settings didn't sync: host refused", steps: [] }],
  });
  expect(inSync(row({ settings: { failed: null } }), DESKTOP).state).toBe("in-sync");
  expect(inSync(row({ settings: null }), DESKTOP).state).toBe("in-sync");
});

test("a Machine lacking a credential Desktop holds is behind on it, naming it and why a give failed", () => {
  const holds = DESKTOP;
  const lacking = row({
    credentials: {
      gitlab: { given: false, failed: "glab: not found" },
      helle: { given: false, failed: null },
    },
  });
  expect(inSync(lacking, holds)).toEqual({
    state: "behind",
    behind: [
      { part: "credentials", said: "Lacks the GitLab token: glab: not found", steps: [] },
      { part: "credentials", said: "Lacks Helle's token", steps: [] },
    ],
  });
  // A credential Desktop doesn't hold is never a Machine's to lack.
  expect(inSync(lacking, { ...DESKTOP, credentials: [] }).state).toBe("in-sync");
  expect(inSync(row({ credentials: { gitlab: { given: true, failed: null } } }), holds).state).toBe(
    "in-sync",
  );
  // Not told yet is not behind.
  expect(inSync(row({ credentials: {} }), holds).state).toBe("in-sync");
});

test("the summary says which credentials Desktop has none of to give, and blames no Machine for them", () => {
  const rows = [row({ credentials: { gitlab: { given: false, failed: null } } })];
  expect(flockInSync(rows, { ...DESKTOP, credentials: ["helle"] })).toEqual({
    said: "Every Machine is in sync with Desktop 0.35.0. Desktop has no GitLab token to give",
    count: 0,
  });
  expect(flockInSync(rows, { ...DESKTOP, credentials: ["gitlab"] })).toEqual({
    said: "Not in sync with Desktop 0.35.0: vm-mk: behind on credentials. Desktop has no Helle token to give",
    count: 1,
  });
});

test("a Machine's settings sync and its credentials are kept on its row, and dropped with it", () => {
  const items: FlockItem[] = [
    routed(vm),
    { _tag: "Synced", machine: vm, failed: "host refused" },
    { _tag: "Given", machine: vm, credential: "gitlab", given: false, failed: "nope" },
    { _tag: "Given", machine: vm, credential: "gitlab", given: true, failed: null },
  ];
  const flock = items.reduce(applyItem, EMPTY_FLOCK);
  expect(machineRows(flock)[0]).toMatchObject({
    settings: { failed: "host refused" },
    credentials: { gitlab: { given: true, failed: null } },
  });
  const removed = applyItem(flock, {
    _tag: "Removed",
    machine: { profile: vm.profile, name: vm.name },
  });
  expect(removed.synced.size + removed.given.size).toBe(0);
});

test("Add Machine takes a Machine only once its SSH target, label and session are filled", () => {
  expect(machineToAdd({ target: " mk@vm ", label: "vm ", session: " default" })).toEqual({
    target: "mk@vm",
    label: "vm",
    session: "default",
  });
  for (const blank of ["target", "label", "session"] as const)
    expect(
      machineToAdd({ target: "mk@vm", label: "vm", session: "default", [blank]: "  " }),
    ).toBeNull();
});

const none: BoardState = { selected: null, page: null };
const picked: BoardState = { selected: "pc:a", page: null };
const reading: BoardState = { selected: "pc:a", page: "pc:a" };
const card = (key: string, asOf = false) => ({ on: "card", card: key, asOf }) as const;
const control = { on: "control" } as const;
const background = { on: "background" } as const;

test("a click on a card selects it, again on it keeps it, and on another moves to that one", () => {
  expect(afterGesture(none, { kind: "click", landed: card("pc:a") })).toEqual(picked);
  expect(afterGesture(picked, { kind: "click", landed: card("pc:a") })).toEqual(picked);
  expect(afterGesture(picked, { kind: "click", landed: card("pc:b") })).toEqual({
    selected: "pc:b",
    page: null,
  });
});

test("a click on a card leaves an open record as it is", () => {
  expect(afterGesture(reading, { kind: "click", landed: card("pc:b") })).toEqual({
    selected: "pc:b",
    page: "pc:a",
  });
});

test("a click or double-click on a control does only what the control does", () => {
  for (const kind of ["click", "double-click"] as const) {
    expect(afterGesture(picked, { kind, landed: control })).toEqual(picked);
    expect(afterGesture(reading, { kind, landed: control })).toEqual(reading);
  }
});

test("a click or double-click on the background lets the card go, unless a page is open", () => {
  for (const kind of ["click", "double-click"] as const) {
    expect(afterGesture(picked, { kind, landed: background })).toEqual(none);
    expect(afterGesture(reading, { kind, landed: background })).toEqual(reading);
  }
});

test("a double-click on a card selects it and opens its record", () => {
  expect(afterGesture(none, { kind: "double-click", landed: card("pc:a") })).toEqual(reading);
});

test("a double-click on a card shown as of selects it and opens nothing", () => {
  expect(afterGesture(none, { kind: "double-click", landed: card("pc:a", true) })).toEqual(picked);
});

test("pressing a card's name selects it and opens its record", () => {
  expect(afterGesture({ selected: "pc:b", page: null }, { kind: "name", card: "pc:a" })).toEqual(
    reading,
  );
});

test("closing the record keeps the card selected", () => {
  expect(afterGesture(reading, { kind: "close" })).toEqual(picked);
});

test("Escape with an overlay open or while typing is theirs", () => {
  for (const state of [none, picked, reading]) {
    expect(afterGesture(state, { kind: "escape", overlay: true, typing: false })).toEqual(state);
    expect(afterGesture(state, { kind: "escape", overlay: false, typing: true })).toEqual(state);
  }
});

test("Escape closes an open page and keeps the card selected", () => {
  expect(afterGesture(reading, { kind: "escape", overlay: false, typing: false })).toEqual(picked);
  expect(
    afterGesture(
      { ...picked, page: "settings" },
      { kind: "escape", overlay: false, typing: false },
    ),
  ).toEqual(picked);
});

test("Escape on the board lets the selected card go", () => {
  expect(afterGesture(picked, { kind: "escape", overlay: false, typing: false })).toEqual(none);
});

test("a record's Agents section is one row per agent, in launch order, saying what it ran on", () => {
  expect(
    agentRows([
      {
        operation: "build",
        agent: "r1-build-r1",
        harness: "claude",
        model: "opus",
        effort: "medium",
        from: null,
        why: null,
      },
      {
        operation: "review",
        agent: "r1-review-r1",
        harness: "codex",
        model: null,
        effort: null,
        from: { harness: "claude", model: "opus", effort: "xhigh" },
        why: "session 100%, resets 15:45",
      },
      {
        operation: "build",
        agent: "r1-build-r2",
        harness: "claude",
        model: "opus",
        effort: "medium",
        from: null,
        why: null,
      },
    ]),
  ).toEqual([
    { key: "0:r1-build-r1", operation: "build", ranOn: "claude/opus medium", agent: "r1-build-r1" },
    {
      key: "1:r1-review-r1",
      operation: "review",
      ranOn: "codex/default (fell back from claude/opus xhigh: session 100%, resets 15:45)",
      agent: "r1-review-r1",
    },
    { key: "2:r1-build-r2", operation: "build", ranOn: "claude/opus medium", agent: "r1-build-r2" },
  ]);
});
