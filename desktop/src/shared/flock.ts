// What Desktop's main process tells its view: every Machine's board messages, each named
// by its Machine, and the board those messages add up to. No Bun-only import: the view
// bundles this.

import { Effect, Schema, Stream, Struct } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AguiEvent } from "./agui";
import { Staged, StagedOrRefused } from "./attachments";
import { About, Answers, ChatMessage, Conversations, DesktopTurn } from "./chat-view";
import { FlockSettings } from "./flock-settings";
import {
  BoardMessage,
  Herd,
  OfferView,
  PaneAt,
  RunDetail,
  RunFile,
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
  build: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

/** A route Desktop reaches a Machine by, from herdr's list or Local, as it is opened. */
export const MachineRouted = Schema.TaggedStruct("Routed", { machine: KnownMachine });
export type MachineRouted = typeof MachineRouted.Type;

/** A route removed from herdr's list, with whatever Desktop showed through it. */
export const MachineRemoved = Schema.TaggedStruct("Removed", { machine: KnownMachine });
export type MachineRemoved = typeof MachineRemoved.Type;

/** A step of onboarding as `collie onboard` streams it, or one Desktop takes before it. */
export const OnboardStep = Schema.Struct({
  step: Schema.String,
  title: Schema.String,
  status: Schema.Literals([
    "running",
    "done",
    "in_place",
    "skipped",
    "needs_root",
    "needs_human",
    "failed",
  ]),
  detail: Schema.optionalKey(Schema.String),
  /** What to run by hand: the root command, or the one that retries the step. */
  command: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type OnboardStep = typeof OnboardStep.Type;

/** A yes-or-no question herdr asks while it saves a Machine, and its own default. */
export const HerdrQuestion = Schema.Struct({ text: Schema.String, yes: Schema.Boolean });
export type HerdrQuestion = typeof HerdrQuestion.Type;

/** One onboarding of a Machine so far: its steps, and whether it was ready once it ended. */
export const OnboardRun = Schema.Struct({
  steps: Schema.Array(OnboardStep),
  asked: Schema.NullOr(HerdrQuestion),
  /** Null while it runs. */
  ready: Schema.NullOr(Schema.Boolean),
  /** Why it ended short where no step says. */
  reason: Schema.NullOr(Schema.String),
  at: Schema.Number,
});
export type OnboardRun = typeof OnboardRun.Type;

/** An onboarding as it stands, under the job the view started it as. */
export const MachineOnboarding = Schema.TaggedStruct("Onboarding", {
  job: Schema.String,
  machine: KnownMachine,
  run: OnboardRun,
});
export type MachineOnboarding = typeof MachineOnboarding.Type;

/** How `collie doctor` found a Machine once it was live, or after an onboarding of it. */
export const MachineDoctored = Schema.TaggedStruct("Doctored", {
  machine: KnownMachine,
  run: OnboardRun,
});
export type MachineDoctored = typeof MachineDoctored.Type;

/** How a Machine's latest settings sync ended: null where it synced, else why not. */
export const MachineSynced = Schema.TaggedStruct("Synced", {
  machine: KnownMachine,
  failed: Schema.NullOr(Schema.String),
});
export type MachineSynced = typeof MachineSynced.Type;

/** A credential Desktop gives every Machine. */
export const Credential = Schema.Literals(["gitlab", "helle"]);
export type Credential = typeof Credential.Type;
export const CREDENTIALS = Credential.literals;

/** Whether a Machine has the credential Desktop holds now, and why its last give failed. */
export const MachineGiven = Schema.TaggedStruct("Given", {
  machine: KnownMachine,
  credential: Credential,
  given: Schema.Boolean,
  failed: Schema.NullOr(Schema.String),
});
export type MachineGiven = typeof MachineGiven.Type;

/** Which credentials Desktop holds for every Machine, and nothing of the secrets themselves. */
export const Credentials = Schema.Struct({
  gitlab: Schema.NullOr(Schema.Struct({ expires: Schema.NullOr(Schema.String) })),
  helle: Schema.Boolean,
  /** The GitLab every Machine is onboarded and doctored against. */
  host: Schema.String,
  /** GitLab's page for a new token, with its scopes filled in. */
  tokenPage: Schema.String,
});
export type Credentials = typeof Credentials.Type;

/** The default steps a Machine may go without. */
export const Skippable = Schema.Literals(["helle", "linear"]);
export type Skippable = typeof Skippable.Type;

/** What a step may end as and leave the human nothing to do. */
export const SETTLED: ReadonlyArray<OnboardStep["status"]> = ["done", "in_place", "skipped"];

export const FlockItem = Schema.Union([
  MachineMessage,
  MachineLost,
  MachineSaved,
  MachineMerged,
  MachineNotice,
  MachineRouted,
  MachineRemoved,
  MachineOnboarding,
  MachineDoctored,
  MachineSynced,
  MachineGiven,
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

/** `command` is the herdr client that shows the pane, to copy where no terminal opened it. */
export const WentToPane = Schema.Struct({
  at: PaneAt,
  command: Schema.String,
  opened: Schema.Boolean,
});
export type WentToPane = typeof WentToPane.Type;

const Cell = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));

/** What the human does in a pane's terminal, in herdr's controller's own words. */
export const TerminalCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("terminal.input"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("terminal.resize"),
    cols: Positive,
    rows: Positive,
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.scroll"),
    direction: Schema.Literals(["up", "down"]),
    lines: Positive,
    column: Cell,
    row: Cell,
    modifiers: Cell,
  }),
  Schema.Struct({
    type: Schema.Literal("terminal.mouse"),
    action: Schema.Literals(["down", "up", "drag", "move"]),
    button: Schema.Literals(["left", "right", "middle"]),
    column: Cell,
    row: Cell,
    modifiers: Cell,
  }),
]);
export type TerminalCommand = typeof TerminalCommand.Type;

/**
 * A pane's terminal in Desktop: where it was opened, each of herdr's frames as base64 ANSI,
 * and why it ended; or, where the host named no pane, only where it focused.
 */
export const TerminalEvent = Schema.Union([
  Schema.TaggedStruct("Opened", { at: PaneAt }),
  Schema.TaggedStruct("Frame", { bytes: Schema.String }),
  Schema.TaggedStruct("Ended", { reason: Schema.String }),
  Schema.TaggedStruct("NoPane", { at: PaneAt }),
]);
export type TerminalEvent = typeof TerminalEvent.Type;

/** What Desktop's latest check for its own update found, or is finding. */
export const UpdateNews = Schema.Union([
  Schema.TaggedStruct("Checking", {}),
  /** `version` is this Desktop's own. */
  Schema.TaggedStruct("UpToDate", { version: Schema.String }),
  Schema.TaggedStruct("Downloading", { version: Schema.String }),
  /** Downloaded and verified, waiting on Restart Desktop. */
  Schema.TaggedStruct("Ready", { version: Schema.String }),
  Schema.TaggedStruct("Refused", { version: Schema.String, reason: Schema.String }),
  /** The check or the download failed, and is tried again at the next one. */
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  /** This Desktop never updates itself. */
  Schema.TaggedStruct("Never", { reason: Schema.String }),
]);
export type UpdateNews = typeof UpdateNews.Type;

/** This Desktop's version, and what its latest check for an update found. */
export const DesktopUpdates = Schema.Struct({ version: Schema.String, news: UpdateNews });
export type DesktopUpdates = typeof DesktopUpdates.Type;
/** What the human set in Desktop. */
export const DesktopSettings = Schema.Struct({
  /** Whether the Flock chat may start a turn about News nobody asked for. */
  proactive: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  /** The GitLab every Machine is onboarded and doctored against; unset is the default one. */
  gitlabHost: Schema.optionalKey(Schema.String),
  /** Which Machine each kind of work goes to, in the human's words; empty is no rule. */
  machineRule: Schema.optionalKey(Schema.String),
});
export type DesktopSettings = typeof DesktopSettings.Type;

/** The settings a change sets; the rest stay as they are. */
export const DesktopSettingsChange = Schema.Struct({
  proactive: Schema.optionalKey(Schema.Boolean),
  gitlabHost: Schema.optionalKey(Schema.String),
  machineRule: Schema.optionalKey(Schema.String),
});
export type DesktopSettingsChange = typeof DesktopSettingsChange.Type;

export interface MachineToAdd {
  readonly target: string;
  readonly label: string;
  readonly session: string;
}

/** What Add Machine sends, trimmed, once every field is filled. */
export const machineToAdd = (typed: MachineToAdd): MachineToAdd | null => {
  const [target, label, session] = [typed.target, typed.label, typed.session].map((one) =>
    one.trim(),
  );
  return target && label && session ? { target, label, session } : null;
};

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
  Rpc.make("goToPane", {
    payload: { installation: Schema.String, runId: Schema.String },
    success: WentToPane,
    error: ActionFailed,
  }),
  /** The pane `focus` finds, held while the stream runs and released when it is interrupted. */
  Rpc.make("terminal", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      agent: Schema.optionalKey(Schema.String),
      cols: Schema.Int,
      rows: Schema.Int,
    },
    success: TerminalEvent,
    error: ActionFailed,
    stream: true,
  }),
  /** One command to the open terminal; never recorded anywhere. */
  Rpc.make("terminalSend", { payload: { command: TerminalCommand }, error: ActionFailed }),
  /** A web page, opened in the human's own browser. */
  Rpc.make("openLink", { payload: { url: Schema.String } }),
  Rpc.make("workflows", {
    payload: { installation: Schema.String, project: Schema.String },
    success: Schema.Array(Startable),
    error: ActionFailed,
  }),
  /** Desktop's own version and update news, the latest first. */
  Rpc.make("updates", { success: DesktopUpdates, stream: true }),
  /** Checks for Desktop's own update now, or joins the check already running. */
  Rpc.make("checkForUpdates", { success: UpdateNews }),
  /** Installs the update that is ready, which quits Desktop and starts the new one. */
  Rpc.make("restart", { error: ActionFailed }),
  /**
   * Onboards, or repairs, the Machine a route reaches; its progress comes on `flock`. A step
   * in `skip` is skipped for that Machine from then on.
   */
  Rpc.make("onboard", {
    payload: { profile: Schema.String, skip: Schema.optionalKey(Schema.Array(Skippable)) },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Saves a Machine in herdr, then onboards it, under the job it answers with. */
  Rpc.make("addMachine", {
    payload: { target: Schema.String, label: Schema.String, session: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** The human's answer to the question herdr asks in a job. */
  Rpc.make("answerHerdr", { payload: { job: Schema.String, yes: Schema.Boolean } }),
  /**
   * The Flock's settings, now and whenever they change. Asking syncs every connected
   * Machine, so an edit made on one since it connected is picked up.
   */
  Rpc.make("flockSettings", { success: FlockSettings, stream: true }),
  /** One of Collie's settings, as typed, for every Machine; what came of it in a line. */
  Rpc.make("setFlockSetting", {
    payload: { key: Schema.String, value: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Which credentials Desktop holds, now and whenever that changes. */
  Rpc.make("credentials", { success: Credentials, stream: true }),
  /** Keeps the Flock's GitLab token once GitLab accepts it, and gives it to every Machine. */
  Rpc.make("saveGitlab", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Makes `host` the GitLab every Machine is onboarded and doctored against. */
  Rpc.make("saveGitlabHost", {
    payload: { host: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Who Helle says a token belongs to; a token it refuses fails. */
  Rpc.make("checkHelle", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Slack, where Helle makes tokens: its app where that is here, else the web. */
  Rpc.make("openSlack"),
  Rpc.make("copyText", { payload: { text: Schema.String } }),
  /** Keeps Helle's token once Helle accepts it, and writes it on every Machine. */
  Rpc.make("saveHelle", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Logs Claude Code in on the Machine a route reaches, then onboards it again. */
  Rpc.make("claudeLogin", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** A code the human pasted, typed into the login a job runs. */
  Rpc.make("pasteCode", { payload: { job: Schema.String, code: Schema.String } }),
  /** Removes a route from herdr's list; nothing on its Machine is stopped or uninstalled. */
  Rpc.make("removeMachine", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  /** Does for a lagging Machine what connecting would, and says what it did. */
  Rpc.make("syncNow", {
    payload: { profile: Schema.String },
    success: Schema.Struct({ said: Schema.String, failed: Schema.Boolean }),
    error: ActionFailed,
  }),
  /** One Run's details while its record is open, with its log's tail, again as they change. */
  Rpc.make("runDetail", {
    payload: { installation: Schema.String, runId: Schema.String },
    success: Schema.NullOr(RunDetail),
    error: ActionFailed,
    stream: true,
  }),
  /** A large item of a Run's, by the reference its details hand out, from `offset` bytes on. */
  Rpc.make("runFile", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      ref: Schema.String,
      offset: Schema.optional(Schema.Int),
    },
    success: RunFile,
    error: ActionFailed,
  }),
  /** One message from the human to the Flock chat, and the turn it starts as it streams. */
  /** `now` interrupts the turn under way rather than waiting behind it. */
  Rpc.make("say", {
    payload: {
      text: Schema.String,
      about: Schema.NullOr(About),
      now: Schema.optionalKey(Schema.Boolean),
      /** Desktop's copies the message carries, by id. */
      attachments: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: AguiEvent,
    stream: true,
  }),
  /**
   * One part of a file for the chat, from `offset` bytes on, as base64: the reverse of
   * `runFile`. The last part answers Desktop's copy; null before it.
   */
  Rpc.make("stage", {
    payload: {
      key: Schema.String,
      name: Schema.String,
      mediaType: Schema.String,
      size: Schema.Int,
      offset: Schema.Int,
      content: Schema.String,
      /** The original this is a scaled copy of. */
      scaledOf: Schema.optionalKey(Schema.String),
    },
    success: Schema.NullOr(Staged),
    error: ActionFailed,
  }),
  /** Files on this computer, named by path as a paste or a drop names them, copied in. */
  Rpc.make("stagePaths", {
    payload: { paths: Schema.Array(Schema.String) },
    success: Schema.Array(StagedOrRefused),
  }),
  /** The files a dialog lets the human choose, copied in; none where they chose nothing. */
  Rpc.make("pickFiles", { success: Schema.Array(StagedOrRefused) }),
  /** The files on the system clipboard, for a paste the view was handed no files in. */
  Rpc.make("clipboardFiles", { success: Schema.Array(StagedOrRefused) }),
  /** Part of Desktop's copy of an attachment, for a thumbnail drawn again. */
  Rpc.make("attachmentFile", {
    payload: { id: Schema.String, offset: Schema.optionalKey(Schema.Int) },
    success: Schema.Struct({ content: Schema.String, size: Schema.Int }),
    error: ActionFailed,
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
  Rpc.make("setSettings", { payload: DesktopSettingsChange }),
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
  /** The Collie it runs; null where a saved board did not say. */
  readonly build: string | null;
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
  /** Every route Desktop reaches a Machine by, by herdr profile. */
  readonly routes: ReadonlyMap<string, KnownMachine>;
  /** Each onboarding the view started, by job. */
  readonly onboarding: ReadonlyMap<string, MachineOnboarding>;
  /** The latest onboarding of each route, by herdr profile. */
  readonly onboarded: ReadonlyMap<string, OnboardRun>;
  /** Doctor's latest reading of each route, by herdr profile. */
  readonly doctored: ReadonlyMap<string, OnboardRun>;
  /** How each route's latest settings sync ended, by herdr profile. */
  readonly synced: ReadonlyMap<string, string | null>;
  /** Each route's credentials, by herdr profile. */
  readonly given: ReadonlyMap<string, CredentialsGiven>;
}

export type CredentialsGiven = Partial<
  Record<Credential, { readonly given: boolean; readonly failed: string | null }>
>;

export const EMPTY_FLOCK: Flock = {
  machines: new Map(),
  lost: new Map(),
  notices: [],
  routes: new Map(),
  onboarding: new Map(),
  onboarded: new Map(),
  doctored: new Map(),
  synced: new Map(),
  given: new Map(),
};

/**
 * A snapshot replaces its Machine and makes it live; a change touches one Task; a lost
 * route dims the Machine it was showing; a merged one is no longer lost; a saved board
 * stands in until its Machine is live; anything newer is skipped.
 */
export const applyItem = (flock: Flock, item: FlockItem): Flock => {
  if ("_tag" in item && item._tag === "Notice")
    return { ...flock, notices: [...flock.notices, item.text] };
  if ("_tag" in item && item._tag === "Routed")
    return { ...flock, routes: new Map(flock.routes).set(item.machine.profile, item.machine) };
  if ("_tag" in item && item._tag === "Onboarding")
    return {
      ...flock,
      onboarding: new Map(flock.onboarding).set(item.job, item),
      onboarded: new Map(flock.onboarded).set(item.machine.profile, item.run),
    };
  if ("_tag" in item && item._tag === "Doctored")
    return { ...flock, doctored: new Map(flock.doctored).set(item.machine.profile, item.run) };
  if ("_tag" in item && item._tag === "Synced")
    return { ...flock, synced: new Map(flock.synced).set(item.machine.profile, item.failed) };
  if ("_tag" in item && item._tag === "Given") {
    const { machine, credential, given, failed } = item;
    const { profile } = machine;
    const had = flock.given.get(profile);
    return {
      ...flock,
      given: new Map(flock.given).set(profile, { ...had, [credential]: { given, failed } }),
    };
  }
  if ("_tag" in item && item._tag === "Removed") {
    const { profile } = item.machine;
    const without = <V>(map: ReadonlyMap<string, V>) => {
      const kept = new Map(map);
      kept.delete(profile);
      return kept;
    };
    return {
      ...flock,
      routes: without(flock.routes),
      lost: without(flock.lost),
      onboarded: without(flock.onboarded),
      doctored: without(flock.doctored),
      synced: without(flock.synced),
      given: without(flock.given),
      machines: new Map(
        [...flock.machines].filter(([, { machine }]) => machine.profile !== profile),
      ),
    };
  }
  if ("_tag" in item && item._tag === "Saved") {
    const { machine, herds, tasks, at } = item;
    if (flock.machines.has(machine.installation)) return flock;
    const saved = {
      machine,
      herds,
      tasks: new Map(tasks.map((task) => [task.id, task])),
      asOf: at,
      build: item.build ?? null,
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
  const build = message._tag === "Snapshot" ? message.build : (known?.build ?? null);
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
      build,
      development,
    }),
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

const shownNames = (flock: Flock) =>
  machineNames([...flock.machines.values()].map(({ machine }) => machine));

/** What the board calls a Machine, among every Machine it shows, saved ones included. */
export const nameAsShown = (flock: Flock) => {
  const names = shownNames(flock);
  return (machine: Machine) => names.get(machine.installation) ?? machine.name;
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
  /** When its Machine was last live, where it is not now; its actions are off until it is. */
  readonly asOf: number | null;
}

/**
 * Every Task of the Flock in the board's own order, and where it is: its Machine once there
 * is more than one, and its Herd only when its Machine runs several.
 */
export const flockCards = (flock: Flock) => {
  const names = shownNames(flock);
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
        // SAFETY: `names` holds every Machine of this Flock.
        machine: names.get(installation)!,
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
  };
};

/** A route as the Machines list shows it: how it stands now, and how onboarded it is. */
export interface MachineRow {
  readonly profile: string;
  readonly name: string;
  readonly target: string | null;
  readonly state: "live" | "connecting" | NotLive;
  readonly onboarded: OnboardRun | null;
  /** The Collie it runs, as it was last seen; null where it never was. */
  readonly build: string | null;
  readonly development: string | null;
  /** How its latest settings sync ended; null until one has. */
  readonly settings: { readonly failed: string | null } | null;
  readonly credentials: CredentialsGiven;
  /** Why it isn't live; null while it is, or is connecting. */
  readonly reason: string | null;
}

/**
 * How onboarded a route is: doctor's reading, less a step its latest onboarding skipped and
 * with a default step that onboarding left unsettled, which doctor cannot see (a Linear
 * server added but not logged in); or that onboarding where it is newer or doctor has not
 * answered.
 */
const standing = (onboarding?: OnboardRun, doctor?: OnboardRun): OnboardRun | null => {
  if (doctor === undefined || (onboarding !== undefined && onboarding.at > doctor.at))
    return onboarding ?? null;
  const skipped = new Set(
    onboarding?.steps.filter(({ status }) => status === "skipped").map(({ step }) => step),
  );
  const listed = new Set(doctor.steps.map(({ step }) => step));
  const left = (onboarding?.steps ?? []).filter(
    ({ step, status }) =>
      Skippable.literals.some((one) => one === step) &&
      !listed.has(step) &&
      !SETTLED.includes(status),
  );
  const steps = [...doctor.steps.filter(({ step }) => !skipped.has(step)), ...left];
  return { ...doctor, steps, ready: steps.length === 0 };
};

/** Every route, in the order Desktop opened them. */
export const machineRows = (flock: Flock): ReadonlyArray<MachineRow> =>
  [...flock.routes.values()].map(({ profile, name, target }) => {
    const seen = [...flock.machines.values()].filter(({ machine }) => machine.profile === profile);
    const shown =
      seen.find(({ asOf }) => asOf === null) ?? seen.sort((a, b) => b.asOf! - a.asOf!)[0];
    const live = shown?.asOf === null;
    const lost = flock.lost.get(profile);
    return {
      profile,
      name,
      target: target ?? null,
      state: live ? "live" : (lost?.state ?? "connecting"),
      onboarded: standing(flock.onboarded.get(profile), flock.doctored.get(profile)),
      build: shown?.build ?? null,
      development: shown?.development ?? null,
      settings: flock.synced.has(profile) ? { failed: flock.synced.get(profile)! } : null,
      credentials: flock.given.get(profile) ?? {},
      reason: live ? null : (lost?.reason ?? null),
    };
  });

/** The board after each item, from the first item on. */
export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    // The empty Flock a scan starts from is not a board anyone was told.
    Stream.drop(1),
  );
