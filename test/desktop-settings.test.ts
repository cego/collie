// The Flock's settings as Desktop keeps them: each key decided by its latest edit, wherever
// that was made, and given to every Machine through its host.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import type { SharedSetting, SharedSettings } from "../src/board-model";
import {
  editSetting,
  NO_FLOCK_SETTINGS,
  settingRows,
  takeFrom,
} from "../desktop/src/shared/flock-settings";
import { syncSettings } from "../desktop/src/bun/flock-settings";
import { readSettings, writeSettings } from "../desktop/src/bun/settings";

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
  ]).flock;
  const rows = settingRows(takeFrom(flock, "vm-b", [set("scope", "local", 11)]).flock);

  expect(rows.find((row) => row.key === "scope")).toMatchObject({
    kind: "choice",
    choices: ["local", "all"],
    value: "local",
    fallback: "local",
    from: "vm-b",
  });
  expect(rows.find((row) => row.key === "max_iterations")).toMatchObject({
    kind: "number",
    value: "",
    fallback: "5",
    from: null,
  });
  expect(rows.find((row) => row.key === "models.claude")).toMatchObject({ value: "claude-x" });
  expect(rows.find((row) => row.key === "proactive")).toMatchObject({ kind: "boolean" });
  // The GitLab host is shared too, but beside the tokens made for it.
  expect(rows.map((row) => row.key)).not.toContain("gitlab_host");
});

test("a Machine is synced through its host: read, then given only what it lacks", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Array<ReadonlyArray<SharedSetting>> = [];
      let held: SharedSettings = { settings: [set("model", "sonnet", 9)], flock: null };
      const door = {
        settings: () => Effect.succeed(held),
        setSettings: ({ settings }: { settings: ReadonlyArray<SharedSetting> }) =>
          Effect.sync(() => {
            asked.push(settings);
            held = { settings: [...held.settings, ...settings], flock: { by: "pc", at: at(13) } };
            return held;
          }),
      };
      const flock = editSetting(NO_FLOCK_SETTINGS, "scope", "all", at(12));
      if ("refused" in flock) return yield* Effect.die(flock.refused);

      const has = yield* syncSettings(flock, "vm-a", door, "r-1");

      expect(asked).toEqual([[set("scope", "all", 12)]]);
      const after = takeFrom(flock, "vm-a", has).flock;
      expect(Object.keys(after.settings).sort()).toEqual(["model", "scope"]);
      // Nothing left to give, so a second sync asks nothing of the host.
      yield* syncSettings(after, "vm-a", door, "r-2");
      expect(asked).toHaveLength(1);
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
