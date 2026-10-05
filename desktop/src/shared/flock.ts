// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Schema, Stream, Struct } from "effect";
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

/** A Machine as it is known before its host has said which installation it is. */
const KnownMachine = Machine.mapFields(Struct.omit(["installation"]));
export type KnownMachine = typeof KnownMachine.Type;

/** One message of a Machine's board stream, as the host sent it, and which Machine sent it. */
export const MachineMessage = Schema.Struct({ machine: Machine, message: BoardMessage });
export type MachineMessage = typeof MachineMessage.Type;

/** A route to a Machine that Desktop could not open, or lost. */
export const MachineLost = Schema.TaggedStruct("Lost", {
  machine: KnownMachine,
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

/** Each Machine keyed by installation id, and each route out of reach by how it is reached. */
export interface Flock {
  readonly machines: ReadonlyMap<string, FlockMachine>;
  readonly lost: ReadonlyMap<string, { readonly name: string; readonly reason: string }>;
}

const routeOf = (machine: KnownMachine) => machine.target ?? "local";

export const EMPTY_FLOCK: Flock = { machines: new Map(), lost: new Map() };

/** A snapshot replaces its Machine; a change touches one Task; anything newer is skipped. */
export const applyItem = (flock: Flock, item: FlockItem): Flock => {
  const lost = new Map(flock.lost);
  if ("_tag" in item) {
    lost.set(routeOf(item.machine), { name: item.machine.name, reason: item.reason });
    return { ...flock, lost };
  }
  const { machine, message } = item;
  if (message._tag === "Unknown") return flock;
  const known = flock.machines.get(machine.installation);
  const tasks = new Map(
    message._tag === "Snapshot" ? message.tasks.map((task) => [task.id, task]) : known?.tasks,
  );
  if (message._tag === "Upsert") tasks.set(message.task.id, message.task);
  if (message._tag === "Remove") tasks.delete(message.id);
  const herds = message._tag === "Snapshot" ? message.herds : (known?.herds ?? []);
  lost.delete(routeOf(machine));
  return {
    machines: new Map(flock.machines).set(machine.installation, { machine, herds, tasks }),
    lost,
  };
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
export interface PlacedTask {
  readonly key: string;
  readonly task: TaskView;
  readonly where: string;
}

/**
 * Every Task of the Flock in the board's own order, and where it is: its Machine once there
 * is more than one, and its Herd only when its Machine runs several.
 */
export const flockCards = (flock: Flock) => {
  const names = machineNames([...flock.machines.values()].map(({ machine }) => machine));
  const placed = new Map<TaskView, PlacedTask>();
  for (const [installation, { herds, tasks }] of flock.machines) {
    for (const task of tasks.values()) {
      const herd = herds.length > 1 ? herds.find(({ id }) => id === task.herd) : undefined;
      const where = [
        flock.machines.size > 1 ? names.get(installation) : undefined,
        herd === undefined ? undefined : (herd.name ?? herd.id),
      ];
      placed.set(task, {
        key: `${installation}:${task.id}`,
        task,
        where: where.filter((part) => part !== undefined).join(" · "),
      });
    }
  }
  return {
    tasks: sortBoard([...placed.keys()]),
    // SAFETY: the board's helpers filter and sort these Tasks; they never make new ones.
    placedOf: (task: TaskView) => placed.get(task)!,
  };
};

/** The board after each item, from the first item on. */
export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
