import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, Effect, FileSystem, Path, type PlatformError } from "effect";
import { program } from "./collie";
import { currentEnv } from "./env";
import { Herdr, HerdrError } from "./herdr";
import { driveFlow, forkFlow, openPicker, pickFlow, resumeFlow, workspaceFlow } from "./flows";

const args = Bun.argv.slice(2);

type MainError = Error | PlatformError.PlatformError;
type MainServices = BunServices.BunServices | FileSystem.FileSystem | Path.Path;

const herdr: (command: string, mode?: string) => Effect.Effect<void, MainError, MainServices> =
  Effect.fn("main.herdr")(function* (command: string, mode?: string) {
    const env = yield* currentEnv;
    const client = new Herdr(env);
    const configuredMode = yield* Config.option(Config.string("COLLIE_MODE"));
    const selected = mode ?? (configuredMode._tag === "Some" ? configuredMode.value : "pick");
    if (!["pick", "resume", "fork", "picker", "drive", "workspace"].includes(command)) {
      yield* Console.error(`Unknown Herdr entrypoint "${command}".`);
      process.exitCode = 2;
      return;
    }
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
          return Effect.succeed(2);
      }
    })();
    process.exitCode = code;
  });

const herdrProgram = herdr(args[1] ?? "", args[2]).pipe(
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const message =
        cause instanceof HerdrError ? `${cause.message}: ${cause.detail}` : String(cause);
      yield* Console.error(message);
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
