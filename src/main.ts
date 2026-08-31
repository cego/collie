import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { program } from "./collie";
import { readEnv } from "./env";
import { Herdr, HerdrError } from "./herdr";
import { driveFlow, forkFlow, openPicker, pickFlow, resumeFlow, workspaceFlow, type Mode } from "./flows";

async function herdr(command: string, mode?: string): Promise<void> {
  const env = readEnv();
  const client = new Herdr(env);
  let code: number;
  switch (command) {
    case "pick":
    case "resume":
    case "fork":
      code = await openPicker(client, env, command);
      break;
    case "picker": {
      const selected = (mode ?? process.env.COLLIE_MODE ?? "pick") as Mode;
      code = selected === "pick"
        ? await pickFlow(client, env)
        : selected === "resume"
        ? await resumeFlow(client, env)
        : selected === "fork"
        ? await forkFlow(client, env)
        : 2;
      break;
    }
    case "drive":
      code = await driveFlow(client, env);
      break;
    case "workspace":
      code = await workspaceFlow(client, env);
      break;
    default:
      process.stderr.write(`Unknown Herdr entrypoint "${command}".\n`);
      code = 2;
  }
  process.exitCode = code;
}

const args = process.argv.slice(2);
if (args[0] === "herdr") {
  BunRuntime.runMain(
    Effect.tryPromise({ try: () => herdr(args[1] ?? "", args[2]), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.sync(() => {
        const message = cause instanceof HerdrError ? `${cause.message}: ${cause.detail}` : String(cause);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      })),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
} else {
  BunRuntime.runMain(program, { disableErrorReporting: true });
}
