import { readEnv } from "./env";
import { Herdr, HerdrError } from "./herdr";
import { forkFlow, openPicker, pickFlow, resumeFlow, runnerFlow, workspaceFlow, type Mode } from "./flows";

const USAGE = "herdr-workflows <pick|resume|fork|picker|runner|workspace>";

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const env = readEnv();
  const herdr = new Herdr(env);

  switch (command) {
    case "pick":
    case "resume":
    case "fork":
      return await openPicker(herdr, env, command);

    case "picker": {
      const mode = (process.env.HERDR_WORKFLOWS_MODE ?? "pick") as Mode;
      if (mode === "pick") return await pickFlow(herdr, env);
      if (mode === "resume") return await resumeFlow(herdr, env);
      if (mode === "fork") return await forkFlow(herdr, env);
      console.error(`unknown picker mode "${mode}"`);
      return 2;
    }

    case "runner":
      return await runnerFlow(herdr, env);

    case "workspace":
      return await workspaceFlow(herdr, env);

    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof HerdrError) {
    console.error(`${err.message}: ${err.detail}`);
  } else {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  process.exit(1);
}
