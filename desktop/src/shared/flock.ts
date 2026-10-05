// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Schema, Stream, Struct } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import {
  BoardMessage,
  Herd,
  OfferView,
  sortBoard,
  Startable,
  TaskView,
} from "../../../src/board-model";

/**
 * A Machine as Desktop knows it: its installation id, the herdr profile it is reached
 * through (Local's is `local`), the name a human reads, and the SSH target, which Local
 * has none of.
 */
export const Machine = Schema.Struct({
  installation: Schema.String,
  profile: Schema.String,
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

export const NotLive = Schema.Literals(["unreachable", "sso", "no-collie", "update-desktop"]);
export type NotLive = typeof NotLive.Type;

/** A route Desktop could not open, or lost, and since when. */
export const MachineLost = Schema.TaggedStruct("Lost", {
  machine: KnownMachine,
  state: NotLive,
  reason: Schema.String,
  at: Schema.Number,
});
export type MachineLost = typeof MachineLost.Type;

/** A Machine's board as Desktop last saw it live, and when. */
export const MachineSaved = Schema.TaggedStruct("Saved", {
  machine: Machine,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  development: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at: Schema.Number,
});
export type MachineSaved = typeof MachineSaved.Type;

/** A route that turned out to reach a Machine already shown through another. */
export const MachineMerged = Schema.TaggedStruct("Merged", { machine: KnownMachine });
export type MachineMerged = typeof MachineMerged.Type;

/** What Desktop did on a Machine that a human should hear of, such as upgrading it. */
export const MachineNotice = Schema.TaggedStruct("Notice", {
  machine: KnownMachine,
  text: Schema.String,
});
export type MachineNotice = typeof MachineNotice.Type;

export const FlockItem = Schema.Union([
  MachineMessage,
  MachineLost,
  MachineSaved,
  MachineMerged,
  MachineNotice,
]);
export type FlockItem = typeof FlockItem.Type;

/** One board action, as the view asks it of a Machine's host. */
export const DesktopAction = Schema.Union([
  Schema.TaggedStruct("Answer", {
    runId: Schema.String,
    decision: Schema.NullOr(Schema.String),
    value: Schema.String,
  }),
  Schema.TaggedStruct("Control", {
    runId: Schema.String,
    control: Schema.Literals(["hold", "stop"]),
    set: Schema.Boolean,
  }),
  Schema.TaggedStruct("Resume", { runId: Schema.String }),
  Schema.TaggedStruct("Confirm", { proposal: Schema.String, hash: Schema.String }),
  Schema.TaggedStruct("Decline", { proposal: Schema.String, hash: Schema.String }),
  Schema.TaggedStruct("Dispose", {
    runId: Schema.String,
    kind: Schema.Literals(["merged", "abandoned", "superseded"]),
    ref: Schema.String,
  }),
  Schema.TaggedStruct("Steer", { runId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("FollowUp", { runId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Invoke", {
    runId: Schema.String,
    offer: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.TaggedStruct("Start", {
    project: Schema.String,
    id: Schema.String,
    text: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type DesktopAction = typeof DesktopAction.Type;

/** What a Machine's host said no with, or why it could not be asked. */
export class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
  reason: Schema.String,
  /** The id it was asked under, which a retry sends again so the host does it once. */
  request: Schema.optional(Schema.String),
}) {}

export const DesktopRpcs = RpcGroup.make(
  Rpc.make("flock", { success: FlockItem, stream: true }),
  /** A retry names the request that failed; a first try leaves it to the main process. */
  Rpc.make("act", {
    payload: {
      installation: Schema.String,
      action: DesktopAction,
      request: Schema.optional(Schema.String),
    },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("offers", {
    payload: { installation: Schema.String, runId: Schema.String },
    success: Schema.Array(OfferView),
    error: ActionFailed,
  }),
  /** A web page, opened in the human's own browser. */
  Rpc.make("openLink", { payload: { url: Schema.String } }),
  Rpc.make("workflows", {
    payload: { installation: Schema.String, project: Schema.String },
    success: Schema.Array(Startable),
    error: ActionFailed,
  }),
);

/**
 * What a Machine's host last told: who it is, its Herds, and its Tasks by id, and since when
 * that is no longer live, if it is not.
 */
export interface FlockMachine {
  readonly machine: Machine;
  readonly herds: ReadonlyArray<Herd>;
  readonly tasks: ReadonlyMap<string, TaskView>;
  readonly asOf: number | null;
  /** `<version>+<sha>` where the Machine runs a development checkout. */
  readonly development: string | null;
}

/** Each Machine keyed by installation id, and each route not live by its herdr profile. */
export interface Flock {
  readonly machines: ReadonlyMap<string, FlockMachine>;
  readonly lost: ReadonlyMap<
    string,
    { readonly name: string; readonly state: NotLive; readonly reason: string }
  >;
  /** Every notice so far, oldest first. */
  readonly notices: ReadonlyArray<string>;
}

export const EMPTY_FLOCK: Flock = { machines: new Map(), lost: new Map(), notices: [] };

/**
 * A snapshot replaces its Machine and makes it live; a change touches one Task; a lost
 * route dims the Machine it was showing; a merged one is no longer lost; a saved board
 * stands in until its Machine is live; anything newer is skipped.
 */
export const applyItem = (flock: Flock, item: FlockItem): Flock => {
  if ("_tag" in item && item._tag === "Notice")
    return { ...flock, notices: [...flock.notices, item.text] };
  if ("_tag" in item && item._tag === "Saved") {
    const { machine, herds, tasks, at } = item;
    if (flock.machines.has(machine.installation)) return flock;
    const saved = {
      machine,
      herds,
      tasks: new Map(tasks.map((task) => [task.id, task])),
      asOf: at,
      development: item.development ?? null,
    };
    return { ...flock, machines: new Map(flock.machines).set(machine.installation, saved) };
  }
  const lost = new Map(flock.lost);
  if ("_tag" in item && item._tag === "Merged") {
    lost.delete(item.machine.profile);
    return { ...flock, lost };
  }
  if ("_tag" in item) {
    const { machine, state, reason, at } = item;
    lost.set(machine.profile, { name: machine.name, state, reason });
    const machines = new Map(flock.machines);
    for (const [installation, known] of machines)
      if (known.machine.profile === machine.profile && known.asOf === null)
        machines.set(installation, { ...known, asOf: at });
    return { ...flock, machines, lost };
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
  const development =
    message._tag === "Snapshot" ? (message.development ?? null) : (known?.development ?? null);
  lost.delete(machine.profile);
  return {
    ...flock,
    machines: new Map(flock.machines).set(machine.installation, {
      machine,
      herds,
      tasks,
      asOf: null,
      development,
    }),
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
  /** The Machine its actions go to. */
  readonly installation: string;
  readonly task: TaskView;
  readonly where: string;
  /** When its Machine was last live, where it is not now; its actions are off until it is. */
  readonly asOf: number | null;
}

/**
 * Every Task of the Flock in the board's own order, and where it is: its Machine once there
 * is more than one, and its Herd only when its Machine runs several.
 */
export const flockCards = (flock: Flock) => {
  const names = machineNames([...flock.machines.values()].map(({ machine }) => machine));
  const placed = new Map<TaskView, PlacedTask>();
  for (const [installation, { herds, tasks, asOf }] of flock.machines) {
    for (const task of tasks.values()) {
      const herd = herds.length > 1 ? herds.find(({ id }) => id === task.herd) : undefined;
      const where = [
        flock.machines.size > 1 ? names.get(installation) : undefined,
        herd === undefined ? undefined : (herd.name ?? herd.id),
      ];
      placed.set(task, {
        key: `${installation}:${task.id}`,
        installation,
        task,
        where: where.filter((part) => part !== undefined).join(" · "),
        asOf,
      });
    }
  }
  return {
    tasks: sortBoard([...placed.keys()]),
    // SAFETY: the board's helpers filter and sort these Tasks; they never make new ones.
    placedOf: (task: TaskView) => placed.get(task)!,
    /** Each live Machine by its display name, and the projects its board has work in. */
    machines: [...flock.machines]
      .filter(([, { asOf }]) => asOf === null)
      .map(([installation, { tasks }]) => ({
        installation,
        name: names.get(installation)!,
        projects: [...new Set([...tasks.values()].map((task) => task.project))].sort(),
      })),
    /** Each Machine on a development build, by its display name, and which build it is. */
    developments: [...flock.machines].flatMap(([installation, { development }]) =>
      development === null ? [] : [{ name: names.get(installation)!, development }],
    ),
  };
};

/** The board after each item, from the first item on. */
export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
