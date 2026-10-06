// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Effect, Schema, Stream, Struct } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { AguiEvent } from "./agui";
import { About, Answers, ChatMessage, Conversations, DesktopTurn } from "./chat-view";
import {
  BoardMessage,
  type Herd,
  OfferView,
  sortBoard,
  Startable,
  type TaskView,
} from "../../../src/board-model";

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

/** What the human set in Desktop. */
export const DesktopSettings = Schema.Struct({
  /** Whether the Flock chat may start a turn about News nobody asked for. */
  proactive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type DesktopSettings = typeof DesktopSettings.Type;

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
  /** One message from the human to the Flock chat, and the turn it starts as it streams. */
  Rpc.make("say", {
    payload: { text: Schema.String, about: Schema.NullOr(About) },
    success: AguiEvent,
    stream: true,
  }),
  /** The human's choices for a question the chat asked. */
  Rpc.make("answer", {
    payload: { toolCallId: Schema.String, answers: Answers },
  }),
  /** The current conversation, as far as it has gone. */
  Rpc.make("transcript", { success: Schema.Array(ChatMessage) }),
  Rpc.make("conversations", { success: Conversations }),
  /** Makes that conversation the current one, or a fresh one; the one before it ends. */
  Rpc.make("reopen", { payload: { session: Schema.NullOr(Schema.String) } }),
  /** Opens the chat in its own window, and succeeds when that window is closed. */
  Rpc.make("popOut"),
  /** Closes the chat's own window, which puts the chat back beside the board. */
  Rpc.make("popIn"),
  /** When the Flock chat starts and ends a turn of Desktop's own. */
  Rpc.make("desktopTurns", { success: DesktopTurn, stream: true }),
  Rpc.make("settings", { success: DesktopSettings }),
  Rpc.make("setSettings", { payload: DesktopSettings }),
);

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
export const machineNames = (machines: ReadonlyArray<Machine>) => {
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
  /** That Machine's display name, as the chat's tools name it. */
  readonly machine: string;
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
        installation,
        // SAFETY: `names` holds every Machine of this Flock.
        machine: names.get(installation)!,
        task,
        where: where.filter((part) => part !== undefined).join(" · "),
      });
    }
  }
  return {
    tasks: sortBoard([...placed.keys()]),
    // SAFETY: the board's helpers filter and sort these Tasks; they never make new ones.
    placedOf: (task: TaskView) => placed.get(task)!,
    /** Each Machine by its display name, and the projects its board has work in. */
    machines: [...flock.machines].map(([installation, { tasks }]) => ({
      installation,
      name: names.get(installation)!,
      projects: [...new Set([...tasks.values()].map((task) => task.project))].sort(),
    })),
  };
};

/** The board after each item, from the first item on. */
export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
