import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { DateTime, Schema, Stream, Struct } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AguiEvent } from "./agui";
import {
  Artefact,
  ArtefactCollection,
  ArtefactRegistered,
  RegisterArtefact,
} from "../../../src/artefact-model";
import { FlockArtefacts, FlockSearch } from "../../../src/artefact-search";
import { Staged, StagedOrRefused } from "./attachments";
import { ChatChoices } from "./chat-choices";
import {
  About,
  Answers,
  ChatMessage,
  Conversations,
  DesktopTurn,
  HeldConversation,
} from "./chat-view";
import { Drawn } from "./scale";
import { FlockSettings } from "./flock-settings";
import { CleanupListing } from "./machine-cleanup";
import { MachineSchedules } from "./schedules";
import { MachineUsage } from "./usage";
import { MachineCatalogue } from "./settings-agents";
import { MachineConnections } from "./connections";
import { SlackChannel } from "../../../src/slack";
import { keepOwn, OwnReading } from "./machine-own";
import {
  BoardMessage,
  CleanupReport,
  Herd,
  OfferView,
  PaneAt,
  RunDetail,
  RunFile,
  RunRevision,
  sortBoard,
  TaskView,
} from "../../../src/board-model";
import { HostDefinitions } from "../../../src/definitions-model";
import { PeerView } from "../../../src/peers-model";
import { ComputerStores, SetupChoice } from "./standing-setup";

export const Machine = Schema.Struct({
  installation: Schema.String,
  profile: Schema.String,
  name: Schema.String,
  target: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.Literals(["link", "ssh"])),
});
export type Machine = typeof Machine.Type;

const KnownMachine = Machine.mapFields(Struct.omit(["installation"]));
export type KnownMachine = typeof KnownMachine.Type;

export const MachineMessage = Schema.Struct({ machine: Machine, message: BoardMessage });
export type MachineMessage = typeof MachineMessage.Type;

export const NotLive = Schema.Literals(["unreachable", "sso", "no-collie", "update-desktop"]);
export type NotLive = typeof NotLive.Type;

export const NOT_LIVE: Record<NotLive, { icon: string; title: (name: string) => string }> = {
  unreachable: { icon: "i-lucide-unplug", title: (name) => `${name} is out of reach` },
  sso: { icon: "i-lucide-key-round", title: (name) => `Waiting for SSO login on ${name}` },
  "no-collie": { icon: "i-lucide-package-x", title: (name) => `Collie isn't installed on ${name}` },
  "update-desktop": {
    icon: "i-lucide-circle-arrow-up",
    title: (name) => `Update Desktop to see ${name}`,
  },
};

export const MachineLost = Schema.TaggedStruct("Lost", {
  machine: KnownMachine,
  state: NotLive,
  reason: Schema.String,
  at: Schema.Finite,
});
export type MachineLost = typeof MachineLost.Type;

export const MachineSaved = Schema.TaggedStruct("Saved", {
  machine: Machine,
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  build: Schema.optionalKey(Schema.NullOr(Schema.String)),
  development: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at: Schema.Finite,
});
export type MachineSaved = typeof MachineSaved.Type;

export const MachineMerged = Schema.TaggedStruct("Merged", { machine: KnownMachine });
export type MachineMerged = typeof MachineMerged.Type;

export const MachineReconnecting = Schema.TaggedStruct("Reconnecting", {
  machine: KnownMachine,
  at: Schema.Finite,
});
export type MachineReconnecting = typeof MachineReconnecting.Type;

export const MachineNotice = Schema.TaggedStruct("Notice", {
  machine: KnownMachine,
  text: Schema.String,
});
export type MachineNotice = typeof MachineNotice.Type;

export const MachineRouted = Schema.TaggedStruct("Routed", { machine: KnownMachine });
export type MachineRouted = typeof MachineRouted.Type;

export const MachineRemoved = Schema.TaggedStruct("Removed", { machine: KnownMachine });
export type MachineRemoved = typeof MachineRemoved.Type;

export const MachineRoutes = Schema.TaggedStruct("Routes", {
  profiles: Schema.Array(Schema.String),
});
export type MachineRoutes = typeof MachineRoutes.Type;

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
  command: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type OnboardStep = typeof OnboardStep.Type;

export const OnboardRun = Schema.Struct({
  steps: Schema.Array(OnboardStep),
  ready: Schema.NullOr(Schema.Boolean),
  reason: Schema.NullOr(Schema.String),
  at: Schema.Finite,
});
export type OnboardRun = typeof OnboardRun.Type;

export const MachineOnboarding = Schema.TaggedStruct("Onboarding", {
  job: Schema.String,
  machine: KnownMachine,
  run: OnboardRun,
});
export type MachineOnboarding = typeof MachineOnboarding.Type;

export const MachineDoctored = Schema.TaggedStruct("Doctored", {
  machine: KnownMachine,
  run: OnboardRun,
});
export type MachineDoctored = typeof MachineDoctored.Type;

export const MachineSynced = Schema.TaggedStruct("Synced", {
  part: Schema.Literals(["settings", "definitions"]),
  machine: KnownMachine,
  failed: Schema.NullOr(Schema.String),
});
export type MachineSynced = typeof MachineSynced.Type;

export const MachineOwnRead = Schema.TaggedStruct("OwnRead", {
  machine: KnownMachine,
  reading: OwnReading,
});
export type MachineOwnRead = typeof MachineOwnRead.Type;

export const MachineLinked = Schema.TaggedStruct("Linked", {
  machine: KnownMachine,
  link: PeerView,
});
export type MachineLinked = typeof MachineLinked.Type;

export const SlackUserState = Schema.Struct({
  signedIn: Schema.NullOr(Schema.Struct({ user: Schema.String, team: Schema.String })),
  trouble: Schema.NullOr(Schema.String),
});
export const NOT_SIGNED_IN: typeof SlackUserState.Type = {
  signedIn: null,
  trouble: null,
};

export const Credential = Schema.Literals(["gitlab", "helle", "slack"]);
export type Credential = typeof Credential.Type;
export const CREDENTIALS = Credential.literals;

export const MachineGiven = Schema.TaggedStruct("Given", {
  machine: KnownMachine,
  credential: Credential,
  given: Schema.Boolean,
  failed: Schema.NullOr(Schema.String),
});
export type MachineGiven = typeof MachineGiven.Type;

export const Credentials = Schema.Struct({
  gitlab: Schema.NullOr(Schema.Struct({ expires: Schema.NullOr(Schema.String) })),
  helle: Schema.Boolean,
  host: Schema.String,
  tokenPage: Schema.String,
});
export type Credentials = typeof Credentials.Type;

export const Skippable = Schema.Literals(["helle", "linear"]);
export type Skippable = typeof Skippable.Type;

export const SETTLED: ReadonlyArray<OnboardStep["status"]> = ["done", "in_place", "skipped"];

export const FlockItem = Schema.Union([
  MachineMessage,
  MachineLost,
  MachineSaved,
  MachineMerged,
  MachineReconnecting,
  MachineNotice,
  MachineRouted,
  MachineRemoved,
  MachineRoutes,
  MachineOnboarding,
  MachineDoctored,
  MachineSynced,
  MachineOwnRead,
  MachineGiven,
  MachineLinked,
]);
export type FlockItem = typeof FlockItem.Type;

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
    reason: Schema.optionalKey(Schema.String),
    before: Schema.optional(Schema.String),
    shown: Schema.optionalKey(RunRevision),
  }),
  Schema.TaggedStruct("Resume", { runId: Schema.String }),
  Schema.TaggedStruct("Confirm", { proposal: Schema.String, hash: Schema.String }),
  Schema.TaggedStruct("Decline", { proposal: Schema.String, hash: Schema.String }),
  Schema.TaggedStruct("Dispose", {
    runId: Schema.String,
    kind: Schema.Literals(["merged", "abandoned", "superseded"]),
    ref: Schema.String,
  }),
  Schema.TaggedStruct("Seen", { runId: Schema.String }),
  Schema.TaggedStruct("Steer", { runId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Deliver", {
    runId: Schema.String,
    step: Schema.optional(Schema.String),
    agent: Schema.optionalKey(Schema.String),
    to: Schema.optionalKey(Schema.String),
    text: Schema.String,
    shown: Schema.optionalKey(RunRevision),
  }),
  Schema.TaggedStruct("WithdrawNote", { runId: Schema.String, note: Schema.String }),
  Schema.TaggedStruct("FollowUp", { runId: Schema.String, text: Schema.String }),
  Schema.TaggedStruct("Invoke", {
    runId: Schema.String,
    offer: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
]);
export type DesktopAction = typeof DesktopAction.Type;

export class ActionFailed extends Schema.TaggedError<
  ActionFailed,
  { readonly brand: unique symbol }
>()("ActionFailed", {
  reason: Schema.String,
  request: Schema.optional(Schema.String),
  step: Schema.optional(Schema.String),
  refused: Schema.optional(Schema.Boolean),
}) {}

export const WentToPane = Schema.Struct({
  at: PaneAt,
  command: Schema.String,
  opened: Schema.Boolean,
});
export type WentToPane = typeof WentToPane.Type;

const Positive = Schema.Int.check(Schema.isGreaterThan(0));

export const TerminalCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("terminal.input"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("terminal.resize"),
    cols: Positive,
    rows: Positive,
  }),
]);
export type TerminalCommand = typeof TerminalCommand.Type;

export const TerminalEvent = Schema.Union([
  Schema.TaggedStruct("Opened", { at: PaneAt }),
  Schema.TaggedStruct("Frame", { bytes: Schema.String }),
  Schema.TaggedStruct("Ended", { reason: Schema.String }),
  Schema.TaggedStruct("NoPane", { at: PaneAt }),
]);
export type TerminalEvent = typeof TerminalEvent.Type;

export const UpdateNews = Schema.Union([
  Schema.TaggedStruct("Checking", {}),
  Schema.TaggedStruct("UpToDate", { version: Schema.String }),
  Schema.TaggedStruct("Downloading", { version: Schema.String }),
  Schema.TaggedStruct("Ready", { version: Schema.String }),
  Schema.TaggedStruct("Refused", { version: Schema.String, reason: Schema.String }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("Never", { reason: Schema.String }),
]);
export type UpdateNews = typeof UpdateNews.Type;

export const DesktopUpdates = Schema.Struct({ version: Schema.String, news: UpdateNews });
export type DesktopUpdates = typeof DesktopUpdates.Type;
export const DesktopSettings = Schema.Struct({
  proactive: Schema.optionalKey(Schema.Boolean),
  gitlabHost: Schema.optionalKey(Schema.String),
  machineRule: Schema.optionalKey(Schema.String),
  zoom: Schema.optionalKey(Schema.Finite),
  chatHarness: Schema.optionalKey(Schema.String),
  chatModel: Schema.optionalKey(Schema.String),
  chatEffort: Schema.optionalKey(Schema.String),
  chatWidth: Schema.optionalKey(Schema.Finite),
  recordTiming: Schema.optionalKey(Schema.Boolean),
  setupNotNow: Schema.optionalKey(Schema.String),
  setupNever: Schema.optionalKey(Schema.Boolean),
});
export type DesktopSettings = typeof DesktopSettings.Type;

export const DesktopSettingsChange = Schema.Struct({
  gitlabHost: Schema.optionalKey(Schema.String),
  zoom: Schema.optionalKey(Schema.Finite),
  chatHarness: Schema.optionalKey(Schema.String),
  chatModel: Schema.optionalKey(Schema.String),
  chatEffort: Schema.optionalKey(Schema.String),
  chatWidth: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  recordTiming: Schema.optionalKey(Schema.Boolean),
  setupNotNow: Schema.optionalKey(Schema.String),
  setupNever: Schema.optionalKey(Schema.Boolean),
});
export type DesktopSettingsChange = typeof DesktopSettingsChange.Type;

export interface MachineToAdd {
  readonly target: string;
  readonly label: string;
}

export const machineToAdd = (typed: MachineToAdd) => {
  const [target, label] = Arr.map([typed.target, typed.label], (one) => Str.trim(one));
  return target && label ? { target, label } : null;
};

export const KeptRecord = Schema.Struct({
  detail: Schema.NullOr(RunDetail),
  asOf: Schema.NullOr(Schema.Finite),
  bytes: Schema.Finite,
});
export type KeptRecord = typeof KeptRecord.Type;

export const DesktopRpcs = RpcGroup.make(
  Rpc.make("flock", { success: FlockItem, stream: true }),
  Rpc.make("act", {
    payload: {
      installation: Schema.String,
      action: DesktopAction,
      request: Schema.optional(Schema.String),
      unsent: Schema.optional(Schema.String),
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
  Rpc.make("terminalSend", { payload: { command: TerminalCommand }, error: ActionFailed }),
  Rpc.make("openLink", { payload: { url: Schema.String } }),
  Rpc.make("definitions", {
    payload: { installation: Schema.String },
    success: HostDefinitions,
    error: ActionFailed,
  }),
  Rpc.make("updates", { success: DesktopUpdates, stream: true }),
  Rpc.make("checkForUpdates", { success: UpdateNews }),
  Rpc.make("restart", { error: ActionFailed }),
  Rpc.make("onboard", {
    payload: { profile: Schema.String, skip: Schema.optionalKey(Schema.Array(Skippable)) },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("addMachine", {
    payload: { target: Schema.String, label: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("flockSettings", { success: FlockSettings, error: ActionFailed, stream: true }),
  Rpc.make("setFlockSetting", {
    payload: { key: Schema.String, value: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("setFlockSettings", {
    payload: { changes: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })) },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("credentials", { success: Credentials, stream: true }),
  Rpc.make("saveGitlab", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("saveGitlabHost", {
    payload: { host: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("checkHelle", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("openSlack"),
  Rpc.make("copyText", { payload: { text: Schema.String } }),
  Rpc.make("saveHelle", {
    payload: { token: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("slackUser", { success: SlackUserState, stream: true }),
  Rpc.make("signInSlackUser", { success: Schema.String, error: ActionFailed }),
  Rpc.make("signOutSlackUser", { success: Schema.String, error: ActionFailed }),
  Rpc.make("slackUserChannels", { success: Schema.Array(SlackChannel), error: ActionFailed }),
  Rpc.make("claudeLogin", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("pasteCode", { payload: { job: Schema.String, code: Schema.String } }),
  Rpc.make("removeMachine", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("syncNow", {
    payload: { profile: Schema.String },
    success: Schema.Struct({ said: Schema.String, failed: Schema.Boolean }),
    error: ActionFailed,
  }),
  Rpc.make("usage", { success: Schema.Array(MachineUsage) }),
  Rpc.make("catalogues", { success: Schema.Array(MachineCatalogue) }),
  Rpc.make("connectionReadings", { success: Schema.Array(MachineConnections) }),
  Rpc.make("reuseConnection", {
    payload: {
      id: Schema.Literals(["gitlab", "github"]),
      from: Schema.String,
      to: Schema.Array(Schema.String),
    },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("githubLogin", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("linearSetup", {
    payload: { profile: Schema.String },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("pasteGitlab", { success: Schema.String, error: ActionFailed }),
  Rpc.make("schedules", { success: Schema.Array(MachineSchedules) }),
  Rpc.make("cleanup", {
    payload: { profile: Schema.String },
    success: CleanupListing,
    error: ActionFailed,
  }),
  Rpc.make("sweep", {
    payload: { installation: Schema.String, machine: Schema.String, request: Schema.String },
    success: CleanupReport,
    error: ActionFailed,
  }),
  Rpc.make("changeSchedule", {
    payload: {
      installation: Schema.String,
      change: Schema.Literals(["pause", "resume", "remove"]),
      name: Schema.String,
      request: Schema.optional(Schema.String),
    },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("moveSchedule", {
    payload: {
      from: Schema.String,
      to: Schema.String,
      name: Schema.String,
      checkout: Schema.optional(Schema.String),
      request: Schema.optional(Schema.String),
    },
    success: Schema.String,
    error: ActionFailed,
  }),
  Rpc.make("runDetail", {
    payload: { installation: Schema.String, runId: Schema.String },
    success: KeptRecord,
    error: ActionFailed,
    stream: true,
  }),
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
  Rpc.make("artefacts", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      refresh: Schema.optional(Schema.Boolean),
    },
    success: ArtefactCollection,
    error: ActionFailed,
  }),
  Rpc.make("artefactSearch", {
    payload: FlockSearch.fields,
    success: FlockArtefacts,
    error: ActionFailed,
  }),
  Rpc.make("artefactRead", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      id: Schema.String,
      revision: Schema.Int,
      offset: Schema.Int,
    },
    success: RunFile,
    error: ActionFailed,
  }),
  Rpc.make("artefactRegister", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      request: Schema.String,
      ...RegisterArtefact.fields,
    },
    success: ArtefactRegistered,
    error: ActionFailed,
  }),
  Rpc.make("artefactImport", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      path: Schema.String,
      request: Schema.String,
    },
    success: ArtefactRegistered,
    error: ActionFailed,
  }),
  Rpc.make("artefactSeen", {
    payload: {
      installation: Schema.String,
      runId: Schema.String,
      id: Schema.String,
      revision: Schema.NullOr(Schema.Int),
      request: Schema.String,
    },
    success: Artefact,
    error: ActionFailed,
  }),
  Rpc.make("say", {
    payload: {
      text: Schema.String,
      about: Schema.NullOr(About),
      now: Schema.optionalKey(Schema.Boolean),
      attachments: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: AguiEvent,
    stream: true,
  }),
  Rpc.make("stage", {
    payload: {
      key: Schema.String,
      name: Schema.String,
      mediaType: Schema.String,
      size: Schema.Int,
      offset: Schema.Int,
      content: Schema.String,
      scaledOf: Schema.optionalKey(Schema.String),
    },
    success: Schema.NullOr(Staged),
    error: ActionFailed,
  }),
  Rpc.make("stagePaths", {
    payload: { paths: Schema.Array(Schema.String) },
    success: Schema.Array(StagedOrRefused),
  }),
  Rpc.make("pickFiles", { success: Schema.Array(StagedOrRefused) }),
  Rpc.make("clipboardFiles", { success: Schema.Array(StagedOrRefused) }),
  Rpc.make("placeFiles", {
    payload: { installation: Schema.String, ids: Schema.Array(Schema.String) },
    success: Schema.Array(Schema.String),
    error: ActionFailed,
  }),
  Rpc.make("attachmentFile", {
    payload: { id: Schema.String, offset: Schema.optionalKey(Schema.Int) },
    success: Schema.Struct({ content: Schema.String, size: Schema.Int }),
    error: ActionFailed,
  }),
  Rpc.make("answer", {
    payload: { toolCallId: Schema.String, answers: Answers },
  }),
  Rpc.make("transcript", { success: Schema.Array(ChatMessage) }),
  Rpc.make("conversations", { success: Conversations }),
  Rpc.make("reopen", {
    payload: { conversation: Schema.NullOr(HeldConversation) },
    error: ActionFailed,
  }),
  Rpc.make("popOut"),
  Rpc.make("popIn"),
  Rpc.make("conversationChanges", { success: Schema.String, stream: true }),
  Rpc.make("desktopTurns", { success: DesktopTurn, stream: true }),
  Rpc.make("settings", { success: DesktopSettings, stream: true }),
  Rpc.make("chatChoices", { success: ChatChoices, stream: true }),
  Rpc.make("drawn", { success: Drawn, stream: true }),
  Rpc.make("setSettings", {
    payload: DesktopSettingsChange,
    success: DesktopSettings,
    error: ActionFailed,
  }),
  Rpc.make("recordMark", {
    payload: { name: Schema.String, at: Schema.Finite, card: Schema.String },
  }),
  Rpc.make("setupOffer", { success: Schema.Boolean, stream: true }),
  Rpc.make("declineSetup", { payload: { forGood: Schema.Boolean }, error: ActionFailed }),
  Rpc.make("setupInventory", { success: Schema.Array(ComputerStores) }),
  Rpc.make("chooseSetup", { payload: { choice: SetupChoice } }),
  Rpc.make("setupChosen", { success: Schema.NullOr(SetupChoice), stream: true }),
  Rpc.make("takeSetup", { success: Schema.NullOr(SetupChoice) }),
  Rpc.make("setUp", { payload: { choice: SetupChoice }, success: AguiEvent, stream: true }),
);

export interface FlockMachine {
  readonly machine: Machine;
  readonly herds: ReadonlyArray<Herd>;
  readonly tasks: ReadonlyMap<string, TaskView>;
  readonly asOf: number | null;
  readonly build: string | null;
  readonly development: string | null;
  readonly protocol: number | null;
  readonly files: boolean;
  readonly artefacts?: boolean;
}

export interface Flock {
  readonly machines: ReadonlyMap<string, FlockMachine>;
  readonly lost: ReadonlyMap<
    string,
    { readonly name: string; readonly state: NotLive; readonly reason: string }
  >;
  readonly notices: ReadonlyArray<string>;
  readonly routes: ReadonlyMap<string, KnownMachine>;
  readonly onboarding: ReadonlyMap<string, MachineOnboarding>;
  readonly onboarded: ReadonlyMap<string, OnboardRun>;
  readonly doctored: ReadonlyMap<string, OnboardRun>;
  readonly synced: ReadonlyMap<string, string | null>;
  readonly own: ReadonlyMap<string, OwnReading>;
  readonly definitions: ReadonlyMap<string, string | null>;
  readonly given: ReadonlyMap<string, CredentialsGiven>;
  readonly links: ReadonlyMap<string, PeerView>;
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
  own: new Map(),
  definitions: new Map(),
  given: new Map(),
  links: new Map(),
};

const removed = (flock: Flock, profile: string) => {
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
    own: without(flock.own),
    definitions: without(flock.definitions),
    given: without(flock.given),
    links: without(flock.links),
    machines: new Map(
      Arr.filter([...flock.machines], ([, { machine }]) => machine.profile !== profile),
    ),
  };
};

export const applyItem = (flock: Flock, item: FlockItem) => {
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
    return item.part === "settings"
      ? { ...flock, synced: new Map(flock.synced).set(item.machine.profile, item.failed) }
      : {
          ...flock,
          definitions: new Map(flock.definitions).set(item.machine.profile, item.failed),
        };
  if ("_tag" in item && item._tag === "Linked")
    return { ...flock, links: new Map(flock.links).set(item.machine.profile, item.link) };
  if ("_tag" in item && item._tag === "OwnRead")
    return {
      ...flock,
      own: new Map(flock.own).set(
        item.machine.profile,
        keepOwn(item.reading, flock.own.get(item.machine.profile)),
      ),
    };
  if ("_tag" in item && item._tag === "Given") {
    const { machine, credential, given, failed } = item;
    const { profile } = machine;
    const had = flock.given.get(profile);
    return {
      ...flock,
      given: new Map(flock.given).set(profile, { ...had, [credential]: { given, failed } }),
    };
  }
  if ("_tag" in item && item._tag === "Routes") {
    const kept = new Set(item.profiles);
    const shown = [...flock.routes.keys(), ...flock.lost.keys()].concat(
      Arr.map([...flock.machines.values()], ({ machine }) => machine.profile),
    );
    return Arr.reduce(
      Arr.filter([...new Set(shown)], (profile) => !kept.has(profile)),
      flock,
      (left, profile) => removed(left, profile),
    );
  }
  if ("_tag" in item && item._tag === "Removed") return removed(flock, item.machine.profile);
  if ("_tag" in item && item._tag === "Saved") {
    const { machine, herds, tasks, at } = item;
    if (flock.machines.has(machine.installation)) return flock;
    const saved = {
      machine,
      herds,
      tasks: new Map(Arr.map(tasks, (task) => [task.id, task])),
      asOf: at,
      build: item.build ?? null,
      development: item.development ?? null,
      protocol: null,
      files: false,
    };
    return { ...flock, machines: new Map(flock.machines).set(machine.installation, saved) };
  }
  const lost = new Map(flock.lost);
  if ("_tag" in item && item._tag === "Merged") {
    lost.delete(item.machine.profile);
    return { ...flock, lost };
  }
  if ("_tag" in item) {
    const { machine, at } = item;
    if (item._tag === "Lost")
      lost.set(machine.profile, { name: machine.name, state: item.state, reason: item.reason });
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
    message._tag === "Snapshot" ? Arr.map(message.tasks, (task) => [task.id, task]) : known?.tasks,
  );
  if (message._tag === "Upsert") tasks.set(message.task.id, message.task);
  if (message._tag === "Remove") tasks.delete(message.id);
  const herds = message._tag === "Snapshot" ? message.herds : (known?.herds ?? []);
  const build = message._tag === "Snapshot" ? message.build : (known?.build ?? null);
  const development =
    message._tag === "Snapshot" ? (message.development ?? null) : (known?.development ?? null);
  const protocol = message._tag === "Snapshot" ? message.protocol : (known?.protocol ?? null);
  const files = message._tag === "Snapshot" ? message.files === true : (known?.files ?? false);
  const artefacts =
    message._tag === "Snapshot" ? message.artefacts === true : (known?.artefacts ?? false);
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
      protocol,
      files,
      artefacts,
    }),
    lost,
  };
};

export const machineNames = (machines: ReadonlyArray<Machine>) => {
  const counts = new Map<string, number>();
  for (const { name } of machines) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(
    Arr.map(machines, (m) => [
      m.installation,
      counts.get(m.name)! > 1 ? `${m.name} (${m.target ?? "local"})` : m.name,
    ]),
  );
};

const shownNames = (flock: Flock) => {
  const names = machineNames(Arr.map([...flock.machines.values()], ({ machine }) => machine));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [installation, { asOf }] of flock.machines) {
    const name = names.get(installation)!;
    if (asOf !== null && counts.get(name)! > 1)
      names.set(installation, `${pipe_(name, Str.replace(/\)$/, ""))}, saved)`);
  }
  return names;
};

export const nameAsShown = (flock: Flock) => {
  const names = shownNames(flock);
  return (machine: Machine) => names.get(machine.installation) ?? machine.name;
};

export interface PlacedTask {
  readonly key: string;
  readonly installation: string;
  readonly machine: string;
  readonly task: TaskView;
  readonly where: string;
  readonly asOf: number | null;
}

export interface FlockCards {
  readonly tasks: ReadonlyArray<TaskView>;
  readonly placedOf: (task: TaskView) => PlacedTask;
  readonly byKey: ReadonlyMap<string, PlacedTask>;
  readonly machines: ReadonlyArray<{
    readonly installation: string;
    readonly name: string;
    readonly local: boolean;
  }>;
  readonly away: ReadonlySet<string>;
}

const samePlace = (one: PlacedTask, other: Omit<PlacedTask, "task">) =>
  one.key === other.key &&
  one.installation === other.installation &&
  one.machine === other.machine &&
  one.where === other.where &&
  one.asOf === other.asOf;

export const flockCards = (flock: Flock, before?: FlockCards) => {
  const names = shownNames(flock);
  const placed = new Map<TaskView, PlacedTask>();
  const byKey = new Map<string, PlacedTask>();
  const away = new Set<string>();
  for (const [installation, { herds, tasks, asOf }] of flock.machines) {
    // WARNING: `names` holds every Machine of this Flock.
    const machine = names.get(installation)!;
    if (asOf !== null) away.add(machine);
    for (const task of tasks.values()) {
      const herd =
        herds.length > 1
          ? Option.getOrUndefined(Arr.findFirst(herds, ({ id }) => id === task.herd))
          : undefined;
      const where = [
        flock.machines.size > 1 ? names.get(installation) : undefined,
        herd === undefined ? undefined : (herd.name ?? herd.id),
      ];
      const place = {
        key: `${installation}:${task.id}`,
        installation,
        machine,
        where: Arr.join(
          Arr.filter(where, (part) => part !== undefined),
          " · ",
        ),
        asOf,
      };
      const was = before?.byKey.get(place.key);
      const one =
        was !== undefined && was.task === task && samePlace(was, place) ? was : { ...place, task };
      placed.set(task, one);
      byKey.set(one.key, one);
    }
  }
  const machines = Arr.map(
    Arr.filter([...flock.machines], ([, { asOf }]) => asOf === null),
    ([installation, { machine }]) => ({
      installation,
      name: names.get(installation)!,
      local: machine.profile === "local",
    }),
  );
  return {
    tasks: sortBoard([...placed.keys()]),
    // WARNING: the board's helpers filter and sort these Tasks; they never make new ones.
    placedOf: (task: TaskView) => placed.get(task)!,
    byKey,
    machines,
    away:
      before !== undefined &&
      before.away.size === away.size &&
      Arr.every([...away], (name) => before.away.has(name))
        ? before.away
        : away,
  };
};

export type ChatBoard =
  | {
      readonly _tag: "Live";
      readonly herds: ReadonlyArray<Herd>;
      readonly tasks: ReadonlyArray<TaskView>;
      readonly protocol: number;
      readonly files: boolean;
    }
  | { readonly _tag: "Connecting"; readonly since: number | null }
  | { readonly _tag: "Lost"; readonly state: NotLive; readonly reason: string }
  | { readonly _tag: "Saved"; readonly at: number };

export const chatBoards = (flock: Flock, since: ReadonlyMap<string, number>) => {
  const names = shownNames(flock);
  const waiting: (profile: string) => ChatBoard = (profile) => {
    const lost = flock.lost.get(profile);
    return lost === undefined
      ? { _tag: "Connecting", since: since.get(profile) ?? null }
      : { _tag: "Lost", state: lost.state, reason: lost.reason };
  };
  const shown = Arr.map([...flock.machines], ([installation, known]) => {
    const { profile } = known.machine;
    const liveThere = Arr.some(
      [...flock.machines.values()],
      (other) => other.machine.profile === profile && other.asOf === null,
    );
    const board: ChatBoard =
      known.asOf === null
        ? known.protocol === null
          ? waiting(profile)
          : {
              _tag: "Live",
              herds: known.herds,
              tasks: [...known.tasks.values()],
              protocol: known.protocol,
              files: known.files,
            }
        : liveThere || !flock.routes.has(profile)
          ? { _tag: "Saved", at: known.asOf }
          : waiting(profile);
    // WARNING: `names` holds every Machine of this Flock.
    return { name: names.get(installation)!, profile, installation, board };
  });
  const unshown = Arr.map(
    Arr.filter(
      [...flock.routes.values()],
      ({ profile }) => !Arr.some(shown, (one) => one.profile === profile),
    ),
    ({ profile, name }) => ({ name, profile, installation: null, board: waiting(profile) }),
  );
  return [...shown, ...unshown];
};

const LOST_SAID: Record<NotLive, (name: string) => string> = {
  unreachable: (name) => `${name} is out of reach`,
  sso: (name) => `${name} is waiting for an SSO login`,
  "no-collie": (name) => `Collie isn't installed on ${name}`,
  "update-desktop": (name) => `${name} needs a newer Desktop`,
};

const waited = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
};

export const unreadBecause = (
  name: string,
  board: Exclude<ChatBoard, { readonly _tag: "Live" }>,
  now: number,
) => {
  switch (board._tag) {
    case "Connecting":
      return board.since === null
        ? `${name} is still connecting; Desktop has had no board from it yet`
        : `${name} is still connecting; Desktop has waited ${waited(now - board.since)} for its first board`;
    case "Lost":
      return `${LOST_SAID[board.state](name)}: ${pipe_(board.reason, Str.replace(/\.$/, ""))}`;
    case "Saved":
      return `${name} is only a board Desktop saved at ${DateTime.formatIso(DateTime.makeUnsafe(board.at))}, with no live host since`;
  }
};

export interface MachineRow {
  readonly profile: string;
  readonly name: string;
  readonly target: string | null;
  readonly route: "link" | "ssh" | null;
  readonly state: "live" | "connecting" | NotLive;
  readonly onboarded: OnboardRun | null;
  readonly build: string | null;
  readonly development: string | null;
  readonly settings: { readonly failed: string | null } | null;
  readonly definitions: { readonly failed: string | null } | null;
  readonly credentials: CredentialsGiven;
  readonly reason: string | null;
  readonly transport: "direct" | "ssh" | null;
  readonly transportReason: string | null;
}

export const routeSaid = ({ route, transport }: Pick<MachineRow, "route" | "transport">) =>
  route === "ssh"
    ? "SSH"
    : `Paired link${transport === null ? "" : transport === "ssh" ? " · over SSH" : " · direct"}`;

const WAITS_SAID =
  "Its link waits on an SSH connection, which Desktop opens when it next connects.";

const standing = (onboarding?: OnboardRun, doctor?: OnboardRun) => {
  if (doctor === undefined || (onboarding !== undefined && onboarding.at > doctor.at))
    return onboarding ?? null;
  const skipped = new Set(
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(onboarding), (present) =>
        Arr.map(
          Arr.filter(present.steps, ({ status }) => status === "skipped"),
          ({ step }) => step,
        ),
      ),
    ),
  );
  const listed = new Set(Arr.map(doctor.steps, ({ step }) => step));
  const left = Arr.filter(
    onboarding?.steps ?? [],
    ({ step, status }) =>
      Arr.some(Skippable.literals, (one) => one === step) &&
      !listed.has(step) &&
      !SETTLED.includes(status),
  );
  const steps = [...Arr.filter(doctor.steps, ({ step }) => !skipped.has(step)), ...left];
  return { ...doctor, steps, ready: steps.length === 0 };
};

export const notLiveOf = (flock: Flock, installation: string) => {
  const shown = flock.machines.get(installation);
  if (shown === undefined || shown.asOf === null) return null;
  const lost = flock.lost.get(shown.machine.profile);
  return lost === undefined
    ? { icon: "i-lucide-refresh-cw", title: `${shown.machine.name} is reconnecting`, reason: "" }
    : {
        icon: NOT_LIVE[lost.state].icon,
        title: NOT_LIVE[lost.state].title(lost.name),
        reason: lost.reason,
      };
};

export const machineRows: (flock: Flock) => ReadonlyArray<MachineRow> = (flock) =>
  Arr.map([...flock.routes.values()], ({ profile, name, target }) => {
    const seen = Arr.filter(
      [...flock.machines.values()],
      ({ machine }) => machine.profile === profile,
    );
    const shown =
      Option.getOrUndefined(Arr.findFirst(seen, ({ asOf }) => asOf === null)) ??
      seen.sort((a, b) => b.asOf! - a.asOf!)[0];
    const live = shown?.asOf === null;
    const lost = flock.lost.get(profile);
    const link = flock.links.get(profile);
    const transport = link?.state === "live" ? link.transport : null;
    const waits = link?.waits === "ssh_connection" ? WAITS_SAID : null;
    return {
      profile,
      name,
      target: target ?? null,
      route: live ? (shown?.machine.route ?? null) : null,
      state: live ? "live" : (lost?.state ?? "connecting"),
      onboarded: standing(flock.onboarded.get(profile), flock.doctored.get(profile)),
      build: shown?.build ?? null,
      development: shown?.development ?? null,
      settings: flock.synced.has(profile) ? { failed: flock.synced.get(profile)! } : null,
      definitions: flock.definitions.has(profile)
        ? { failed: flock.definitions.get(profile)! }
        : null,
      credentials: flock.given.get(profile) ?? {},
      reason: (live ? null : lost?.reason) ?? waits,
      transport,
      transportReason: transport === "ssh" ? (link?.direct ?? null) : null,
    };
  });

export const flockOf = <E, R>(items: Stream.Stream<FlockItem, E, R>) =>
  items.pipe(
    Stream.scan(() => EMPTY_FLOCK, applyItem),
    Stream.drop(1),
  );
