import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Config, Console, Effect } from "effect";

const args = Bun.argv.slice(2);

const compactionProgram = Effect.gen(function* () {
  const dir = args[2] ?? "";
  const [stdin, { recordClaudeEvent }] = yield* Effect.promise(() =>
    Promise.all([Bun.stdin.text(), import("./compactors")]),
  );
  const line = yield* recordClaudeEvent(dir, stdin).pipe(Effect.orElseSucceed(() => ""));
  if (line !== "") yield* Console.log(line);
});

const started = Config.String("COLLIE_TEST_STARTS").pipe(
  Config.withDefault(""),
  Effect.flatMap((file) =>
    file === ""
      ? Effect.void
      : Effect.promise(() => import("./starts")).pipe(
          Effect.flatMap(({ recordStart }) => recordStart("collie", args)),
        ),
  ),
  Effect.ignore,
);

const cliProgram = Effect.promise(() => import("./collie")).pipe(
  Effect.flatMap(({ program }) => program),
);

const chosen = args[0] === "herdr" && args[1] === "compaction" ? compactionProgram : cliProgram;

if (args[0] === "supervise-check") {
  const [{ supervise }, { platformLayer }] = await Promise.all([
    import("./check-supervisor"),
    import("./platform"),
  ]);
  await Effect.runPromise(supervise(args.slice(1)).pipe(Effect.provide(platformLayer)));
} else {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(1);
    });
  }
  BunRuntime.runMain(
    Effect.promise(() => import("./platform")).pipe(
      Effect.flatMap(({ platformLayer }) =>
        started.pipe(Effect.andThen(chosen), Effect.provide(platformLayer)),
      ),
    ),
    { disableErrorReporting: true },
  );
}
