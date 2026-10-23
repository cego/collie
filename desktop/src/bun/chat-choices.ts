// What the Flock chat runs on and could run on, as every chat window and the chat's own tool
// are told it.

import { homedir } from "node:os";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import {
  type ChatChoices,
  type ChatHeld,
  PiConfig,
  type Resolved,
  resolveChat,
} from "../shared/chat-choices";
import type { DesktopSettings } from "../shared/flock";
import {
  CHAT_HARNESSES,
  DEFAULT_CHAT_HARNESS,
  type FlockSettings,
  harnessLabel,
} from "../shared/flock-settings";
import { childEnv } from "./login-env";
import { type HarnessLists, type Lists, NO_LISTS } from "./harness-lists";
import { chatChoice, effortRefused, extraModels, offersOf } from "./settings";

const PiSettings = Schema.fromJsonString(PiConfig);

/** Pi's own settings as Pi run in `dir` reads them now; none where they cannot be read. */
export const readPiConfig = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const agent =
      childEnv().PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, homedir()) ?? `${homedir()}/.pi/agent`;
    return yield* fs
      .readFileString(path.resolve(dir, agent, "settings.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PiSettings)));
  }).pipe(Effect.orElseSucceed((): PiConfig => ({})));

/**
 * What the next session runs on, each unset choice resolved, or why the settings cannot run.
 * Waits for the harness's own list while it is read, and checks the set effort against it. Pi's own settings are read only for Pi.
 */
export const chatResolved = <R>(
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: Effect.Effect<PiConfig, never, R>,
  lists: HarnessLists = NO_LISTS,
) =>
  Effect.gen(function* () {
    const checked = chatChoice(settings, flock);
    if (!checked.ok) return checked;
    const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
    const listed = yield* lists.settled(harness);
    const config = harness === "pi" ? yield* pi : {};
    const offer = offersOf(settings, flock, config, listed)(harness);
    const refused =
      settings.chatEffort === undefined
        ? null
        : effortRefused(harness, settings.chatModel, settings.chatEffort, offer);
    if (refused !== null) return { ok: false as const, problem: refused };
    const set = { harness, model: settings.chatModel, effort: settings.chatEffort };
    const choice: Resolved = resolveChat(set, offer.models, config);
    return { ok: true as const, choice };
  });

/** The account of every harness the chat has a driver for, around what the chat module holds. */
export const chatChoicesOf = (
  held: ChatHeld,
  installed: Readonly<Record<string, boolean>>,
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: PiConfig,
  lists: Lists = {},
): ChatChoices => {
  const offers = offersOf(settings, flock, pi, lists);
  return {
    ...held,
    harnesses: CHAT_HARNESSES.map((harness) => ({
      harness,
      label: harnessLabel(harness),
      installed: installed[harness] ?? false,
      offered: lists[harness]?.from === "reading" ? { from: "reading" } : offers(harness),
    })),
  };
};

const sameExtras = (one: FlockSettings, other: FlockSettings) =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))(extraModels(one)) ===
  Schema.encodeSync(Schema.fromJsonString(Schema.Json))(extraModels(other));

/**
 * The account, when subscribed and again whenever what the chat holds, Desktop's settings,
 * the Flock's extra models or a harness's own list change. The set harness's list is read.
 */
export const chatChoicesStream = (opts: {
  readonly held: Stream.Stream<ChatHeld>;
  readonly settings: Stream.Stream<DesktopSettings>;
  readonly flock: Stream.Stream<FlockSettings>;
  readonly installed: Readonly<Record<string, boolean>>;
  readonly pi: Effect.Effect<PiConfig>;
  readonly lists?: HarnessLists;
}) => {
  const lists = opts.lists ?? NO_LISTS;
  return Stream.zipLatestAll(
    opts.held,
    opts.settings.pipe(
      Stream.tap((settings) => lists.need(settings.chatHarness ?? DEFAULT_CHAT_HARNESS)),
    ),
    opts.flock.pipe(Stream.changesWith(sameExtras)),
    lists.changes,
  ).pipe(
    Stream.mapEffect(([held, settings, flock, listed]) =>
      Effect.map(opts.pi, (pi) => chatChoicesOf(held, opts.installed, settings, flock, pi, listed)),
    ),
  );
};
