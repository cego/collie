import { readEnv } from "./env";
import { Herdr, HerdrError } from "./herdr";
import { openPicker, pickFlow, runnerFlow, type Mode } from "./flows";

const USAGE = "herdr-workflows <pick|resume|fork|picker|runner>";

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
      console.error(`${mode} is not implemented yet`);
      return 2;
    }

    case "runner":
      return await runnerFlow(herdr, env);

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
