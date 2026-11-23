// WARNING: A status line someone else set is reported, never replaced: Collie is a guest in their settings.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { readEnv } from "../src/env";
import type { PluginEnv } from "../src/env";
import {
  claudeSettingsPath,
  installStatusLine,
  readStatusLine,
  STATUS_LINE_ARGS,
  statusLineCommand,
  statusLineFor,
} from "../src/statusline";
import { selectionPath, writeSelection } from "../src/selection";
import { machineHerd } from "../src/steering";

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
      expect(after).toContain(Arr.join(STATUS_LINE_ARGS, " "));
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

      expect(yield* read(file)).toContain(Arr.join(STATUS_LINE_ARGS, " "));
      expect(yield* installStatusLine(env)).toContain("already");
    }),
  ));

test("the line says what the board has selected", () =>
  runEffect(
    Effect.gen(function* () {
      const herded = readEnv({
        ...process.env,
        HOME: home,
        COLLIE_STATE_DIR: `${home}/state`,
        HC_SOCKET: `${home}/herd.sock`,
      });

      expect(yield* statusLineFor(herded)).toBe("board selection: none · whole herd");

      const key = yield* machineHerd(herded);
      yield* writeSelection(yield* selectionPath(herded.stateDir, key), {
        task: "t1",
        run: "r1",
        name: "Strapi prod seeder",
      });

      expect(yield* statusLineFor(herded)).toBe("board selection: Strapi prod seeder");
    }),
  ));

test("settings Collie cannot read are refused rather than replaced", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* claudeSettingsPath(env);
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      // WARNING: A half-edited file is kept whole: writing over it would drop the human's own settings.
      const broken = `{"theirs": "kept",\n`;
      yield* fs.writeFileString(file, broken);

      const said = yield* installStatusLine(env);

      expect(yield* read(file)).toBe(broken);
      expect(said).toContain("could not read");
      expect(said).toContain(file);
    }),
  ));

test("the status line 0.104.0 wrote is Collie's, and is replaced rather than joined", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* claudeSettingsPath(env);
      const written = "'/home/u/.collie/release/bin/collie' chat status-line";
      yield* fs.makeDirectory(`${home}/.claude`, { recursive: true });
      yield* fs.writeFileString(
        file,
        `{\n  "statusLine": {\n    "type": "command",\n    "command": "${written}",\n    "padding": 0\n  }\n}\n`,
      );
      expect(yield* readStatusLine(env)).toEqual({ kind: "ours", command: written });

      yield* installStatusLine(env);

      expect(yield* readStatusLine(env)).toEqual({ kind: "ours", command: statusLineCommand() });
      expect(Option.getOrNull(pipe(yield* read(file), Str.match(/"statusLine"/g)))).toHaveLength(1);
    }),
  ));
