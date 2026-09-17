// What the board has selected, as the one small record chat reads. Two things must hold:
// the record says the whole of what a tool needs to answer about it without asking the
// board anything, and closing the drawer leaves nothing behind that a later read could
// mistake for a live selection.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import {
  promptLine,
  readSelection,
  selectionLine,
  selectionPath,
  writeSelection,
} from "../src/selection";

let stateDir: string;
const KEY = "herd-key";

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "collie-selection-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(stateDir, { recursive: true, force: true }),
    ),
  ),
);

test("what the board selected is read back whole, and closing it clears it", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* selectionPath(stateDir, KEY);

      expect(yield* readSelection(file)).toBe(null);

      yield* writeSelection(file, { task: "t1", run: "r1", name: "Strapi prod seeder" });

      expect(yield* readSelection(file)).toEqual({
        task: "t1",
        run: "r1",
        name: "Strapi prod seeder",
      });

      yield* writeSelection(file, null);

      expect(yield* readSelection(file)).toBe(null);
    }),
  ));

test("the status line says what is selected, or that nothing narrows the herd", () => {
  expect(selectionLine({ task: "t1", run: "r1", name: "Strapi prod seeder" })).toBe(
    "board selection: Strapi prod seeder",
  );
  expect(selectionLine(null)).toBe("board selection: none · whole herd");
  // Attached to a prompt: names the card and its Run, and is nothing — not a line about
  // nothing — while no card is open.
  expect(promptLine({ task: "t1", run: "r1", name: "Strapi prod seeder" })).toContain(
    '"Strapi prod seeder" is open (run r1)',
  );
  expect(promptLine(null)).toBe("");
});
