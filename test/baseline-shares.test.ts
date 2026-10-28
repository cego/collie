import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { scenarioNames, SHARES, split } from "./support/baseline";
import { requestOf } from "../tools/test-run";
import { scenarioArgs, scenarioFiles } from "../tools/scenario";

test("every baseline scenario is in exactly one share, and a pass's shares are all of them", () => {
  const names = scenarioNames();
  const shares = split(names, SHARES);
  expect(shares).toHaveLength(SHARES);
  expect(shares.flat().toSorted()).toEqual(names.toSorted());
});

test("a scenario added under a new name moves no other between shares", () => {
  const names = scenarioNames();
  const added = "a scenario nobody has written yet";
  const before = split(names, SHARES);
  const after = split([added, ...names], SHARES);
  expect(after.flat()).toContain(added);
  expect(after.map((share) => share.filter((name) => name !== added))).toEqual(before);
});

// crc32 puts alpha in share 10, beta in 7, gamma in 5.
const names = ["alpha", "beta", "gamma"];

test("a pattern naming one scenario yields its shipped and unrelated shard files", () => {
  expect(scenarioFiles(names, "beta")).toEqual([
    "test/baseline-07.test.ts",
    "test/baseline-unrelated-07.test.ts",
  ]);
});

test("a pattern matching scenarios in two shares yields all four files", () => {
  expect(scenarioFiles(names, "alpha|gamma")).toEqual([
    "test/baseline-05.test.ts",
    "test/baseline-10.test.ts",
    "test/baseline-unrelated-05.test.ts",
    "test/baseline-unrelated-10.test.ts",
  ]);
});

test("a pattern matches each pass's full test names, as -t does", () => {
  expect(scenarioFiles(names, "^beta$")).toEqual(["test/baseline-07.test.ts"]);
  expect(scenarioFiles(names, "beta \\(under an unrelated id\\)")).toEqual([
    "test/baseline-unrelated-07.test.ts",
  ]);
});

test("a pattern matching no scenario yields no files", () => {
  expect(scenarioFiles(names, "delta")).toEqual([]);
});

test("a scenario run asks the budget for one worker per file", () => {
  const files = scenarioFiles(names, "alpha|gamma");
  const args = scenarioArgs("alpha|gamma", files);
  expect(args).toEqual(expect.arrayContaining(["-t", "alpha|gamma", ...files]));
  expect(requestOf(args, { total: 12, reserve: 6 }, true).asked).toBe(4);
});

test("every scenario resolves to the file whose register call runs it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const all = scenarioNames();
      const shares = split(all, SHARES);
      let registered = 0;
      for (const file of new Bun.Glob("test/baseline-*.test.ts").scanSync()) {
        const call = (yield* fs.readFileString(file)).match(
          /register\("(shipped|unrelated)", (\d+)\)/,
        );
        if (call === null) continue;
        registered++;
        for (const name of shares[Number(call[2])]!) {
          const full = call[1] === "unrelated" ? `${name} (under an unrelated id)` : name;
          expect(scenarioFiles(all, `^${RegExp.escape(full)}$`)).toEqual([file]);
        }
      }
      expect(registered).toBe(2 * SHARES);
    }),
  ));
