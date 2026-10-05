// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Schema, Stream } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { BoardMessage, sortBoard, type TaskView } from "../../../src/board-model";

/** A Machine as Desktop knows it: its installation id, and the name a human reads. */
export const Machine = Schema.Struct({ installation: Schema.String, name: Schema.String });
export type Machine = typeof Machine.Type;

/** One message of a Machine's board stream, as the host sent it, and which Machine sent it. */
export const MachineMessage = Schema.Struct({ machine: Machine, message: BoardMessage });
export type MachineMessage = typeof MachineMessage.Type;

export class MachineUnreachable extends Schema.TaggedError<MachineUnreachable>()(
  "MachineUnreachable",
  { machine: Schema.String, reason: Schema.String },
) {}

export const DesktopRpcs = RpcGroup.make(
  Rpc.make("flock", { success: MachineMessage, error: MachineUnreachable, stream: true }),
);

/** Each Machine's Tasks by id, as its host last told them, keyed by installation id. */
export type Flock = ReadonlyMap<string, ReadonlyMap<string, TaskView>>;

export const EMPTY_FLOCK: Flock = new Map();

/** A snapshot replaces its Machine's Tasks; a change touches one; anything newer is skipped. */
export const applyMessage = (flock: Flock, { machine, message }: MachineMessage): Flock => {
  if (message._tag === "Unknown") return flock;
  const tasks = new Map(message._tag === "Snapshot" ? [] : flock.get(machine.installation));
  if (message._tag === "Snapshot") for (const task of message.tasks) tasks.set(task.id, task);
  if (message._tag === "Upsert") tasks.set(message.task.id, message.task);
  if (message._tag === "Remove") tasks.delete(message.id);
  return new Map(flock).set(machine.installation, tasks);
};

/** Every Task of the Flock, in the board's own order. */
export const flockTasks = (flock: Flock): TaskView[] =>
  sortBoard([...flock.values()].flatMap((tasks) => [...tasks.values()]));

/** The board after each message, from the first message on. */
export const flockOf = <E, R>(messages: Stream.Stream<MachineMessage, E, R>) =>
  messages.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyMessage),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
