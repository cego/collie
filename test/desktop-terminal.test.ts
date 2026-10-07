// Going to a pane: herdr's terminal controller Desktop runs and what it reads from it; and the
// herdr client Desktop attaches instead, and the terminal on this computer it opens in.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Schedule, Stream } from "effect";
import type { PaneAt } from "../src/board-model";
import { localRoute, remoteRoute } from "../desktop/src/bun/machine";
import {
  attachCommand,
  commandLine,
  control,
  controlCommand,
  inTerminal,
  launched,
  openTerminal,
  readRecord,
  shellLine,
} from "../desktop/src/bun/terminal";
import { runEffect } from "./support/effect";

const onPath =
  (...found: ReadonlyArray<string>) =>
  (name: string) =>
    found.includes(name) ? `/usr/bin/${name}` : null;

test("a Machine's session is attached over SSH, and Local's directly", () => {
  expect(attachCommand("mk@vm-mk", "work")).toEqual([
    "herdr",
    "--remote",
    "mk@vm-mk",
    "--session",
    "work",
  ]);
  expect(attachCommand("mk@vm-mk", null)).toEqual(["herdr", "--remote", "mk@vm-mk"]);
  expect(attachCommand(undefined, "work")).toEqual(["herdr", "--session", "work"]);
  expect(attachCommand(undefined, null)).toEqual(["herdr"]);
});

test("the command to copy reads as typed, quoting only what a shell would split", () => {
  expect(shellLine(["herdr", "--remote", "mk@vm-mk", "--session", "my work"])).toBe(
    "herdr --remote mk@vm-mk --session 'my work'",
  );
});

test("this computer's default terminal is x-terminal-emulator, else the first one found", () => {
  const herdr = ["herdr", "--remote", "mk@vm-mk"];
  expect(inTerminal(herdr, "linux", onPath("x-terminal-emulator", "kitty"))).toEqual([
    "/usr/bin/x-terminal-emulator",
    "-e",
    ...herdr,
  ]);
  expect(inTerminal(herdr, "linux", onPath("xterm", "gnome-terminal"))).toEqual([
    "/usr/bin/gnome-terminal",
    "--",
    ...herdr,
  ]);
  expect(inTerminal(herdr, "linux", onPath("kitty"))).toEqual(["/usr/bin/kitty", ...herdr]);
  expect(inTerminal(herdr, "linux", onPath())).toBeNull();
});

test("on macOS it is Terminal.app, told the command as a line", () => {
  expect(inTerminal(["herdr", "--session", "my work"], "darwin", onPath())).toEqual([
    "osascript",
    "-e",
    `tell application "Terminal" to do script "herdr --session 'my work'"`,
    "-e",
    `tell application "Terminal" to activate`,
  ]);
});

test("a terminal that fails as it starts, or is not there, did not open", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* launched(["true"])).toBe(true);
      expect(yield* launched(["sleep", "1.5"])).toBe(true);
      expect(yield* launched(["false"])).toBe(false);
      expect(yield* launched(["/nonexistent/terminal"])).toBe(false);
    }),
  ));

test("the controller takes over a pane in a named session, or in herdr's default one", () => {
  expect(controlCommand("work", "1-2", 120, 40)).toEqual([
    "herdr",
    "--session",
    "work",
    "terminal",
    "session",
    "control",
    "1-2",
    "--takeover",
    "--cols",
    "120",
    "--rows",
    "40",
  ]);
  expect(shellLine(controlCommand(null, "1-2", 80, 24))).toBe(
    "herdr terminal session control 1-2 --takeover --cols 80 --rows 24",
  );
  expect(shellLine(controlCommand("my work", "1-2", 80, 24))).toBe(
    "herdr --session 'my work' terminal session control 1-2 --takeover --cols 80 --rows 24",
  );
});

test("each line the controller prints is a frame or why it closed, and anything else is dropped", () => {
  expect(
    readRecord(
      '{"type":"terminal.frame","seq":3,"width":80,"height":24,"full":true,"encoding":"ansi","bytes":"aGk="}',
    ),
  ).toEqual(Option.some({ type: "terminal.frame", encoding: "ansi", bytes: "aGk=" }));
  expect(readRecord('{"type":"terminal.frame","encoding":"utf16","bytes":"aGk="}')).toEqual(
    Option.none(),
  );
  expect(readRecord('{"type":"terminal.closed","reason":"pane closed"}')).toEqual(
    Option.some({ type: "terminal.closed", reason: "pane closed" }),
  );
  expect(readRecord('{"type":"terminal.frame","seq":4}')).toEqual(Option.none());
  expect(readRecord("Welcome to vm-mk")).toEqual(Option.none());
  expect(readRecord('{"type":"terminal.bell"}')).toEqual(Option.none());
});

test("what the human does reaches the controller as one line of herdr's own commands", () => {
  expect(commandLine({ type: "terminal.input", text: "y\r" })).toBe(
    '{"type":"terminal.input","text":"y\\r"}\n',
  );
  expect(commandLine({ type: "terminal.resize", cols: 100, rows: 30 })).toBe(
    '{"type":"terminal.resize","cols":100,"rows":30}\n',
  );
  expect(
    commandLine({
      type: "terminal.scroll",
      direction: "up",
      lines: 3,
      column: 4,
      row: 5,
      modifiers: 0,
    }),
  ).toBe(
    '{"type":"terminal.scroll","direction":"up","lines":3,"column":4,"row":5,"modifiers":0}\n',
  );
  expect(
    commandLine({
      type: "terminal.mouse",
      action: "down",
      button: "left",
      column: 1,
      row: 2,
      modifiers: 2,
    }),
  ).toBe(
    '{"type":"terminal.mouse","action":"down","button":"left","column":1,"row":2,"modifiers":2}\n',
  );
  expect(commandLine({ type: "terminal.release" })).toBe('{"type":"terminal.release"}\n');
});

const controlled = (script: string) =>
  Effect.scoped(
    Effect.flatMap(control(["/bin/sh", "-c", script], "vm-mk"), ({ events }) =>
      Stream.runCollect(events),
    ),
  );

const FRAME = `{"type":"terminal.frame","seq":1,"width":2,"height":1,"full":true,"encoding":"ansi","bytes":"aGk="}`;

test("a controller's frames come through, then why it ended: its own reason, herdr's words, or the connection", () =>
  runEffect(
    Effect.gen(function* () {
      expect(
        yield* controlled(
          `echo 'Welcome'; echo '${FRAME}'; echo '{"type":"terminal.closed","reason":"pane closed"}'; echo '${FRAME}'`,
        ),
      ).toEqual([
        { _tag: "Frame", bytes: "aGk=" },
        { _tag: "Ended", reason: "pane closed" },
      ]);
      expect(yield* controlled("echo 'pane 9-9 not found' >&2; exit 1")).toEqual([
        { _tag: "Ended", reason: "pane 9-9 not found" },
      ]);
      expect(
        yield* controlled(`echo '${FRAME}'; echo 'Shared connection closed.' >&2; exit 255`),
      ).toEqual([
        { _tag: "Frame", bytes: "aGk=" },
        { _tag: "Ended", reason: "the connection to vm-mk dropped" },
      ]);
    }),
  ));

test("what is sent reaches the controller, and closing the terminal releases the pane", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const read = `${yield* fs.makeTempDirectoryScoped({ prefix: "terminal-" })}/read`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* control(["/bin/sh", "-c", `cat > '${read}'`], "vm-mk");
          yield* opened.send({ type: "terminal.input", text: "y" });
        }),
      );
      expect(yield* Effect.promise(() => Bun.file(read).text())).toBe(
        '{"type":"terminal.input","text":"y"}\n{"type":"terminal.release"}\n',
      );
    }),
  ));

/**
 * A computer with herdr's controller on PATH, as a Machine's login shell finds it: it logs
 * how it was started and each command it reads, led by its Machine, and prints one frame.
 * And an ssh whose master logs that it opened, and whose channels refuse to log in alone.
 */
const rig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-desktop-terminal-" });
  const scripts = {
    "bin/herdr": `#!/bin/sh
echo "\${FAKE_TARGET:-local} open $*" >> '${dir}/control.log'
echo '${FRAME}'
while IFS= read -r line; do echo "\${FAKE_TARGET:-local} $line" >> '${dir}/control.log'; done
`,
    shell: `#!/bin/sh
[ "$1" = -lc ] && shift
PATH='${dir}/bin':"$PATH" exec /bin/sh -c "$@"
`,
    ssh: `#!/bin/bash
args=("$@")
target="\${args[-1]}"
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -S ] && control="\${args[i+1]}"; done
if [ "$1" = -M ]; then
  echo "open $target" >> '${dir}/ssh.log'
  trap 'rm -f "$control"; exit 0' TERM
  touch "$control"
  while :; do sleep 0.1; done
fi
[ "\${args[2]}" = -O ] && { [ -e "$control" ]; exit; }
[ -e "$control" ] || { echo "no master" >&2; exit 255; }
[[ " $* " == *" ControlMaster=no "* ]] || { echo "a channel could log in by itself" >&2; exit 255; }
FAKE_TARGET="\${args[-2]}" SHELL='${dir}/shell' exec /bin/sh -c "\${args[-1]}"
`,
  };
  yield* fs.makeDirectory(`${dir}/bin`);
  for (const [name, script] of Object.entries(scripts)) {
    yield* fs.writeFileString(`${dir}/${name}`, script);
    yield* fs.chmod(`${dir}/${name}`, 0o755);
  }
  const log = (name: string) =>
    fs.readFileString(`${dir}/${name}`).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) => text.split("\n").filter((line) => line !== "")),
    );
  return { dir, log };
});

const AT: PaneAt = { session: "work", workspace: "workspace 3", tab: "tab 2", pane: "p-1" };

/** Opens the terminal, sends `typed` once it shows, and closes it again. */
const visit = (opened: Effect.Success<ReturnType<typeof openTerminal>>, typed: string) =>
  opened.events.pipe(
    Stream.tap((event) =>
      event._tag === "Frame" ? opened.send({ type: "terminal.input", text: typed }) : Effect.void,
    ),
    Stream.take(2),
    Stream.runCollect,
  );

const settledLog = (log: Effect.Effect<ReadonlyArray<string>>, last: string) =>
  log.pipe(
    Effect.filterOrFail((lines) => lines.at(-1)?.endsWith(last) === true),
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
  );

test(
  "Go to pane on a Machine runs its controller as one more channel on the master Desktop holds, and gives the pane back",
  () =>
    runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const { dir, log } = yield* rig;
          const route = yield* remoteRoute(
            `${dir}/ssh`,
            `${dir}/control`,
            { id: "vm", label: "vm-mk", target: "mk@vm-mk", session: "default", enabled: true },
            "mk-pc",
          );
          let focused = 0;
          const focus = Effect.sync(() => (focused++, AT));
          for (const typed of ["y", "n"]) {
            const events = yield* Effect.scoped(
              Effect.flatMap(openTerminal(focus, route, 100, 30), (opened) => visit(opened, typed)),
            );
            expect(events).toEqual([
              { _tag: "Opened", at: AT },
              { _tag: "Frame", bytes: "aGk=" },
            ]);
          }
          const sent = yield* settledLog(log("control.log"), '{"type":"terminal.release"}');
          expect(sent).toEqual([
            "mk@vm-mk open --session work terminal session control p-1 --takeover --cols 100 --rows 30",
            'mk@vm-mk {"type":"terminal.input","text":"y"}',
            'mk@vm-mk {"type":"terminal.release"}',
            "mk@vm-mk open --session work terminal session control p-1 --takeover --cols 100 --rows 30",
            'mk@vm-mk {"type":"terminal.input","text":"n"}',
            'mk@vm-mk {"type":"terminal.release"}',
          ]);
          // Each visit, a Reattach among them, asks where the pane is afresh.
          expect(focused).toBe(2);
          // The SSO a master asks for is asked once, at connect.
          expect(yield* log("ssh.log")).toEqual(["open mk@vm-mk"]);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ),
  30_000,
);

test("Local's pane is controlled through a process of its own, the same way", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, log } = yield* rig;
        const shell = Bun.env.SHELL;
        Bun.env.SHELL = `${dir}/shell`;
        yield* Effect.addFinalizer(() => Effect.sync(() => (Bun.env.SHELL = shell)));
        const events = yield* Effect.scoped(
          Effect.flatMap(
            openTerminal(Effect.succeed({ ...AT, session: null }), localRoute([], "mk-pc"), 80, 24),
            (opened) => visit(opened, "\u001b"),
          ),
        );
        expect(events[1]).toEqual({ _tag: "Frame", bytes: "aGk=" });
        expect(yield* settledLog(log("control.log"), '{"type":"terminal.release"}')).toEqual([
          "local open terminal session control p-1 --takeover --cols 80 --rows 24",
          'local {"type":"terminal.input","text":"\\u001b"}',
          'local {"type":"terminal.release"}',
        ]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));

test("a Run whose host names no pane has nothing to control, and is only said where it is", () =>
  runEffect(
    Effect.gen(function* () {
      const { pane: _, ...workspace } = AT;
      const route = {
        machine: { profile: "vm", name: "vm-mk" },
        sh: () => Effect.die("nothing is started"),
      };
      const opened = yield* Effect.scoped(openTerminal(Effect.succeed(workspace), route, 80, 24));
      expect(yield* Stream.runCollect(opened.events)).toEqual([{ _tag: "NoPane", at: workspace }]);
    }),
  ));
