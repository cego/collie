// What each harness offers the Flock chat, and what its session opens on: the set choice,
// with an unset model and effort resolved as the harness, or Pi's own configuration, has them.

import { homedir } from "node:os";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { HARNESS_MODELS } from "../../../src/harness-choice";
import { type Offer, PiConfig, runsAs } from "../shared/chat-choices";
import type { DesktopSettings } from "../shared/flock";
import { CHAT_HARNESSES, DEFAULT_CHAT_HARNESS, type FlockSettings } from "../shared/flock-settings";
import { childEnv } from "./login-env";
import type { HarnessList, HarnessLists } from "./harness-lists";
import { chatChoice, extraModels, type Offers } from "./settings";

/** Pi's configuration as it is now; nothing where it has none or it cannot be read. */
export const readPiConfig = Effect.fn("PiConfig.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agent =
    childEnv().PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, homedir()) ?? `${homedir()}/.pi/agent`;
  return yield* fs.readFileString(path.resolve(dir, agent, "settings.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PiConfig))),
    Effect.orElseSucceed((): PiConfig => ({})),
  );
});

/** Table models plus valid Flock extras and the set model. */
export const tableOffer = (
  harness: string,
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: PiConfig,
): Offer => {
  const set =
    (settings.chatHarness ?? DEFAULT_CHAT_HARNESS) === harness ? settings.chatModel : undefined;
  const efforts = HARNESS_MODELS[harness]?.efforts ?? [];
  const listed = [
    ...new Set([
      ...(HARNESS_MODELS[harness]?.models ?? []),
      ...(extraModels(flock)[harness] ?? []),
      ...(set === undefined ? [] : [set]),
    ]),
  ]
    .filter((id) => chatChoice({ proactive: true, chatHarness: harness, chatModel: id }, flock).ok)
    .map((id) => ({ id, efforts }));
  return {
    from: "table",
    unset: runsAs({ harness }, listed, pi),
    models: listed.map(({ id }) => ({
      id,
      label: id,
      efforts,
      unsetEffort: runsAs({ harness, model: id }, listed, pi).effort,
    })),
  };
};

const configFor = <R>(harness: string, pi: Effect.Effect<PiConfig, never, R>) =>
  harness === "pi" ? pi : Effect.succeed<PiConfig>({});

const withList = (
  table: Offer,
  list: HarnessList | undefined,
  pi: PiConfig,
  settings: DesktopSettings,
): Offer => {
  if (list?.from === "table") return { ...table, why: list.why };
  if (list?.from !== "harness") return table;
  const harness = table.unset.harness;
  const typed =
    (settings.chatHarness ?? DEFAULT_CHAT_HARNESS) === harness &&
    table.models.find(
      ({ id }) => id === settings.chatModel && !list.models.some((model) => model.id === id),
    );
  return {
    from: "harness",
    unset: runsAs({ harness }, list.models, pi),
    ...(typed && { typed: runsAs({ harness, model: typed.id }, list.models, pi) }),
    models: list.models.map((model) => ({
      ...model,
      unsetEffort: runsAs({ harness, model: model.id }, list.models, pi).effort,
    })),
  };
};

/** What `harness` offers now, with Pi's configuration as `pi` reads it. */
export const offerOf = <R>(
  harness: string,
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: Effect.Effect<PiConfig, never, R>,
  lists?: HarnessLists,
) =>
  configFor(harness, pi).pipe(
    Effect.map((config) => {
      const list = lists?.now(harness);
      return list?.from === "reading"
        ? list
        : withList(tableOffer(harness, settings, flock, config), list, config, settings);
    }),
  );

/** What every harness the chat has a driver for offers now. */
export const offersOf = <R>(
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: Effect.Effect<PiConfig, never, R>,
  lists?: HarnessLists,
) =>
  Effect.forEach(CHAT_HARNESSES, (harness) =>
    configFor(harness, pi).pipe(
      Effect.map(
        (config) =>
          [
            harness,
            withList(
              tableOffer(harness, settings, flock, config),
              lists?.now(harness),
              config,
              settings,
            ),
          ] as const,
      ),
    ),
  ).pipe(Effect.map((offered): Offers => Object.fromEntries(offered)));

/** The checked session choice, with Pi's configuration read afresh. */
export const opensOn = <R>(
  settings: DesktopSettings,
  flock: FlockSettings,
  pi: Effect.Effect<PiConfig, never, R>,
  lists?: HarnessLists,
) =>
  Effect.gen(function* () {
    const checked = chatChoice({ chatHarness: settings.chatHarness }, flock);
    if (!checked.ok) return checked;
    const { harness } = checked.choice;
    if (lists !== undefined) yield* lists.ready(harness);
    const config = yield* configFor(harness, pi);
    const offered = withList(
      tableOffer(harness, settings, flock, config),
      lists?.now(harness),
      config,
      settings,
    );
    const ready = chatChoice(settings, flock, { [harness]: offered });
    if (!ready.ok) return ready;
    return {
      ok: true as const,
      choice: runsAs(
        { harness, model: settings.chatModel, effort: settings.chatEffort },
        offered.models,
        config,
      ),
    };
  });

/** Saved settings and model changes; both inputs must emit their current value first. */
export const retelling = (
  settings: Stream.Stream<DesktopSettings>,
  flock: Stream.Stream<FlockSettings>,
): Stream.Stream<unknown> =>
  Stream.merge(
    Stream.drop(settings, 1),
    flock.pipe(
      Stream.map(extraModels),
      Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      Stream.drop(1),
    ),
  );
