import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, FileSystem, Path, type PlatformError } from "effect";
import { program } from "./collie";
import { currentEnv } from "./env";
import { Herdr, herdrFailureReason } from "./herdr";
import { driveFlow, forkFlow, openPicker, pickFlow, resumeFlow, workspaceFlow } from "./flows";

/**
 * The two front doors share one entry point. `Bun.argv` rather than Stdio's `args`
 * only here: this choice is made before any Effect runs, because it decides which
 * program to hand to BunRuntime — and `program` itself reads its arguments through
 * Stdio, as Command.run does.
 */
const args = Bun.argv.slice(2);

type MainError = Error | PlatformError.PlatformError;
type MainServices = BunServices.BunServices | FileSystem.FileSystem | Path.Path;

const herdr: (command: string, mode?: string) => Effect.Effect<void, MainError, MainServices> =
  Effect.fn("main.herdr")(function* (command: string, mode?: string) {
    const env = yield* currentEnv;
    const client = new Herdr(env);
    const configuredMode = yield* Config.option(Config.string("COLLIE_MODE"));
    const selected = mode ?? (configuredMode._tag === "Some" ? configuredMode.value : "pick");
    const code = yield* (() => {
      switch (command) {
        case "pick":
        case "resume":
        case "fork":
          return openPicker(client, env, command);
        case "picker":
          return selected === "pick"
            ? pickFlow(client, env)
            : selected === "resume"
              ? resumeFlow(client, env)
              : selected === "fork"
                ? forkFlow(client, env)
                : Effect.succeed(2);
        case "drive":
          return driveFlow(client, env);
        case "workspace":
          return workspaceFlow(client, env);
        default:
          return Console.error(`Unknown Herdr entrypoint "${command}".`).pipe(Effect.as(2));
      }
    })();
    process.exitCode = code;
  });

const herdrProgram = herdr(args[1] ?? "", args[2]).pipe(
  Effect.catch((cause) =>
    Effect.gen(function* () {
      yield* Console.error(herdrFailureReason(cause));
      process.exitCode = 1;
    }),
  ),
  Effect.provide(BunServices.layer),
);

// `program`, not `app`: the handler around it is what turns a parse failure into one
// JSON envelope and exit 2, and running `app` bare bypassed it entirely.
const cliProgram = program.pipe(Effect.provide(BunServices.layer));

BunRuntime.runMain(args[0] === "herdr" ? herdrProgram : cliProgram, {
  disableErrorReporting: true,
});
