// The Flock's settings as Desktop keeps them: each key decided by its latest edit, wherever
// that was made, and given to every Machine through its host.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, SubscriptionRef } from "effect";
import { HostRefused, type SharedSetting, type SharedSettings } from "../src/board-model";
import {
  desktopChange,
  editSetting,
  type FlockSettings,
  NO_FLOCK_SETTINGS,
  settingSections,
  takeFrom,
} from "../desktop/src/shared/flock-settings";
import { flockSync } from "../desktop/src/bun/flock-settings";
import { settingStored } from "../src/settings";
import {
  applyChange,
  changeSettings,
  readSettings,
  writeSettings,
} from "../desktop/src/bun/settings";

const at = (hour: number) => `2026-10-07T${String(hour).padStart(2, "0")}:00:00.000Z`;
const set = (key: string, value: SharedSetting["value"], hour: number): SharedSetting => ({
  key,
  value,
  at: at(hour),
});

test("the first sync takes a key set on only one Machine from it", () => {
  const { flock, give } = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [set("model", "sonnet", 9)]);

  expect(flock.settings.model).toEqual({
    value: "sonnet",
    at: at(9),
    from: "vm-a",
    differed: false,
  });
  expect(give).toEqual([]);
  // The next Machine is given what the Flock has, with its edit's time.
  expect(takeFrom(flock, "vm-b", []).give).toEqual([set("model", "sonnet", 9)]);
});

test("a key set differently on several Machines takes the latest, and says where from", () => {
  const first = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [set("scope", "all", 9)]).flock;
  const { flock, give } = takeFrom(first, "vm-b", [set("scope", "local", 11)]);

  expect(flock.settings.scope).toMatchObject({ value: "local", from: "vm-b", differed: true });
  expect(give).toEqual([]);
  // Said once: a later edit on a Machine already synced is just the latest.
  const later = takeFrom(flock, "vm-a", [set("scope", "all", 12)]).flock;
  expect(later.settings.scope).toMatchObject({ value: "all", from: "vm-a", differed: false });
  // vm-a has the older value, so it is given vm-b's when it is next seen.
  expect(takeFrom(flock, "vm-a", [set("scope", "all", 9)]).give).toEqual([
    set("scope", "local", 11),
  ]);
  // An older value elsewhere loses to the Flock's, which keeps saying where it came from.
  const older = takeFrom(flock, "vm-c", [set("scope", "all", 8)]);
  expect(older.flock.settings.scope).toMatchObject({ value: "local", from: "vm-b" });
  expect(older.give).toEqual([set("scope", "local", 11)]);
});

test("an edit in Desktop is the latest, is checked as the TUI checks it, and differs from nothing", () => {
  const first = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [set("scope", "all", 9)]).flock;
  const edited = editSetting(first, "max_iterations", " 8 ", at(12));
  expect(edited).toMatchObject({
    settings: { max_iterations: { value: 8, at: at(12), from: "Desktop", differed: false } },
  });
  expect(editSetting(first, "max_iterations", "eight", at(12))).toEqual({
    refused: 'max_iterations has to be a whole number, not "eight"',
  });
  // Cleared is an edit too: it unsets the key on every Machine.
  expect(editSetting(first, "scope", "", at(12))).toMatchObject({
    settings: { scope: { value: null, from: "Desktop" } },
  });
});

test("Settings shows every setting with its control, its value and its default", () => {
  const flock = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    set("scope", "all", 9),
    set("models.claude", ["claude-x"], 9),
    set("quiet_ms", 90000, 9),
  ]).flock;
  const sections = settingSections(takeFrom(flock, "vm-b", [set("scope", "local", 11)]).flock, {
    proactive: false,
  });
  const rows = sections.flatMap((section) => section.rows);
  const row = (key: string, shared = true) =>
    rows.find((one) => one.key === key && one.shared === shared);

  expect(sections.map((section) => section.group)).toEqual([
    "Agents",
    "Runs",
    "Board",
    "Chat",
    "Notifications",
  ]);
  expect(row("scope")).toMatchObject({
    label: "Board scope",
    kind: "choice",
    choices: ["local", "all"],
    value: "local",
    fallback: "local",
    set: true,
    from: "vm-b",
  });
  expect(row("max_iterations")).toMatchObject({
    kind: "number",
    value: "",
    fallback: "5",
    set: false,
    from: null,
  });
  // In its unit: the value and the default both.
  expect(row("quiet_ms")).toMatchObject({
    value: "1.5",
    fallback: "10",
    unit: "minutes",
    defaultSaid: "Default: 10 minutes",
  });
  expect(row("effort")).toMatchObject({ defaultSaid: "Unset: the harness decides" });
  expect(row("models.claude")).toMatchObject({ value: "claude-x" });
  expect(row("proactive")).toMatchObject({ kind: "boolean", shared: true });
  // The Flock chat's own switch is this computer's, under Chat.
  expect(sections.find((section) => section.group === "Chat")!.rows).toContainEqual(
    expect.objectContaining({
      key: "proactive",
      shared: false,
      value: "false",
      fallback: "true",
      set: true,
    }),
  );
  // As is the Machine rule, which no Machine is given.
  expect(row("machineRule", false)).toMatchObject({
    group: "Chat",
    kind: "text",
    value: "",
    set: false,
    defaultSaid: "Unset: no rule",
    multiline: true,
  });
  expect(row("chatHarness", false)).toMatchObject({
    group: "Chat",
    label: "Flock chat harness",
    kind: "choice",
    choices: ["claude", "pi"],
    value: "claude",
    set: false,
  });
  expect(row("chatModel", false)).toMatchObject({
    group: "Chat",
    label: "Flock chat model",
    kind: "text",
    value: "",
    set: false,
    multiline: false,
    defaultSaid: "Unset: opus",
  });
  // The GitLab host is shared too, but beside the tokens made for it.
  expect(rows.map((one) => one.key)).not.toContain("gitlab_host");
});

test("a duration typed in minutes is the Flock's in milliseconds, and Reset unsets it", () => {
  const quiet = (flock: FlockSettings) =>
    settingSections(flock, { proactive: true })
      .flatMap((section) => section.rows)
      .find((row) => row.key === "quiet_ms")!;
  const typed = settingStored("quiet_ms", "15");
  if ("refused" in typed) throw new Error(typed.refused);
  const edited = editSetting(NO_FLOCK_SETTINGS, "quiet_ms", typed.stored, at(12));
  if ("refused" in edited) throw new Error(edited.refused);

  expect(edited.settings.quiet_ms!.value).toBe(900000);
  expect(quiet(edited)).toMatchObject({ value: "15", set: true });
  const reset = editSetting(edited, "quiet_ms", "", at(13));
  if ("refused" in reset) throw new Error(reset.refused);
  expect(quiet(reset)).toMatchObject({ value: "", fallback: "10", set: false });
});

test("a Machine's GitLab host and a value its setting refuses are not the Flock's", () => {
  const { flock } = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    set("gitlab_host", "gitlab.elsewhere.com", 9),
    set("scope", "everywhere", 9),
    set("model", "sonnet", 9),
  ]);
  expect(Object.keys(flock.settings)).toEqual(["model"]);
});

/** A Machine's host as Collie's answers: each key written only where the given edit is later. */
const machine = (name: string, held: ReadonlyArray<SharedSetting>, meanwhile = Effect.void) => {
  const asked: Array<ReadonlyArray<SharedSetting>> = [];
  let has = [...held];
  const answer = (): SharedSettings => ({ settings: has, flock: null });
  const door = {
    settings: () => meanwhile.pipe(Effect.map(answer)),
    setSettings: ({ settings }: { settings: ReadonlyArray<SharedSetting> }) =>
      Effect.sync(() => {
        asked.push(settings);
        for (const given of settings) {
          const own = has.find(({ key }) => key === given.key);
          if (own === undefined || own.at < given.at)
            has = [...has.filter(({ key }) => key !== given.key), given];
        }
        return answer();
      }),
  };
  return { name, door, asked };
};

const syncer = (flock: SubscriptionRef.SubscriptionRef<FlockSettings>, ...machines: Machine[]) =>
  syncerTelling(flock, () => Effect.void, ...machines);

const syncerTelling = (
  flock: SubscriptionRef.SubscriptionRef<FlockSettings>,
  told: (machine: Machine, failed: string | null) => Effect.Effect<void>,
  ...machines: Machine[]
) =>
  flockSync({
    flock,
    machines: () => machines,
    save: () => Effect.void,
    request: Effect.succeed("r"),
    told,
  });

type Machine = ReturnType<typeof machine>;

test("a Machine is synced through its host: given what it lacks, and asked even with nothing to give", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const edited = editSetting(NO_FLOCK_SETTINGS, "scope", "all", at(12));
      if ("refused" in edited) return yield* Effect.die(edited.refused);
      const flock = yield* SubscriptionRef.make(edited);
      const vmA = machine("vm-a", [set("model", "sonnet", 9)]);
      const { syncOn } = yield* syncer(flock, vmA);

      yield* syncOn(vmA);
      expect(vmA.asked).toEqual([[set("scope", "all", 12)]]);
      expect(Object.keys((yield* SubscriptionRef.get(flock)).settings).sort()).toEqual([
        "model",
        "scope",
      ]);
      // Nothing left to give, yet asked, so the Machine records that a Desktop shares them.
      yield* syncOn(vmA);
      expect(vmA.asked).toEqual([[set("scope", "all", 12)], []]);
    }),
  ));

test("an edit made in Desktop during a sync survives it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
      const editing = SubscriptionRef.update(flock, (now) => {
        const edited = editSetting(now, "max_iterations", "8", at(14));
        return "refused" in edited ? now : edited;
      });
      const vmA = machine("vm-a", [set("model", "sonnet", 9)], editing);
      const { syncOn } = yield* syncer(flock, vmA);

      yield* syncOn(vmA);
      const after = yield* SubscriptionRef.get(flock);
      expect(after.settings.max_iterations).toMatchObject({ value: 8, from: "Desktop" });
      expect(after.settings.model).toMatchObject({ value: "sonnet", from: "vm-a" });
    }),
  ));

test("an edit taken from one Machine goes on to every other connected Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
      const vmA = machine("vm-a", []);
      const vmB = machine("vm-b", []);
      const { syncOn, syncEvery } = yield* syncer(flock, vmA, vmB);
      yield* syncEvery();

      // Edited in vm-a's TUI.
      yield* vmA.door.setSettings({ settings: [set("model", "haiku", 15)] });
      yield* syncOn(vmA);
      expect(vmB.asked.at(-1)).toEqual([set("model", "haiku", 15)]);
    }),
  ));

test("each sync tells how it ended for its Machine: synced, or failed in its host's words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
      const told: Array<readonly [string, string | null]> = [];
      const vmA = machine("vm-a", []);
      // A host that refuses, as one on a collie without the operation does.
      const vmB = machine("vm-b", [], Effect.die(new HostRefused({ reason: "no such operation" })));
      const { syncOn } = yield* syncerTelling(
        flock,
        (one, failed) => Effect.sync(() => void told.push([one.name, failed])),
        vmA,
        vmB,
      );

      expect(yield* syncOn(vmA)).toBeNull();
      expect(yield* syncOn(vmB)).toBe("no such operation");
      expect(told).toEqual([
        ["vm-a", null],
        ["vm-b", "no such operation"],
      ]);
    }),
  ));

test("the Machine rule is kept on this computer with Desktop's own settings, and a file from before it still reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      const rule = "Frontend work is on the laptop, everything else is on the vm";
      yield* writeSettings(dir, { proactive: false, machineRule: rule });
      // As a restarted Desktop reads it.
      expect(yield* readSettings(dir)).toEqual({ proactive: false, machineRule: rule });

      yield* fs.writeFileString(`${dir}/settings.json`, '{"proactive":true}');
      expect((yield* readSettings(dir)).machineRule).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("Zoom is this computer's, under Board, 100% until set, and kept as a number", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const zoom = (zoom?: number) =>
        settingSections(NO_FLOCK_SETTINGS, { proactive: true, ...(zoom && { zoom }) })
          .find((section) => section.group === "Board")!
          .rows.find((row) => row.key === "zoom")!;
      expect(zoom()).toMatchObject({
        kind: "choice",
        choices: ["80%", "90%", "100%", "110%", "125%", "150%"],
        value: "100%",
        fallback: "100%",
        set: false,
        shared: false,
        defaultSaid: "Default: 100%, the size of your other apps",
      });
      expect(zoom(1.25)).toMatchObject({ value: "125%", set: true });
      expect(desktopChange("zoom", "125%")).toEqual({ zoom: 1.25 });
      expect(desktopChange("zoom", "")).toEqual({ zoom: 1 });
      expect(desktopChange("proactive", "false")).toEqual({ proactive: false });
      expect(desktopChange("machineRule", " vm for all ")).toEqual({ machineRule: "vm for all" });

      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      yield* writeSettings(dir, { proactive: true, zoom: 0.9 });
      expect((yield* readSettings(dir)).zoom).toBe(0.9);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("the Flock chat's model is checked as a Run's is, with the Flock's extra models, and a refusal keeps nothing", () => {
  const before = { proactive: true, chatModel: "sonnet" };
  const refused = changeSettings(before, NO_FLOCK_SETTINGS, { chatModel: "gpt-6.1-sol" });
  expect(refused).toEqual({
    refused: expect.stringContaining('"gpt-6.1-sol" is not a model claude takes'),
  });
  expect("refused" in refused && refused.refused).toContain("opus, sonnet");
  expect(changeSettings(before, NO_FLOCK_SETTINGS, { chatModel: "haiku" })).toEqual({
    proactive: true,
    chatModel: "haiku",
  });
  const extra = takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    set("models.claude", ["proxy-large"], 9),
  ]).flock;
  expect(changeSettings(before, extra, { chatModel: "proxy-large" })).toMatchObject({
    chatModel: "proxy-large",
  });
  expect(changeSettings(before, NO_FLOCK_SETTINGS, { chatModel: "" })).toEqual({ proactive: true });
  expect(changeSettings(before, NO_FLOCK_SETTINGS, { chatHarness: "opencode" })).toEqual({
    refused: expect.stringContaining('"opencode"'),
  });
  expect(
    changeSettings({ proactive: true, chatModel: "gone" }, NO_FLOCK_SETTINGS, { proactive: false }),
  ).toEqual({ proactive: false, chatModel: "gone" });
});

test("choosing another harness for the Flock chat clears its model, and the same harness keeps it", () => {
  const before = { proactive: true, chatHarness: "claude", chatModel: "sonnet" };
  expect(applyChange(before, { chatHarness: "pi" })).toEqual({
    proactive: true,
    chatHarness: "pi",
  });
  expect(applyChange(before, { chatHarness: "claude" })).toEqual(before);
  expect(applyChange(before, { chatHarness: "pi", chatModel: "openai-codex/gpt-6.1-sol" })).toEqual(
    { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-6.1-sol" },
  );
  expect(applyChange({ proactive: true, chatModel: "sonnet" }, { chatHarness: "claude" })).toEqual({
    proactive: true,
    chatHarness: "claude",
    chatModel: "sonnet",
  });
});

test("the Flock chat's harness and model are kept on this computer, and a file from before them still reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      yield* writeSettings(dir, { proactive: true, chatHarness: "claude", chatModel: "sonnet" });
      expect(yield* readSettings(dir)).toEqual({
        proactive: true,
        chatHarness: "claude",
        chatModel: "sonnet",
      });
      yield* fs.writeFileString(`${dir}/settings.json`, '{"proactive":true,"machineRule":"vm"}');
      expect(yield* readSettings(dir)).toEqual({ proactive: true, machineRule: "vm" });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("Pi is offered for the Flock chat and checks a provider-qualified model", () => {
  expect(
    changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, {
      chatHarness: "pi",
      chatModel: "openai-codex/gpt-6.1-sol",
    }),
  ).toEqual({ proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-6.1-sol" });
  expect(
    changeSettings({ proactive: true, chatHarness: "pi" }, NO_FLOCK_SETTINGS, {
      chatModel: "gpt-6.1-sol",
    }),
  ).toEqual({ refused: expect.stringContaining("provider/model") });
});
