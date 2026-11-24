import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Config, Console, Effect, Option } from "effect";

// WARNING: Bun.argv, not Stdio's args: this choice is made before any Effect runs.
const args = Bun.argv.slice(2);

// WARNING: Runs inside a harness on every prompt: failing to find a session must not break its status line.
const compactionProgram = Effect.gen(function* () {
  const dir = args[2] ?? "";
  const [stdin, { recordClaudeEvent }] = yield* Effect.promise(() =>
    Promise.all([Bun.stdin.text(), import("./compactors")]),
  );
  const incarnation = Option.getOrNull(yield* Config.option(Config.String("HC_TERMINAL_ID")));
  const line = yield* recordClaudeEvent(dir, stdin, incarnation).pipe(
    Effect.orElseSucceed(() => ""),
  );
  if (line !== "") {
    yield* Console.log(line);
  }
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

// WARNING: Run `program`, not `app`: only its handler turns a parse failure into exit 2.
const cliProgram = Effect.promise(() => import("./collie")).pipe(
  Effect.flatMap(({ program }) => program),
);

const chosen = args[0] === "herdr" && args[1] === "compaction" ? compactionProgram : cliProgram;

// WARNING: Written out here so this file loads no Collie module.
if (args[0] === "supervise-check") {
  // WARNING: A check's supervisor outlives its reader, so a closed pipe must not end it.
  const [{ supervise }, { platformLayer }] = await Promise.all([
    import("./check-supervisor"),
    import("./platform"),
  ]);
  await Effect.runPromise(supervise(args.slice(1)).pipe(Effect.provide(platformLayer)));
} else {
  // WARNING: After the peer closes, writes must error rather than wait on a drain that never comes.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        process.exit(1);
      }
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
