import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Config, Console, Data, Effect, FileSystem } from "effect";

export const GOLDEN = new URL("../test/fixtures/plain-ticket-build.prompt.txt", import.meta.url)
  .pathname;
export const REGENERATE = "bun run tools/prompt-golden.ts --write";
export const SCENARIO = "a plan chained into implement writes a speed-up";
const WRITE = "COLLIE_WRITE_GOLDEN";

export class Drift extends Data.TaggedError("Drift")<{
  readonly path: string;
  readonly line: number;
  readonly golden: string;
  readonly rendered: string;
}> {
  override get message() {
    return Arr.join(
      [
        `${this.path} differs from the rendered plain-ticket build prompt at line ${this.line}:`,
        `  golden:   ${this.golden}`,
        `  rendered: ${this.rendered}`,
        `Run \`${REGENERATE}\` if the prompt changed on purpose.`,
      ],
      "\n",
    );
  }
}

export const drift = (rendered: string, golden: string) => {
  if (rendered === golden) return Option.none();
  const ours = Str.split(rendered, "\n");
  const theirs = Str.split(golden, "\n");
  const at = Option.getOrElse(
    Arr.findFirstIndex(
      Arr.range(0, Math.max(ours.length, theirs.length)),
      (i) => ours[i] !== theirs[i],
    ),
    () => 0,
  );
  return Option.some(
    new Drift({
      path: GOLDEN,
      line: at + 1,
      golden: theirs[at] ?? "<end of file>",
      rendered: ours[at] ?? "<end of file>",
    }),
  );
};

export const matchGolden = Effect.fn("PromptGolden.match")(function* (rendered: string) {
  const fs = yield* FileSystem.FileSystem;
  if ((yield* Config.String(WRITE).pipe(Config.withDefault(""))) === "1")
    return yield* fs.writeFileString(GOLDEN, rendered);
  const found = drift(rendered, yield* fs.readFileString(GOLDEN));
  if (Option.isSome(found)) return yield* found.value;
});

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const mode = Bun.argv[2];
      if (mode !== "--write" && mode !== "--check") {
        yield* Console.error("usage: bun run tools/prompt-golden.ts --write | --check");
        return 2;
      }
      const child = Bun.spawn(["bun", "run", "scenario", SCENARIO], {
        stdio: ["inherit", "inherit", "inherit"],
        env: { ...process.env, [WRITE]: mode === "--write" ? "1" : "" },
      });
      return yield* Effect.promise(() => child.exited);
    }).pipe(Effect.flatMap((code) => Effect.sync(() => process.exit(code)))),
  );
