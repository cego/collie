// The live probe's verdict is only as good as how it reads a reviewer's findings against
// the fixture's key: these pin that reading, so the probe can be trusted when it is red.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { readEnv } from "../src/env";
import { journal, outsideAnyRun, readKey, scored, type KeyItem } from "../tools/tautology-probe";
import { runEffect } from "./support/effect";

const restated: KeyItem = {
  id: "test-restates",
  kind: "test that restates the implementation",
  tautology: true,
  file: "repo/test/duration.test.ts",
  lines: [10, 14],
};
const honest: KeyItem = {
  id: "honest-test",
  kind: "honest test",
  tautology: false,
  file: "repo/test/duration.test.ts",
  lines: [20, 24],
};
const key = [restated, honest];

test("a finding on a Tautology's lines counts it raised", () => {
  const run = [{ file: "test/duration.test.ts", line: 12 }];
  expect(scored([run, run, run], key)).toEqual({ missed: [], falselyRaised: [] });
});

test("a finding on an honest item's lines is a false raise", () => {
  const run = [
    { file: "test/duration.test.ts", line: 11 },
    { file: "test/duration.test.ts", line: 20 },
  ];
  expect(scored([run, run, run], key)).toEqual({ missed: [], falselyRaised: [honest] });
});

test("a finding on another file or another line counts for neither", () => {
  const run = [
    { file: "test/timeout.test.ts", line: 12 },
    { file: "test/duration.test.ts", line: 17 },
    { file: "test/duration.test.ts" },
    { line: 21 },
  ];
  expect(scored([run, run, run], key)).toEqual({ missed: [restated], falselyRaised: [] });
});

test("an item raised in one run out of three is not raised", () => {
  const raisedBoth = [
    { file: "test/duration.test.ts", line: 12 },
    { file: "test/duration.test.ts", line: 22 },
  ];
  expect(scored([raisedBoth, [], []], key)).toEqual({ missed: [restated], falselyRaised: [] });
});

test("a reviewer's environment names no herdr pane, tab or workspace", () => {
  const env = readEnv(
    outsideAnyRun({
      HERDR_PANE_ID: "p",
      HERDR_ACTIVE_PANE_ID: "p",
      HERDR_TAB_ID: "t",
      HERDR_ACTIVE_TAB_ID: "t",
      HERDR_WORKSPACE_ID: "w",
      HERDR_ACTIVE_WORKSPACE_ID: "w",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w",
        tab_id: "t",
        focused_pane_id: "p",
      }),
    }),
  );
  expect([env.paneId, env.tabId, env.workspaceId]).toEqual([null, null, null]);
});

test("each honest test in the fixture has a check seen failing on an earlier tree", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = new URL("../tools/tautology-fixture/", import.meta.url).pathname;
      const key = readKey(yield* fs.readFileString(`${fixture}key.json`));
      const checks = Str.split(
        journal(
          yield* fs.readFileString(`${fixture}journal.json`),
          "/repo",
          { head: "final", base: "base" },
          "2026-10-21T00:00:00Z",
        ),
        "\n",
      );
      const honestTests = Arr.map(
        Arr.filter(key, (item) => item.kind === "honest test"),
        (item) => item.id,
      );
      expect(honestTests).toHaveLength(4);
      for (const id of honestTests)
        expect(
          Option.getOrUndefined(
            Arr.findFirst(checks, (line) => pipe(line, Str.startsWith(`- ${id}: pass`))),
          ),
        ).toEndWith("on this tree, at 2026-10-21T00:00:00Z; seen failing on an earlier tree");
    }),
  ));
