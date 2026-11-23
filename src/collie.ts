import * as Arr from "effect/Array";
import { Console, Effect, Layer, Schema } from "effect";
// WARNING: install.sh and herdr read the release version from this manifest; a --version disagreeing with it is worse than none.
import manifest from "../package.json";
import { CliConfig, CliError, Command, GlobalFlag } from "effect/cli";
import { persona } from "./commands/persona";
import { artefacts, run } from "./commands/run";
import { task } from "./commands/task";
import { settings } from "./commands/settings";
import { cleanup } from "./commands/cleanup";
import { usage } from "./commands/usage";
import { models } from "./commands/models";
import { connections } from "./commands/connections";
import { schedule } from "./commands/schedule";
import { root } from "./commands/shared";
import { doctor } from "./commands/doctor";
import { upgrade } from "./commands/upgrade";
import { onboard } from "./commands/onboard";
import { verify } from "./commands/verify";
import { measure } from "./commands/measure";
import { confirm, decline, proposal, steer } from "./commands/steer";
import { chat, mcp, tools } from "./commands/chat";
import { board } from "./commands/board";
import { workflow } from "./commands/workflow";
import { host } from "./commands/host";
import { bridge } from "./commands/bridge";
import { machine } from "./commands/machine";
import { printResult } from "./envelope";
import { forgeHttpLayer } from "./forge/http";
import { err } from "./operations";

export const app = root.pipe(
  Command.withSubcommands([
    workflow,
    persona,
    run,
    artefacts,
    task,
    settings,
    steer,
    confirm,
    decline,
    proposal,
    verify,
    measure,
    board,
    chat,
    tools,
    mcp,
    upgrade,
    onboard,
    doctor,
    cleanup,
    usage,
    models,
    connections,
    schedule,
    host,
    bridge,
    machine,
  ]),
);

// WARNING: read from Bun.argv because the formatter and Console are chosen before any Effect runs.
const jsonAsked = Bun.argv.includes("--json");
const helpAsked = Bun.argv.includes("--help") || Bun.argv.includes("-h");

// WARNING: under --json Effect's own output goes to stderr, so stdout stays the envelope.
const consoleToStderr = Console.Console.of({
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    process.stderr.write(
      `${Arr.join(
        Arr.map(args, (arg) => String(arg)),
        " ",
      )}\n`,
    );
  },
});

const isShowHelp = Schema.is(CliError.ShowHelp);

// WARNING: ShowHelp also fires for an unusable command line, so argv, not the error, says --help was asked.
export const program = app.pipe(
  Command.run({ version: manifest.version }),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const parse = isShowHelp(cause) ? cause : null;
      if (parse && helpAsked) {
        return;
      }
      const failure = parse
        ? err("invalid_input", parseMessage(parse))
        : err("operation_failed", String(cause));
      if (jsonAsked) {
        return yield* printResult(failure, true);
      }
      process.exitCode = parse ? 2 : 1;
      if (!parse) {
        yield* Console.error(failure.error.message);
      }
    }),
  ),
  Effect.provide(
    CliConfig.layer({
      builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel],
    }).pipe(
      Layer.provideMerge(jsonAsked ? Layer.succeed(Console.Console, consoleToStderr) : Layer.empty),
      Layer.provideMerge(forgeHttpLayer),
    ),
  ),
);

function parseMessage(parse: CliError.ShowHelp) {
  if (parse.errors.length > 0) {
    return Arr.join(
      Arr.map(parse.errors, (error) => error.message),
      "; ",
    );
  }
  return `${Arr.join(["collie", ...parse.commandPath.slice(1)], " ")} needs a subcommand.`;
}
