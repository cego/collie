// Go to pane attaches to a core terminal through this computer's core.
// Remote terminals use their Machine-qualified address; no legacy controller is started.

import * as Str from "effect/String";
import * as Socket from "effect/socket/Socket";
import * as Base64 from "effect/encoding/Base64";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Option, Queue, Result, Schema, Stream, type Cause } from "effect";
import { CommandLine } from "effect/process";
import type { PaneAt } from "../../../src/board-model";
import { type HcError, Kind, connectOver, u32 } from "../../../src/hc";
import { ActionFailed, type TerminalCommand, type TerminalEvent } from "../shared/flock";
import { localRoute, type ShellRoute, spawned, stderrTail } from "./machine";
import { CHILD_CWD, childEnv } from "./login-env";

/** ssh's own status when the connection, not the command, failed. */
const SSH_FAILED = 255;

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
  const send = (command: TerminalCommand) => {
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

/** Attaches to the live core terminal the host names, through this computer's core. */
export const openTerminal = Effect.fn("Desktop.openTerminal")(function* (
  focused: Effect.Effect<PaneAt, ActionFailed>,
  route: Pick<ShellRoute, "machine" | "sh">,
  cols: number,
  rows: number,
) {
  const at = yield* focused;
  if (at.core === undefined)
    return {
      events: Stream.succeed<TerminalEvent>({ _tag: "NoPane", at }),
      send: () => Effect.void,
    };
  const local = route.machine.profile === "local";
  const command = yield* (local ? route : localRoute([], ""))
    .sh("herdr-core connect")
    .pipe(Effect.mapError((reason) => new ActionFailed({ reason })));
  const opened = yield* attachCore(
    command,
    route.machine.name,
    local ? at.core : `${route.machine.name}/${at.core}`,
    cols,
    rows,
  );
  return {
    events: Stream.concat(Stream.succeed<TerminalEvent>({ _tag: "Opened", at }), opened.events),
    send: opened.send,
  };
});

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
) => {
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
