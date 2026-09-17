// The line under the chat prompt, and how it gets there. Two things matter: a human's own
// Claude Code settings survive being configured, and a status line somebody else put there
// is reported rather than replaced — it is their editor, and Collie is a guest in it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { readEnv, type PluginEnv } from "../src/env";
import {
  claudeSettingsPath,
  installStatusLine,
  readStatusLine,
  STATUS_LINE_ARGS,
  statusLineFor,
} from "../src/statusline";
import { selectionPath, writeSelection } from "../src/selection";
import { herdOf } from "../src/steering";

let home: string;
let env: PluginEnv;

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      home = yield* fs.makeTempDirectory({ prefix: "collie-statusline-" });
      env = readEnv({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: `${home}/.claude` });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(home, { recursive: true, force: true }),
    ),
  ),
);

test("configuring the status line keeps every other setting the human has", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* claudeSettingsPath(env);
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      yield* fs.writeFileString(file, `{"theirs": "kept", "model": "opus"}\n`);

      expect(yield* readStatusLine(env)).toEqual({ kind: "none" });

      const said = yield* installStatusLine(env);

      expect(said).toContain("status line");
      const after = yield* read(file);
      expect(after).toContain(`"theirs": "kept"`);
      expect(after).toContain(STATUS_LINE_ARGS.join(" "));
      expect(yield* readStatusLine(env)).toMatchObject({ kind: "ours" });
    }),
  ));

test("a status line somebody else put there is left alone and said out loud", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* claudeSettingsPath(env);
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      const before = `{"statusLine":{"type":"command","command":"my-own-line"}}\n`;
      yield* fs.writeFileString(file, before);

      expect(yield* readStatusLine(env)).toEqual({ kind: "theirs", command: "my-own-line" });

      const said = yield* installStatusLine(env);

      expect(yield* read(file)).toBe(before);
      expect(said).toContain("my-own-line");
    }),
  ));

test("with no settings file at all, one is written that says only what Collie needs", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* claudeSettingsPath(env);

      yield* installStatusLine(env);

      expect(yield* read(file)).toContain(STATUS_LINE_ARGS.join(" "));
      // Run again: the same machine, and nothing said twice.
      expect(yield* installStatusLine(env)).toContain("already");
    }),
  ));

test("the line says what the board has selected, and says nothing outside a Herd", () =>
  runEffect(
    Effect.gen(function* () {
      const herded = readEnv({
        ...process.env,
        HOME: home,
        HERDR_PLUGIN_STATE_DIR: `${home}/state`,
        HERDR_SOCKET_PATH: `${home}/herd.sock`,
      });

      expect(yield* statusLineFor(herded)).toBe("board selection: none · whole herd");

      const key = yield* herdOf(herded.socketPath);
      yield* writeSelection(yield* selectionPath(herded.stateDir, key), {
        task: "t1",
        run: "r1",
        name: "Strapi prod seeder",
      });

      expect(yield* statusLineFor(herded)).toBe("board selection: Strapi prod seeder");

      // No herdr, no board: a Claude Code the human opened somewhere else must not have
      // Collie's words about a board it is nowhere near printed under its prompt.
      const alone = readEnv({ ...process.env, HOME: home, HERDR_SOCKET_PATH: "" });
      expect(yield* statusLineFor(alone)).toBe("");
    }),
  ));

test("settings Collie cannot read are refused rather than replaced", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* claudeSettingsPath(env);
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      // Half-edited by hand, which is a file with everything in it rather than an empty
      // one: writing over it would take the human's own Claude Code settings with it.
      const broken = `{"theirs": "kept",\n`;
      yield* fs.writeFileString(file, broken);

      const said = yield* installStatusLine(env);

      expect(yield* read(file)).toBe(broken);
      expect(said).toContain("could not read");
      expect(said).toContain(file);
    }),
  ));
