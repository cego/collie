// `bun run scenario "<pattern>"`: runs the baseline scenarios whose names match the pattern, as
// `-t` matches it, through `bun run test` with only the shard files that hold them.

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { scenarioNames, SHARES, split } from "../test/support/baseline";

const two = (share: number) => String(share).padStart(2, "0");

export const scenarioFiles = (names: ReadonlyArray<string>, pattern: string) => {
  const matches = new RegExp(pattern);
  const shares = split(names, SHARES);
  const holding = (fullName: (name: string) => string) =>
    shares.flatMap((share, at) => (share.some((name) => matches.test(fullName(name))) ? [at] : []));
  return [
    ...holding((name) => name).map((at) => `test/baseline-${two(at)}.test.ts`),
    ...holding((name) => `${name} (under an unrelated id)`).map(
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
      yield* Console.error(`scenario: ${files.join(" ")}`);
      const child = Bun.spawn(["bun", "run", "tools/test.ts", ...scenarioArgs(pattern, files)], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      return yield* Effect.promise(() => child.exited);
    }).pipe(Effect.flatMap((code) => Effect.sync(() => process.exit(code)))),
  );
