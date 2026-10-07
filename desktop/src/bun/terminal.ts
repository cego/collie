// Go to pane: herdr's terminal controller for the Run's pane, run over its Machine's route
// and drawn in Desktop; or, where there is no pane to control, a new herdr client in a
// terminal of its own on this computer. Desktop passes on what the controller prints and
// decides nothing from it.

import { Effect, Option, Schema, Stream } from "effect";
import type { PaneAt } from "../../../src/board-model";
import { ActionFailed, TerminalCommand, type TerminalEvent } from "../shared/flock";
import { quoted, type ShellRoute, spawned, stderrTail } from "./machine";

/** herdr's controller for one pane, taking it over from any other direct attach. */
export const controlCommand = (
  session: string | null,
  pane: string,
  cols: number,
  rows: number,
) => [
  "herdr",
  ...(session === null ? [] : ["--session", session]),
  ...["terminal", "session", "control", pane, "--takeover"],
  ...["--cols", String(cols), "--rows", String(rows)],
];

const ControllerRecord = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal.frame"),
    encoding: Schema.Literal("ansi"),
    bytes: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("terminal.closed"), reason: Schema.String }),
]);

/** One line the controller printed, where it is a frame or why it closed. */
export const readRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ControllerRecord));

const ControllerCommand = Schema.Union([
  TerminalCommand,
  Schema.Struct({ type: Schema.Literal("terminal.release") }),
]);

/** A command as the controller reads it: one JSON object to a line. */
export const commandLine = (command: typeof ControllerCommand.Type) =>
  `${Schema.encodeSync(Schema.fromJsonString(ControllerCommand))(command)}\n`;

const RELEASE = commandLine({ type: "terminal.release" });

/** ssh's own status when the connection, not the command, failed. */
const SSH_FAILED = 255;

/**
 * Runs `command`, herdr's controller, until the scope closes, which gives the pane back.
 * Its frames come as they are printed, then one `Ended` with why: the controller's own
 * reason, what herdr said on stderr, or that the connection to `machine` dropped.
 */
export const control = Effect.fn("Desktop.control")(function* (
  command: ReadonlyArray<string>,
  machine: string,
) {
  const child = yield* spawned(() =>
    Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
  );
  const said = yield* stderrTail(child.stderr);
  const send = (line: string) =>
    Effect.try(() => {
      void child.stdin.write(line);
      void child.stdin.flush();
    }).pipe(Effect.ignore);
  // Before `spawned` kills it, so herdr hears the release rather than a hang-up.
  yield* Effect.addFinalizer(() =>
    send(RELEASE).pipe(
      Effect.andThen(Effect.try(() => void child.stdin.end()).pipe(Effect.ignore)),
      Effect.andThen(Effect.promise(() => child.exited).pipe(Effect.timeoutOption("1 second"))),
    ),
  );
  let closed = false;
  let dropped = 0;
  const ended = Effect.promise(() => child.exited).pipe(
    Effect.map((code): TerminalEvent => ({
      _tag: "Ended",
      reason:
        code === SSH_FAILED
          ? `the connection to ${machine} dropped`
          : said() || `herdr's controller exited ${code}`,
    })),
  );
  const events = Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => readRecord(line)),
    Stream.tap((record) => Effect.sync(() => Option.isNone(record) && dropped++)),
    Stream.filter(Option.isSome),
    Stream.map(({ value }): TerminalEvent => {
      if (value.type === "terminal.frame") return { _tag: "Frame", bytes: value.bytes };
      closed = true;
      return { _tag: "Ended", reason: value.reason };
    }),
    Stream.takeUntil(() => closed),
    Stream.ignore,
    Stream.concat(Stream.suspend(() => (closed ? Stream.empty : Stream.fromEffect(ended)))),
    Stream.ensuring(
      Effect.suspend(() =>
        dropped === 0
          ? Effect.void
          : Effect.logWarning(`dropped ${dropped} lines herdr's controller printed`),
      ),
    ),
  );
  return { events, send: (command: TerminalCommand) => send(commandLine(command)) };
});

/**
 * Go to pane in Desktop: `focused` finds the Run's pane, and its controller is started
 * through `route`, so a remote Machine's is one more channel on its master. Where `focused`
 * names no pane there is nothing to control, and the terminal says only where it focused.
 */
export const openTerminal = Effect.fn("Desktop.openTerminal")(function* (
  focused: Effect.Effect<PaneAt, ActionFailed>,
  route: Pick<ShellRoute, "machine" | "sh">,
  cols: number,
  rows: number,
) {
  const at = yield* focused;
  if (at.pane === undefined)
    return {
      events: Stream.succeed<TerminalEvent>({ _tag: "NoPane", at }),
      send: (_: TerminalCommand) => Effect.void,
    };
  const command = yield* route
    .sh(shellLine(controlCommand(at.session, at.pane, cols, rows)))
    .pipe(Effect.mapError((reason) => new ActionFailed({ reason })));
  const opened = yield* control(command, route.machine.name);
  return {
    events: Stream.concat(Stream.succeed<TerminalEvent>({ _tag: "Opened", at }), opened.events),
    send: opened.send,
  };
});

/** A herdr client attached to a Machine's session: over SSH where it has a target, else Local's. */
export const attachCommand = (target: string | undefined, session: string | null) => [
  "herdr",
  ...(target === undefined ? [] : ["--remote", target]),
  ...(session === null ? [] : ["--session", session]),
];

export const shellLine = (command: ReadonlyArray<string>) =>
  command.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : quoted(word))).join(" ");

/** In the order this computer's default terminal is looked for, with how each is told what to run. */
const TERMINALS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

const appleString = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** `command` in this computer's default terminal, or null where none is found. */
export const inTerminal = (
  command: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  which: (name: string) => string | null,
): ReadonlyArray<string> | null => {
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      `tell application "Terminal" to do script ${appleString(shellLine(command))}`,
      "-e",
      `tell application "Terminal" to activate`,
    ];
  for (const [name, run] of TERMINALS) {
    const found = which(name);
    if (found !== null) return [found, ...run, ...command];
  }
  return null;
};

/** Whether `command` started and had not failed a second later. */
export const launched = (command: ReadonlyArray<string>) =>
  Effect.try(() =>
    Bun.spawn([...command], { stdio: ["ignore", "ignore", "ignore"], detached: true }),
  ).pipe(
    Effect.flatMap((started) =>
      Effect.promise(() => started.exited).pipe(
        Effect.timeoutOption("1 second"),
        Effect.map(Option.match({ onNone: () => true, onSome: (code) => code === 0 })),
        Effect.ensuring(Effect.sync(() => started.unref())),
      ),
    ),
    Effect.orElseSucceed(() => false),
  );
