import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Config, Console, Effect } from "effect";
import { SUPERVISE } from "./check-supervisor";

/**
 * The front doors share one entry point, and each imports only what it runs: a start
 * is mostly loading modules, and the compaction helper is started for every status
 * line and every prompt a Claude agent submits. `Bun.argv` rather than Stdio's `args`
 * only here: this choice is made before any Effect runs, because it decides which
 * program to hand to BunRuntime — and `program` itself reads its arguments through
 * Stdio, as Command.run does.
 */
const args = Bun.argv.slice(2);

/**
 * The helper a harness's own status line or hook is pointed at: the payload arrives on
 * stdin and one agent's telemetry comes out. Outside the CLI because it runs inside a
 * harness on every prompt: there is no session to resolve, and failing to find one must
 * not break the human's status line.
 */
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

// `program`, not `app`: the handler around it is what turns a parse failure into one
// JSON envelope and exit 2, and running `app` bare bypassed it entirely.
const cliProgram = Effect.promise(() => import("./collie")).pipe(
  Effect.flatMap(({ program }) => program),
);

const chosen = args[0] === "herdr" && args[1] === "compaction" ? compactionProgram : cliProgram;

if (args[0] === SUPERVISE) {
  // A check's supervisor outlives the host reading its output, so a closed pipe does not end it.
  const [{ supervise }, { platformLayer }] = await Promise.all([
    import("./check-supervisor"),
    import("./platform"),
  ]);
  await Effect.runPromise(supervise(args.slice(1)).pipe(Effect.provide(platformLayer)));
} else {
  // Whoever spawned this process and has since gone is the only one who could have read
  // its output, so nothing is lost by stopping. Without this, the first write after the
  // peer closed fails and every later one waits for a `drain` that never comes — the
  // error reporter's own attempt to say so included — and the process stays behind idle.
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
