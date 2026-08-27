import { readEnv } from "./env";
import { Herdr, HerdrError } from "./herdr";

const USAGE = "herdr-workflows <pick|resume|fork|picker|runner>";

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const env = readEnv();
  const herdr = new Herdr(env);

  switch (command) {
    case "pick":
    case "resume":
    case "fork": {
      // Actions run detached with no tty, so the interactive part lives in the pane.
      console.log(`[${command}] env: ${JSON.stringify(env.raw)}`);
      console.log(`[${command}] cwd: ${env.cwd}`);
      return 0;
    }
    case "picker":
    case "runner": {
      console.log(`[${command}] not implemented yet`);
      return 0;
    }
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
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
}
