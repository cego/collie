// `bun run scenario "<pattern>"`: runs the baseline scenarios whose names match the pattern, as
// `-t` matches it, through `bun run test` with only the shard files that hold them.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { scenarioNames, SHARES, split } from "../test/support/baseline";

const two = (share: number) => pipe_(String(share), Str.padStart(2, "0"));

export const scenarioFiles = (names: ReadonlyArray<string>, pattern: string) => {
  const matches = new RegExp(pattern);
  const shares = split(names, SHARES);
  const holding = (fullName: (name: string) => string) =>
    Arr.flatMap(shares, (share, at) =>
      Arr.some(share, (name) => matches.test(fullName(name))) ? [at] : [],
    );
  return [
    ...Arr.map(
      holding((name) => name),
      (at) => `test/baseline-${two(at)}.test.ts`,
    ),
    ...Arr.map(
      holding((name) => `${name} (under an unrelated id)`),
      (at) => `test/baseline-unrelated-${two(at)}.test.ts`,
    ),
  ];
};

export const scenarioArgs = (pattern: string, files: ReadonlyArray<string>) => [
  "-t",
  pattern,
  `--parallel=${files.length}`,
  ...files,
];

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const pattern = Bun.argv[2];
      if (pattern === undefined) {
        yield* Console.error('usage: bun run scenario "<pattern>"');
        return 2;
      }
      const files = scenarioFiles(scenarioNames(), pattern);
      if (files.length === 0) {
        yield* Console.error(`scenario: no baseline scenario matches "${pattern}"`);
        return 1;
      }
      yield* Console.error(`scenario: ${Arr.join(files, " ")}`);
      const child = Bun.spawn(["bun", "run", "tools/test.ts", ...scenarioArgs(pattern, files)], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      return yield* Effect.promise(() => child.exited);
    }).pipe(Effect.flatMap((code) => Effect.sync(() => process.exit(code)))),
  );
