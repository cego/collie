// Go to pane: herdr's terminal controller for the Run's pane, or core's attach for an agent
// on core, run over its Machine's route and drawn in Desktop; or, where there is no pane to
// control, a new herdr client in a terminal of its own on this computer. Desktop passes on
// what either prints and decides nothing from it.

import * as Str from "effect/String";
import * as Socket from "effect/socket/Socket";
import * as Base64 from "effect/encoding/Base64";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Option, Queue, Result, Schema, Stream, flow, type Cause } from "effect";
import { CommandLine } from "effect/process";
import type { PaneAt } from "../../../src/board-model";
import { type HcError, Kind, connectOver, u32 } from "../../../src/hc";
import { ActionFailed, TerminalCommand, type TerminalEvent } from "../shared/flock";
import { type ShellRoute, spawned, stderrTail } from "./machine";
import { CHILD_CWD, childEnv } from "./login-env";

/** herdr's controller for one pane, taking it over from any other direct attach. */
export const controlCommand = (
  session: string | null,
  pane: string,
  cols: number,
  rows: number,
) => [
  "herdr",
  ...(session === null ? [] : ["--session", session]),
  "terminal",
  "session",
  "control",
  pane,
  "--takeover",
  "--cols",
  String(cols),
  "--rows",
  String(rows),
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
  `${flow(Schema.encodeResult(Schema.fromJsonString(ControllerCommand)), Result.getOrThrow)(command)}\n`;

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
    Bun.spawn([...command], {
      env: childEnv(),
      cwd: CHILD_CWD,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
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

/** Core sends a viewer no more than this many bytes ahead of its CREDIT. */
const CORE_WINDOW = 256 * 1024;
/** The scrollback lines a core terminal's first paint brings. */
const HISTORY = 1000;

const CoreClosed = Schema.fromJsonString(
  Schema.Struct({
    reason: Schema.String,
    exit_code: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
);

const endedBy = (payload: Uint8Array) =>
  Option.match(Schema.decodeOption(CoreClosed)(new TextDecoder().decode(payload)), {
    onNone: () => "core closed the terminal",
    onSome: ({ reason, exit_code: code = null }) =>
      code === null ? reason : `${reason} with code ${code}`,
  });

const cells = (cols: number, rows: number) => {
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint16(0, cols, true);
  new DataView(size.buffer).setUint16(2, rows, true);
  return size;
};

interface Shown {
  readonly event: TerminalEvent;
  readonly channel: number;
  readonly bytes: number;
}

/**
 * Core's attach to `terminal`, through `command`, which speaks core's API on its stdin and
 * stdout as `herdr-core connect` does. Each DATA is credited once it is drawn, and a terminal
 * a whole window behind is attached again for a fresh paint rather than drawing core's backlog.
 */
export const attachCore = Effect.fn("Desktop.attachCore")(function* (
  command: ReadonlyArray<string>,
  machine: string,
  terminal: string,
  cols: number,
  rows: number,
) {
  const child = yield* spawned(() =>
    Bun.spawn([...command], {
      env: childEnv(),
      cwd: CHILD_CWD,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const said = yield* stderrTail(child.stderr);
  const socket = yield* Socket.fromTransformStream(
    Effect.succeed({
      readable: child.stdout,
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          void child.stdin.write(chunk);
          void child.stdin.flush();
        },
      }),
    }),
  );
  const failed = (error: HcError) => new ActionFailed({ reason: said() || error.message });
  const hc = yield* connectOver(socket, `${machine}'s core`, "by reader").pipe(
    Effect.mapError(failed),
  );
  yield* hc.call("hello", { generation: 1, framed: true }).pipe(Effect.mapError(failed));
  let size = { cols, rows };
  const attach = Effect.suspend(() =>
    hc.call("terminal.attach", { terminal, ...size, history: HISTORY }),
  ).pipe(
    Effect.mapError(failed),
    Effect.flatMap((attached) =>
      Effect.map(hc.channel(attached.channel), (frames) => ({ id: attached.channel, frames })),
    ),
  );
  let channel = yield* attach;
  let undrawn = 0;
  let ended = false;
  const shown = yield* Queue.unbounded<Shown, Cause.Done>();
  const end = (reason: string) =>
    Effect.suspend(() => {
      if (ended) return Effect.void;
      ended = true;
      return Queue.offer(shown, { event: { _tag: "Ended", reason }, channel: 0, bytes: 0 }).pipe(
        Effect.andThen(Queue.end(shown)),
      );
    });
  const repaint = Effect.gen(function* () {
    yield* hc.send(channel.id, Kind.CLOSE).pipe(Effect.ignore);
    yield* Queue.clear(shown);
    undrawn = 0;
    channel = yield* attach;
  });
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(channel.frames);
        if (frame.kind === Kind.CLOSE) return yield* end(endedBy(frame.payload));
        if (frame.kind !== Kind.DATA) continue;
        undrawn += frame.payload.length;
        if (undrawn >= CORE_WINDOW) yield* repaint;
        else
          yield* Queue.offer(shown, {
            event: { _tag: "Frame", bytes: Base64.encode(frame.payload) },
            channel: channel.id,
            bytes: frame.payload.length,
          });
      }
    }).pipe(Effect.catch((refused) => end(refused.reason))),
  );
  yield* Effect.forkScoped(
    Effect.promise(() => child.exited).pipe(
      Effect.flatMap((code) =>
        end(
          code === SSH_FAILED
            ? `the connection to ${machine} dropped`
            : said() || `core's connection exited ${code}`,
        ),
      ),
    ),
  );
  const drawn = (one: Shown) =>
    one.bytes === 0 || one.channel !== channel.id
      ? Effect.void
      : Effect.sync(() => (undrawn -= one.bytes)).pipe(
          Effect.andThen(hc.send(one.channel, Kind.CREDIT, u32(one.bytes))),
          Effect.ignore,
        );
  // xterm.js scrolls a core terminal's history itself, and types its own mouse reports.
  const send = (command: TerminalCommand): Effect.Effect<void> => {
    switch (command.type) {
      case "terminal.input":
        return hc
          .send(channel.id, Kind.DATA, new TextEncoder().encode(command.text))
          .pipe(Effect.ignore);
      case "terminal.resize":
        size = { cols: command.cols, rows: command.rows };
        return hc
          .send(channel.id, Kind.RESIZE, cells(command.cols, command.rows))
          .pipe(Effect.ignore);
      default:
        return Effect.void;
    }
  };
  return {
    events: Stream.fromQueue(shown).pipe(
      Stream.tap(drawn),
      Stream.map((one) => one.event),
    ),
    send,
  };
});

/**
 * Go to pane in Desktop: `focused` finds the Run's pane, and its controller, or core's attach
 * for an agent on core, is started through `route`, so a remote Machine's is one more channel
 * on its master. Where `focused` names no pane there is nothing to control, and the terminal
 * says only where it focused.
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
      send: (): Effect.Effect<void> => Effect.void,
    };
  const command = yield* route
    .sh(
      at.core === undefined
        ? Result.getOrThrow(CommandLine.join(controlCommand(at.session, at.pane, cols, rows)))
        : "herdr-core connect",
    )
    .pipe(Effect.mapError((reason) => new ActionFailed({ reason })));
  const opened =
    at.core === undefined
      ? yield* control(command, route.machine.name)
      : yield* attachCore(command, route.machine.name, at.core, cols, rows);
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

/** In the order this computer's default terminal is looked for, with how each is told what to run. */
const TERMINALS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

const appleString = (text: string) =>
  `"${pipe_(text, Str.replaceAll("\\", "\\\\"), Str.replaceAll('"', '\\"'))}"`;

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
      `tell application "Terminal" to do script ${appleString(Result.getOrThrow(CommandLine.join(command)))}`,
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
    Bun.spawn([...command], {
      env: childEnv(),
      cwd: CHILD_CWD,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    }),
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
