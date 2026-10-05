import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Config, Console, Effect, FileSystem, Path, type PlatformError } from "effect";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";

/**
 * The front doors share one entry point, and each imports only what it runs: a start
 * is mostly loading modules, and the compaction helper is started for every status
 * line and every prompt a Claude agent submits. `Bun.argv` rather than Stdio's `args`
 * only here: this choice is made before any Effect runs, because it decides which
 * program to hand to BunRuntime — and `program` itself reads its arguments through
 * Stdio, as Command.run does.
 */
const args = Bun.argv.slice(2);

// Whoever spawned this process and has since gone is the only one who could have read
// its output, so nothing is lost by stopping. Without this, the first write after the
// peer closed fails and every later one waits for a `drain` that never comes — the
// error reporter's own attempt to say so included — and the process stays behind idle.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(1);
  });
}

type MainError = Error | PlatformError.PlatformError;
type MainServices = BunServices.BunServices | FileSystem.FileSystem | Path.Path;

const herdr: (command: string, mode?: string) => Effect.Effect<void, MainError, MainServices> =
  Effect.fn("main.herdr")(function* (command: string, mode?: string) {
    const [{ currentEnv }, { Herdr }, { boardFlow, openPicker, workspaceFlow }] =
      yield* Effect.promise(() =>
        Promise.all([import("./env"), import("./herdr"), import("./flows")]),
      );
    const env = yield* currentEnv;
    const client = new Herdr(env);
    const configuredMode = yield* Config.option(Config.String("COLLIE_MODE"));
    const selected = mode ?? (configuredMode._tag === "Some" ? configuredMode.value : "pick");
    const code = yield* (() => {
      switch (command) {
        case "pick":
        case "continue":
        case "resume":
        case "fork":
          return openPicker(client, env, command);
        case "picker":
          return popup(client, env, selected);
        case "board":
          return boardFlow(client, env);
        case "workspace":
          return workspaceFlow(client, env);
        default:
          return Console.error(`Unknown Herdr entrypoint "${command}".`).pipe(Effect.as(2));
      }
    })();
    process.exitCode = code;
  });

/**
 * A popup pane: the same components the tab draws, in popup placement. OpenTUI arrives
 * through a dynamic import here for the same reason it does in the tab — the `collie`
 * CLI must neither load the native renderer nor depend on it being there.
 */
const popup = Effect.fn("main.popup")(function* (
  client: Herdr,
  env: PluginEnv,
  mode: string,
): Generator<Effect.Effect<unknown, MainError, MainServices>, number> {
  const [{ runFlow }, { continueFlow, forkFlow, pickFlow, resumeFlow }] = yield* Effect.promise(
    () => Promise.all([import("./ui/bridge"), import("./flows")]),
  );
  return yield* runFlow((prompts) =>
    mode === "pick"
      ? pickFlow(client, env, prompts)
      : mode === "continue"
        ? continueFlow(client, env, prompts)
        : mode === "resume"
          ? resumeFlow(client, env, prompts)
          : mode === "fork"
            ? forkFlow(client, env, prompts)
            : Effect.succeed(2),
  );
});

/**
 * The helper a harness's own status line or hook is pointed at: the payload arrives on
 * stdin and one agent's telemetry comes out. Handled before `herdr` above because it
 * runs inside a harness rather than inside herdr — there is no session to resolve, and
 * failing to find one must not break the human's status line.
 */
const compactionProgram = Effect.gen(function* () {
  const dir = args[2] ?? "";
  const [stdin, { recordClaudeEvent }] = yield* Effect.promise(() =>
    Promise.all([Bun.stdin.text(), import("./compactors")]),
  );
  const line = yield* recordClaudeEvent(dir, stdin).pipe(Effect.catch(() => Effect.succeed("")));
  if (line !== "") yield* Console.log(line);
}).pipe(Effect.provide(BunServices.layer));

const herdrProgram = herdr(args[1] ?? "", args[2]).pipe(
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const { herdrFailureReason } = yield* Effect.promise(() => import("./herdr"));
      yield* Console.error(herdrFailureReason(cause));
      process.exitCode = 1;
    }),
  ),
  Effect.provide(BunServices.layer),
);

// `program`, not `app`: the handler around it is what turns a parse failure into one
// JSON envelope and exit 2, and running `app` bare bypassed it entirely.
const cliProgram = Effect.promise(() => import("./collie")).pipe(
  Effect.flatMap(({ program }) => program),
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(
  args[0] === "herdr" ? (args[1] === "compaction" ? compactionProgram : herdrProgram) : cliProgram,
  { disableErrorReporting: true },
);
