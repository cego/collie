import { Console, Effect, Layer, Schema } from "effect";
// The manifest is the version: herdr reads it, `install.sh` builds the release URL
// from it, and a `--version` that disagreed with either would be worse than none.
import manifest from "../herdr-plugin.toml";
import { CliConfig, CliError, Command, GlobalFlag } from "effect/unstable/cli";
import { persona } from "./commands/persona";
import { run } from "./commands/run";
import { task } from "./commands/task";
import { root } from "./commands/shared";
import { doctor } from "./commands/doctor";
import { history } from "./commands/history";
import { upgrade } from "./commands/upgrade";
import { verify } from "./commands/verify";
import { confirm, decline, proposal, steer } from "./commands/steer";
import { chat, mcp, tools } from "./commands/chat";
import { board } from "./commands/board";
import { home } from "./commands/home";
import { workflow } from "./commands/workflow";
import { host } from "./commands/host";
import { printResult } from "./envelope";
import { err } from "./operations";

export const app = root.pipe(
  Command.withSubcommands([
    workflow,
    persona,
    run,
    task,
    history,
    steer,
    confirm,
    decline,
    proposal,
    verify,
    board,
    home,
    chat,
    tools,
    mcp,
    upgrade,
    doctor,
    host,
  ]),
);

/**
 * Read from `Bun.argv` rather than Stdio's `args` because both decide how the program
 * is *assembled* — which formatter and Console it is given — before any Effect of its
 * own runs. Everything downstream of `Command.run` takes its arguments from Stdio.
 */
const jsonAsked = Bun.argv.includes("--json");
/** Help was asked for, as opposed to offered because the command line was wrong. */
const helpAsked = Bun.argv.includes("--help") || Bun.argv.includes("-h");

/**
 * `Console.log` is the only stdout Effect's CLI writes to — the help document it
 * renders for any parse failure, and the version. Under `--json` that moves to
 * stderr, where the spec puts diagnostics, leaving stdout to the envelope a command
 * writes through its Stdio service. Effect's own logger already uses
 * `console.error`, so nothing else moves.
 */
const consoleToStderr = Console.Console.of({
  ...globalThis.console,
  log: (...args: ReadonlyArray<unknown>) => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`);
  },
});

const isShowHelp = Schema.is(CliError.ShowHelp);

/**
 * Everything a command handler did not catch, which is a parse failure or a defect.
 *
 * A ShowHelp is Effect's CLI asking for the help document to be shown, and it raises
 * one both for `--help` and for a command line it could not use — including a command
 * group named with no subcommand, which carries no parse errors at all. Only the first
 * is nobody's failure, so argv is the discriminator: anything else is invalid input,
 * exit 2, and under `--json` one envelope. In human mode Effect's CLI has already
 * printed the help and the reason, so this only sets the status.
 */
export const program = app.pipe(
  Command.run({ version: manifest.version }),
  Effect.catch((cause) =>
    Effect.gen(function* () {
      const parse = isShowHelp(cause) ? cause : null;
      if (parse && helpAsked) return;
      const failure = parse
        ? err("invalid_input", parseMessage(parse))
        : err("operation_failed", String(cause));
      if (jsonAsked) return yield* printResult(failure, true);
      process.exitCode = parse ? 2 : 1;
      if (!parse) yield* Console.error(failure.error.message);
    }),
  ),
  Effect.provide(
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.LogLevel] }),
  ),
  Effect.provide(jsonAsked ? Layer.succeed(Console.Console, consoleToStderr) : Layer.empty),
);

/** What was wrong with the command line, or that it stopped short of a command. */
function parseMessage(parse: CliError.ShowHelp): string {
  if (parse.errors.length > 0) return parse.errors.map((error) => error.message).join("; ");
  return `${["collie", ...parse.commandPath.slice(1)].join(" ")} needs a subcommand.`;
}
