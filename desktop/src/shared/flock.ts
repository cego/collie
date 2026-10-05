// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Schema, Stream } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { BoardMessage, type Herd, sortBoard, type TaskView } from "../../../src/board-model";

/**
 * A Machine as Desktop knows it: its installation id, the name a human reads, and the SSH
 * target it is reached through, which Local has none of.
 */
export const Machine = Schema.Struct({
  installation: Schema.String,
  name: Schema.String,
  target: Schema.optionalKey(Schema.String),
});
export type Machine = typeof Machine.Type;

/** One message of a Machine's board stream, as the host sent it, and which Machine sent it. */
export const MachineMessage = Schema.Struct({ machine: Machine, message: BoardMessage });
export type MachineMessage = typeof MachineMessage.Type;

/** A Machine Desktop could not reach, or lost, by the name it was reached as. */
export const MachineLost = Schema.TaggedStruct("Lost", {
  name: Schema.String,
  reason: Schema.String,
});
export type MachineLost = typeof MachineLost.Type;

export const FlockItem = Schema.Union([MachineMessage, MachineLost]);
export type FlockItem = typeof FlockItem.Type;

export const DesktopRpcs = RpcGroup.make(Rpc.make("flock", { success: FlockItem, stream: true }));

/** What a Machine's host last told: who it is, its Herds, and its Tasks by id. */
export interface FlockMachine {
  readonly machine: Machine;
  readonly herds: ReadonlyArray<Herd>;
  readonly tasks: ReadonlyMap<string, TaskView>;
}

/** Each Machine keyed by installation id, and the Machines out of reach by name. */
export interface Flock {
  readonly machines: ReadonlyMap<string, FlockMachine>;
  readonly lost: ReadonlyMap<string, string>;
}

export const EMPTY_FLOCK: Flock = { machines: new Map(), lost: new Map() };

/** A snapshot replaces its Machine; a change touches one Task; anything newer is skipped. */
export const applyItem = (flock: Flock, item: FlockItem): Flock => {
  if ("_tag" in item) return { ...flock, lost: new Map(flock.lost).set(item.name, item.reason) };
  const { machine, message } = item;
  if (message._tag === "Unknown") return flock;
  const known = flock.machines.get(machine.installation);
  const now: FlockMachine =
    message._tag === "Snapshot"
      ? { machine, herds: message.herds, tasks: new Map(message.tasks.map((t) => [t.id, t])) }
      : { machine, herds: known?.herds ?? [], tasks: new Map(known?.tasks) };
  // SAFETY: built here as a Map, and read back only through the readonly interface.
  const tasks = now.tasks as Map<string, TaskView>;
  if (message._tag === "Upsert") tasks.set(message.task.id, message.task);
  if (message._tag === "Remove") tasks.delete(message.id);
  const lost = new Map(flock.lost);
  lost.delete(machine.name);
  return { machines: new Map(flock.machines).set(machine.installation, now), lost };
};

/** Each Machine's display name: its own, or with how it is reached where two share one. */
const machineNames = (machines: ReadonlyArray<Machine>) => {
  const counts = new Map<string, number>();
  for (const { name } of machines) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    machines.map((m) => [
      m.installation,
      counts.get(m.name)! > 1 ? `${m.name} (${m.target ?? "local"})` : m.name,
    ]),
  );
};

/** A Task as the board draws it: keyed across the Flock, and where it is when that matters. */
export interface Card {
  readonly key: string;
  readonly task: TaskView;
  readonly where: string;
}

/**
 * Every Task of the Flock in the board's own order, and its card. A card names its Machine
 * once there is more than one, and its Herd only when its Machine runs several.
 */
export const flockCards = (flock: Flock) => {
  const names = machineNames([...flock.machines.values()].map(({ machine }) => machine));
  const cards = new Map<TaskView, Card>();
  for (const [installation, { herds, tasks }] of flock.machines) {
    for (const task of tasks.values()) {
      const herd = herds.length > 1 ? herds.find(({ id }) => id === task.herd) : undefined;
      const where = [
        flock.machines.size > 1 ? names.get(installation) : undefined,
        herd === undefined ? undefined : (herd.name ?? herd.id),
      ];
      cards.set(task, {
        key: `${installation}:${task.id}`,
        task,
        where: where.filter((part) => part !== undefined).join(" · "),
      });
    }
  }
  return {
    tasks: sortBoard([...cards.keys()]),
    // SAFETY: the board's helpers filter and sort these Tasks; they never make new ones.
    cardOf: (task: TaskView) => cards.get(task)!,
  };
};

/** The board after each item, from the first item on. */
export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
