// What an open record is drawn from keeps its identity while the board changes elsewhere, so
// Vue draws the record again only for a change to its own Task.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { Flow, TaskView } from "../src/board-model";
import {
  applyItem,
  EMPTY_FLOCK,
  flockCards,
  type Flock,
  type FlockItem,
} from "../desktop/src/shared/flock";
import { linkedCards } from "../desktop/src/shared/flow";
import { flowNode } from "./support/flow";
import { task } from "./support/task";

const machine = { installation: "inst-pc", profile: "local", name: "mk-pc" };
const vm = { installation: "inst-vm", profile: "p-vm", name: "vm-mk", target: "mk@vm" };
const snapshot = (on: typeof machine, tasks: ReadonlyArray<TaskView>): FlockItem => ({
  machine: on,
  message: {
    _tag: "Snapshot",
    installation: on.installation,
    build: "0.31.0",
    protocol: 1,
    herds: [{ id: "h1" }],
    tasks,
    seq: 0,
  },
});
const upsert = (one: TaskView, seq: number): FlockItem => ({
  machine,
  message: { _tag: "Upsert", seq, task: one },
});

const open = task({ id: "t-open", name: "Open", state: "active", at: 1 });
const linked = {
  ...task({ id: "t-linked", name: "Linked", state: "active", at: 2 }),
  runs: ["r-l"],
};
const other = task({ id: "t-other", name: "Other", state: "active", at: 3 });
/** A Flow whose one Step links to the Run of `linked`. */
const flow: Flow = {
  lanes: [
    {
      run: "r-open",
      workflow: "implement",
      title: "Implement",
      machine: "mk-pc",
      execution: "running",
      declared: true,
      requestedBy: null,
      nodes: [
        flowNode("child", { link: { run: "r-l", machine: null, state: "running", said: null } }),
      ],
    },
  ],
  current: null,
  release: null,
};

const drawnFrom = (flock: Flock, before?: ReturnType<typeof flockCards>) => {
  const board = flockCards(flock, before);
  const placed = Arr.map(board.tasks, board.placedOf);
  return { board, placed: board.byKey.get("inst-pc:t-open"), away: board.away, placedAll: placed };
};

test("board changes to other Tasks leave the open record's Task, cards and away as they were", () => {
  let flock = Arr.reduce(
    [snapshot(machine, [open, linked, other]), snapshot(vm, [])],
    EMPTY_FLOCK,
    applyItem,
  );
  const first = drawnFrom(flock);
  const cards = linkedCards(flow, first.placedAll);
  let last = first;
  let lastCards = cards;
  for (let seq = 1; seq <= 20; seq++) {
    flock = applyItem(
      flock,
      seq % 2 === 0
        ? upsert({ ...other, at: 100 + seq }, seq)
        : upsert({ ...linked, at: 100 + seq }, seq),
    );
    last = drawnFrom(flock, last.board);
    lastCards = linkedCards(flow, last.placedAll, lastCards);
    expect(last.placed).toBe(first.placed);
    expect(lastCards).toBe(cards);
    expect(last.away).toBe(first.away);
  }
  flock = applyItem(flock, upsert({ ...open, state: "blocked" }, 21));
  const moved = drawnFrom(flock, last.board);
  expect(moved.placed).not.toBe(first.placed);
  expect(moved.placed?.task.state).toBe("blocked");
});

test("a linked Task that gains a Run gives the record new cards", () => {
  let flock = applyItem(EMPTY_FLOCK, snapshot(machine, [open, linked]));
  const first = drawnFrom(flock);
  const cards = linkedCards(flow, first.placedAll);
  expect(Arr.map(cards, (card) => card.key)).toEqual(["inst-pc:t-linked"]);
  flock = applyItem(flock, upsert({ ...linked, runs: ["r-l", "r-2"] }, 1));
  const next = drawnFrom(flock, first.board);
  const moved = linkedCards(flow, next.placedAll, cards);
  expect(moved).not.toBe(cards);
  expect(moved[0]?.runs).toEqual(["r-l", "r-2"]);
});
