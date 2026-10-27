// The Flock's settings as Desktop keeps them: each key decided by its latest edit, wherever
// that was made, and given to every Machine through its host.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, FileSystem, Stream, SubscriptionRef } from "effect";
import { HostRefused, type SharedSetting, type SharedSettings } from "../src/board-model";
import {
  desktopChange,
  editSetting,
  type FlockSettings,
  NO_FLOCK_SETTINGS,
  settingSections,
  takeFrom,
} from "../desktop/src/shared/flock-settings";
import {
  definitionsSync,
  type FlockDefinitions,
  flockSync,
} from "../desktop/src/bun/flock-settings";
import type { SharedDefinition } from "../src/definitions-model";
import { latestEdits } from "../src/flock-settings";
import { settingStored } from "../src/settings";
import {
  applyChange,
  changeSettings,
  heldSettings,
  type Offers,
  readSettings,
  writeSettings,
} from "../desktop/src/bun/settings";

const at = (hour: number) => `2026-10-07T${String(hour).padStart(2, "0")}:00:00.000Z`;
const set = (key: string, value: SharedSetting["value"], hour: number): SharedSetting => ({
  key,
  value,
  at: at(hour),
});

test("the latest edit of each key wins, a removal is an edit, and a tie keeps what is held", () => {
  const held = [
    set("a", "old", 9),
    set("b", "mine", 11),
    set("c", "held", 9),
    set("d", "only mine", 9),
  ];
  const has = [
    set("a", null, 10),
    set("b", "theirs", 10),
    set("c", "other", 9),
    set("e", "theirs", 8),
  ];

  expect(latestEdits(held, has, (one) => one.key)).toEqual({
    take: [set("a", null, 10), set("e", "theirs", 8)],
    give: [set("b", "mine", 11), set("d", "only mine", 9)],
  });
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
  // Text rather than a number, so auto can be typed.
  expect(row("claude_auto_compact_window")).toMatchObject({
    group: "Agents",
    kind: "text",
    value: "",
    fallback: "400000",
    unit: "tokens",
    defaultSaid: "Default: 400000 tokens",
  });
  expect(editSetting(flock, "claude_auto_compact_window", "50000", at(12))).toEqual({
    refused:
      'claude_auto_compact_window has to be a whole number of tokens from 100000 to 1000000, or auto, not "50000"',
  });
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
  expect(
    sections
      .find((section) => section.group === "Chat")!
      .rows.filter((one) => !one.shared)
      .map((one) => one.key),
  ).toEqual(["proactive", "machineRule"]);
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
    set("claude_auto_compact_window", 50000, 9),
  ]);
  expect(Object.keys(flock.settings)).toEqual(["model"]);
});

test("the agent profile is one shared JSON text: an edit is checked, synced as written, and typed over lines", () => {
  const profile = '{"*": {"env": {"TOKEN": {"file": "~/.secrets/token"}}}}';
  const edited = editSetting(NO_FLOCK_SETTINGS, "agent_profile", profile, at(12));
  if ("refused" in edited) throw new Error(edited.refused);
  // Only the file's path is shared; each Machine reads its own file at launch.
  expect(takeFrom(edited, "vm-a", []).give).toEqual([
    { key: "agent_profile", value: profile, at: at(12) },
  ]);
  expect(
    editSetting(
      NO_FLOCK_SETTINGS,
      "agent_profile",
      '{"*": {"claude": {"disableAllHooks": true}}}',
      at(12),
    ),
  ).toEqual({ refused: "*.claude.disableAllHooks would switch off Collie's own hooks" });
  const row = settingSections(edited, { proactive: true })
    .flatMap(({ rows }) => rows)
    .find(({ key }) => key === "agent_profile");
  expect(row).toMatchObject({ value: profile, multiline: true, shared: true });
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

/** A Machine's host as ticket 02's: each path written only where the given edit is later. */
const definer = (name: string, held: ReadonlyArray<SharedDefinition>, refused?: string) => {
  const asked: Array<ReadonlyArray<SharedDefinition>> = [];
  let has = [...held];
  const door = {
    sharedDefinitions: () =>
      refused === undefined
        ? Effect.sync(() => has)
        : Effect.fail(new HostRefused({ reason: refused })),
    setSharedDefinitions: ({ definitions }: { definitions: ReadonlyArray<SharedDefinition> }) =>
      Effect.sync(() => {
        asked.push(definitions);
        for (const given of definitions) {
          const own = has.find(({ path }) => path === given.path);
          if (own === undefined || own.at < given.at)
            has = [...has.filter(({ path }) => path !== given.path), given];
        }
        return has;
      }),
  };
  return { name, door, asked };
};
type Definer = ReturnType<typeof definer>;

const defined = (path: string, base64: string | null, hour: number): SharedDefinition => ({
  path,
  base64,
  at: at(hour),
});

const definitionsSyncer = (
  flock: SubscriptionRef.SubscriptionRef<FlockDefinitions>,
  told: (machine: Definer, failed: string | null) => Effect.Effect<void>,
  ...machines: Definer[]
) =>
  definitionsSync({
    flock,
    machines: () => machines,
    save: () => Effect.void,
    request: Effect.succeed("r"),
    told,
  });

test("a definition taken from one Machine is given to the next connected Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* SubscriptionRef.make<FlockDefinitions>({});
      const plan = defined("workflows/plan.workflow.ts", "export default 1", 10);
      const vmA = definer("vm-a", [plan]);
      const vmB = definer("vm-b", []);
      const { syncOn } = yield* definitionsSyncer(flock, () => Effect.void, vmA, vmB);

      yield* syncOn(vmA);
      expect(vmB.asked).toEqual([[plan]]);
      expect((yield* SubscriptionRef.get(flock))["workflows/plan.workflow.ts"]).toEqual({
        base64: "export default 1",
        at: at(10),
        from: "vm-a",
      });
    }),
  ));

test("a Machine's newer edit of a definition wins over the copy Desktop holds", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const path = "personas/builder.md";
      const flock = yield* SubscriptionRef.make<FlockDefinitions>({
        [path]: { base64: "held", at: at(9), from: "vm-b" },
      });
      const vmA = definer("vm-a", [defined(path, "edited on vm-a", 11)]);
      const { syncOn } = yield* definitionsSyncer(flock, () => Effect.void, vmA);

      yield* syncOn(vmA);
      expect(vmA.asked).toEqual([]);
      expect((yield* SubscriptionRef.get(flock))[path]).toEqual({
        base64: "edited on vm-a",
        at: at(11),
        from: "vm-a",
      });
    }),
  ));

test("a host that refuses the definitions leaves its Machine failed in its words, and the others still sync", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flock = yield* SubscriptionRef.make<FlockDefinitions>({
        "workflows/plan.md": { base64: "plan", at: at(8), from: "Desktop" },
      });
      const told: Array<readonly [string, string | null]> = [];
      const vmA = definer("vm-a", [], "no such operation");
      const vmB = definer("vm-b", []);
      const { syncEvery } = yield* definitionsSyncer(
        flock,
        (one, failed) => Effect.sync(() => void told.push([one.name, failed])),
        vmA,
        vmB,
      );

      yield* syncEvery();
      expect(told.sort()).toEqual([
        ["vm-a", "no such operation"],
        ["vm-b", null],
      ]);
      expect(vmB.asked).toEqual([[defined("workflows/plan.md", "plan", 8)]]);
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

test("the Flock chat's width is kept on this computer beside Zoom, a reset unsets it, and a file from before it reads unset", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      const held = yield* heldSettings(dir, () => NO_FLOCK_SETTINGS);
      yield* held.save({ zoom: 1.25 });
      yield* held.save({ chatWidth: 640 });
      // As a restarted Desktop reads it.
      expect(yield* readSettings(dir)).toEqual({ proactive: true, zoom: 1.25, chatWidth: 640 });

      yield* held.save({ chatWidth: null });
      expect(yield* readSettings(dir)).toEqual({ proactive: true, zoom: 1.25 });

      yield* fs.writeFileString(`${dir}/settings.json`, '{"proactive":true}');
      expect((yield* readSettings(dir)).chatWidth).toBeUndefined();
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

test("the Flock chat's effort is kept beside its harness and model, an empty one unsets it, and a file from before it reads unset", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      yield* writeSettings(dir, { proactive: true, chatHarness: "claude", chatEffort: "high" });
      expect(yield* readSettings(dir)).toEqual({
        proactive: true,
        chatHarness: "claude",
        chatEffort: "high",
      });
      yield* fs.writeFileString(`${dir}/settings.json`, '{"proactive":true,"chatModel":"sonnet"}');
      expect(yield* readSettings(dir)).toEqual({ proactive: true, chatModel: "sonnet" });
      expect(
        changeSettings({ proactive: true, chatEffort: "high" }, NO_FLOCK_SETTINGS, {
          chatEffort: "",
        }),
      ).toEqual({ proactive: true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

test("another harness unsets the chat's model and effort unless the change sets them, and another model keeps the effort", () => {
  const before = {
    proactive: true,
    chatHarness: "claude",
    chatModel: "sonnet",
    chatEffort: "high",
  };
  expect(changeSettings(before, NO_FLOCK_SETTINGS, { chatHarness: "pi" })).toEqual({
    proactive: true,
    chatHarness: "pi",
  });
  expect(
    changeSettings(before, NO_FLOCK_SETTINGS, { chatHarness: "pi", chatEffort: "off" }),
  ).toEqual({ proactive: true, chatHarness: "pi", chatEffort: "off" });
  expect(changeSettings(before, NO_FLOCK_SETTINGS, { chatModel: "haiku" })).toEqual({
    ...before,
    chatModel: "haiku",
  });
});

test("an effort the chat's harness does not take is refused with the ones it takes", () => {
  const onPi = { proactive: true, chatHarness: "pi", chatEffort: "off" };
  expect(
    changeSettings(onPi, NO_FLOCK_SETTINGS, { chatHarness: "claude", chatEffort: "off" }),
  ).toEqual({ refused: '"off" is not an effort claude takes (low, medium, high, xhigh, max)' });
});

test("a change of only the chat's effort is checked too", () => {
  expect(changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, { chatEffort: "off" })).toEqual({
    refused: '"off" is not an effort claude takes (low, medium, high, xhigh, max)',
  });
  expect(changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, { chatEffort: "max" })).toEqual({
    proactive: true,
    chatEffort: "max",
  });
});

test("Desktop's settings are saved through the check in one place and told to every window, and a refused change tells nothing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      yield* writeSettings(dir, { proactive: true, chatModel: "sonnet" });
      const held = yield* heldSettings(dir, () => NO_FLOCK_SETTINGS);
      const told = yield* held.changes.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;

      // As collie_chat_harness saves a change.
      expect(yield* held.save({ chatHarness: "pi", chatEffort: "off" })).toEqual({
        proactive: true,
        chatHarness: "pi",
        chatEffort: "off",
      });
      const refused = yield* Effect.flip(held.save({ chatHarness: "claude", chatEffort: "off" }));
      expect(refused.reason).toBe(
        '"off" is not an effort claude takes (low, medium, high, xhigh, max)',
      );
      yield* held.save({ proactive: false });

      expect(yield* Fiber.join(told)).toEqual([
        { proactive: true, chatModel: "sonnet" },
        { proactive: true, chatHarness: "pi", chatEffort: "off" },
        { proactive: false, chatHarness: "pi", chatEffort: "off" },
      ]);
      expect(held.now()).toEqual({ proactive: false, chatHarness: "pi", chatEffort: "off" });
      expect(yield* readSettings(dir)).toEqual(held.now());
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

const HAIKU = "claude-haiku-4-5-20251001";
const OFFERS: Offers = {
  claude: {
    from: "table",
    unset: { harness: "claude", model: "opus", effort: "medium" },
    models: [
      {
        id: "opus",
        label: "Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        unsetEffort: "medium",
      },
      {
        id: "sonnet",
        label: "Sonnet 5.5",
        efforts: ["low", "medium", "high"],
        unsetEffort: "medium",
      },
      { id: HAIKU, label: "Haiku 4.5", efforts: [], unsetEffort: null },
    ],
  },
};

test("an effort the chosen model does not list is refused, and any effort on a model that lists none", () => {
  expect(
    changeSettings(
      { proactive: true, chatModel: "sonnet" },
      NO_FLOCK_SETTINGS,
      { chatEffort: "max" },
      OFFERS,
    ),
  ).toEqual({ refused: '"max" is not an effort Sonnet 5.5 takes (low, medium, high)' });
  expect(
    changeSettings(
      { proactive: true },
      NO_FLOCK_SETTINGS,
      { chatModel: "sonnet", chatEffort: "xhigh" },
      OFFERS,
    ),
  ).toEqual({ refused: '"xhigh" is not an effort Sonnet 5.5 takes (low, medium, high)' });
  expect(
    changeSettings(
      { proactive: true, chatModel: HAIKU },
      NO_FLOCK_SETTINGS,
      { chatEffort: "low" },
      OFFERS,
    ),
  ).toEqual({ refused: 'Haiku 4.5 takes no effort, so "low" cannot be asked of it' });
  expect(
    changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, { chatEffort: "max" }, OFFERS),
  ).toEqual({
    proactive: true,
    chatEffort: "max",
  });
});

test("another model keeps the effort only when it lists it, and unsetting the model changes to the one it runs as", () => {
  const at = (chatModel: string, chatEffort: string) => ({
    proactive: true,
    chatModel,
    chatEffort,
  });
  expect(
    changeSettings(at("opus", "high"), NO_FLOCK_SETTINGS, { chatModel: "sonnet" }, OFFERS),
  ).toEqual(at("sonnet", "high"));
  expect(
    changeSettings(at("opus", "max"), NO_FLOCK_SETTINGS, { chatModel: "sonnet" }, OFFERS),
  ).toEqual({
    proactive: true,
    chatModel: "sonnet",
  });
  expect(
    changeSettings(at("sonnet", "low"), NO_FLOCK_SETTINGS, { chatModel: HAIKU }, OFFERS),
  ).toEqual({
    proactive: true,
    chatModel: HAIKU,
  });
  expect(
    changeSettings(at("sonnet", "high"), NO_FLOCK_SETTINGS, { chatModel: "" }, OFFERS),
  ).toEqual({
    proactive: true,
    chatEffort: "high",
  });
  const unsetIsHaiku: Offers = {
    claude: { ...OFFERS.claude!, unset: { harness: "claude", model: HAIKU, effort: null } },
  };
  expect(
    changeSettings(at("sonnet", "high"), NO_FLOCK_SETTINGS, { chatModel: "" }, unsetIsHaiku),
  ).toEqual({
    proactive: true,
  });
});

test("a typed model that is not offered is checked as before, takes the table's efforts, and today's refusals keep their words", () => {
  expect(
    changeSettings(
      { proactive: true },
      NO_FLOCK_SETTINGS,
      { chatModel: "claude-opus-5", chatEffort: "xhigh" },
      OFFERS,
    ),
  ).toEqual({ proactive: true, chatModel: "claude-opus-5", chatEffort: "xhigh" });
  expect(
    changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, { chatModel: "gpt-6.1-sol" }, OFFERS),
  ).toEqual({
    refused: expect.stringContaining('"gpt-6.1-sol" is not a model claude takes'),
  });
  expect(
    changeSettings(
      { proactive: true, chatHarness: "pi" },
      NO_FLOCK_SETTINGS,
      { chatModel: "gpt-6.1-sol" },
      OFFERS,
    ),
  ).toEqual({
    refused: expect.stringContaining("Write provider/model, for example openai-codex/gpt-6.1-sol."),
  });
  expect(
    changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, { chatEffort: "off" }, OFFERS),
  ).toEqual({
    refused: '"off" is not an effort claude takes (low, medium, high, xhigh, max)',
  });
});

test("the default model id checks effort against the model it resolves to", () => {
  const offers: Offers = {
    claude: { ...OFFERS.claude!, unset: { harness: "claude", model: HAIKU, effort: null } },
  };
  expect(
    changeSettings(
      { proactive: true, chatModel: "sonnet", chatEffort: "high" },
      NO_FLOCK_SETTINGS,
      { chatModel: "default" },
      offers,
    ),
  ).toEqual({ proactive: true, chatModel: "default" });
  expect(
    changeSettings(
      { proactive: true, chatModel: "default" },
      NO_FLOCK_SETTINGS,
      { chatEffort: "high" },
      offers,
    ),
  ).toEqual({ refused: 'Haiku 4.5 takes no effort, so "high" cannot be asked of it' });
});

test("a change saved through Desktop's settings is checked against the models offered then", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-settings-" });
      const held = yield* heldSettings(
        dir,
        () => NO_FLOCK_SETTINGS,
        () => Effect.succeed(OFFERS),
      );
      const refused = yield* Effect.flip(held.save({ chatModel: HAIKU, chatEffort: "high" }));
      expect(refused.reason).toBe('Haiku 4.5 takes no effort, so "high" cannot be asked of it');
      yield* held.save({ chatModel: "opus", chatEffort: "max" });
      expect(yield* held.save({ chatModel: "sonnet" })).toEqual({
        proactive: true,
        chatModel: "sonnet",
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));
