// Going to a pane: herdr's terminal controller Desktop runs and what it reads from it, or
// core's attach for an agent on core; and the herdr client Desktop attaches instead, and the
// terminal on this computer it opens in.

import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Queue, Result, Schedule, Schema, Stream } from "effect";
import * as Base64 from "effect/encoding/Base64";
import { CommandLine } from "effect/process";
import type { PaneAt } from "../src/board-model";
import {
  type Door,
  focusOn,
  localRoute,
  type Reached,
  remoteRoute,
} from "../desktop/src/bun/machine";
import type { TerminalEvent } from "../desktop/src/shared/flock";
import { connect } from "../src/hc";
import { CORE_WINDOW, serveFakeHc } from "./support/fake-hc";
import { socketDir } from "./support/fake-ssh";
import {
  attachCore,
  attachCommand,
  commandLine,
  control,
  controlCommand,
  inTerminal,
  launched,
  openTerminal,
  readRecord,
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

test("a chosen agent is focused by its own Run, and no choice asks for the Run's newest", () =>
  runEffect(
    Effect.gen(function* () {
      const asked: Array<unknown> = [];
      const focus: Partial<Door> = {
        // SAFETY: focusOn calls focus with a payload alone, and reads only its pane.
        focus: ((payload: { runId: string; agent?: string; request: string }) =>
          Effect.sync(() => (asked.push(payload), AT))) as Door["focus"],
      };
      // SAFETY: focusOn calls only focus.
      const door: Reached = { machine: { profile: "vm", name: "vm-mk" }, desktop: focus as Door };
      yield* focusOn(door, "rq-1", "run-1.implement", "review-1");
      yield* focusOn(door, "rq-2", "run-1");
      expect(asked).toEqual([
        { runId: "run-1.implement", agent: "review-1", request: "rq-1" },
        { runId: "run-1", request: "rq-2" },
      ]);
    }),
  ));

test("the command to copy reads as typed, quoting only what a shell would split", () => {
  expect(Result.getOrThrow(CommandLine.join(attachCommand("mk@vm-mk", "my work")))).toBe(
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
  expect(Result.getOrThrow(CommandLine.join(controlCommand(null, "1-2", 80, 24)))).toBe(
    "herdr terminal session control 1-2 --takeover --cols 80 --rows 24",
  );
  expect(Result.getOrThrow(CommandLine.join(controlCommand("my work", "1-2", 80, 24)))).toBe(
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
 * And a local collie whose `machine connect` logs that it opened the shared connection, and
 * an ssh whose channels refuse to log in alone.
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
    collie: `#!/bin/sh
echo "open mk@vm-mk" >> '${dir}/ssh.log'
touch '${dir}/control'
echo '{"ok":true,"data":{"machine":"vm-mk","path":"${dir}/control","opened":true}}'
`,
    ssh: `#!/bin/bash
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -S ] && control="\${args[i+1]}"; done
[ "\${args[2]}" = -O ] && { [ -e "$control" ]; exit; }
[ -e "$control" ] || { echo "no master" >&2; exit 255; }
[[ " $* " == *" ControlMaster=no "* ]] || { echo "a channel could log in by itself" >&2; exit 255; }
FAKE_TARGET="\${args[-2]}" SHELL='${dir}/shell' exec /bin/sh -c "\${args[-1]}"
`,
  };
  yield* fs.makeDirectory(`${dir}/bin`);
  for (const [name, script] of Rec.toEntries(scripts)) {
    yield* fs.writeFileString(`${dir}/${name}`, script);
    yield* fs.chmod(`${dir}/${name}`, 0o755);
  }
  const log = (name: string) =>
    fs.readFileString(`${dir}/${name}`).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
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
    Effect.filterOrFail(
      (lines) =>
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(lines.at(-1)), (present) =>
            pipe_(present, Str.endsWith(last)),
          ),
        ) === true,
    ),
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
  );

test(
  "Go to pane on a Machine runs its controller as one more channel on its shared SSH connection, and gives the pane back",
  () =>
    runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const { dir, log } = yield* rig;
          const route = yield* remoteRoute(
            `${dir}/ssh`,
            [`${dir}/collie`],
            { id: "vm", label: "vm-mk", target: "mk@vm-mk", session: "default", enabled: true },
            "mk-pc",
            true,
          );
          expect(yield* log("ssh.log")).toEqual([]);
          yield* route.forward(9876);
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
          // The SSO a connection asks for is asked once, at connect.
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

/**
 * A fake core with one agent's terminal, `builder-1`, and a computer whose `herdr-core
 * connect` carries its stdin and stdout to that core, as hc's own does; herdr's controller
 * is on its PATH too.
 */
const coreRig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { dir } = yield* rig;
  const at = yield* socketDir("desktop-core-");
  const logPath = `${at}/core.jsonl`;
  const core = yield* serveFakeHc(`${at}/hc.sock`, logPath, yield* Effect.scope);
  yield* fs.writeFileString(
    `${dir}/bin/herdr-core`,
    `#!${process.execPath}
if (process.argv[2] !== "connect") process.exit(2);
const socket = await Bun.connect({
  unix: "${core.socketPath}",
  socket: { data: (_s, data) => void process.stdout.write(data), close: () => process.exit(0) },
});
for await (const chunk of Bun.stdin.stream()) socket.write(chunk);
socket.end();
`,
  );
  yield* fs.chmod(`${dir}/bin/herdr-core`, 0o755);
  yield* Effect.scoped(
    Effect.flatMap(connect(core.socketPath), (hc) =>
      hc.call("terminal.run", {
        name: "builder-1",
        argv: ["claude"],
        cwd: dir,
        labels: { run: "run-1" },
      }),
    ),
  );
  const Logged = Schema.fromJsonString(
    Schema.Struct({ cmd: Schema.String, params: Schema.optionalKey(Schema.Json) }),
  );
  /** What core was told, once `ready` holds of it. */
  const told = (ready: (entries: ReadonlyArray<typeof Logged.Type>) => boolean) =>
    fs.readFileString(logPath).pipe(
      Effect.map((text) =>
        Arr.filterMap(Str.split(text, "\n"), (line) => Schema.decodeResult(Logged)(line)),
      ),
      Effect.filterOrFail(ready),
      Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    );
  return { dir, core, told, connect: [`${dir}/bin/herdr-core`, "connect"] };
});

const drawn = (event: TerminalEvent | undefined) =>
  event?._tag === "Frame"
    ? new TextDecoder().decode(Result.getOrThrow(Base64.decode(event.bytes)))
    : `not a frame: ${event?._tag}`;

/** Every event the terminal shows, drawn as it comes. */
const shownAll = (opened: { readonly events: Stream.Stream<TerminalEvent> }) =>
  Effect.gen(function* () {
    const shown = yield* Queue.unbounded<TerminalEvent>();
    yield* Effect.forkScoped(
      Stream.runForEach(opened.events, (event) => Queue.offer(shown, event)),
    );
    return shown;
  });

test("a core terminal in Desktop: its first paint, keys as DATA, a resize as RESIZE, CREDIT for what is drawn, and its exit", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { core, told, connect } = yield* coreRig;
        yield* core.print("builder-1", "ready> ");
        const opened = yield* attachCore(connect, "mk-pc", "builder-1", 80, 24);
        const shown = yield* shownAll(opened);

        const paint = drawn(yield* Queue.take(shown));
        expect(paint).toContain("ready> ");
        yield* opened.send({ type: "terminal.input", text: "y\r" });
        yield* opened.send({ type: "terminal.resize", cols: 100, rows: 30 });
        yield* core.print("builder-1", "working\r\n");
        expect(drawn(yield* Queue.take(shown))).toBe("working\r\n");
        yield* core.exit("builder-1", 3);
        expect(yield* Queue.take(shown)).toEqual({ _tag: "Ended", reason: "exited with code 3" });

        const said = yield* told(
          (entries) => Arr.filter(entries, (entry) => entry.cmd === "attach.credit").length === 2,
        );
        expect(Arr.filter(said, (entry) => pipe_(entry.cmd, Str.startsWith("attach")))).toEqual([
          { cmd: "attach.credit", params: { terminal: "builder-1", bytes: paint.length } },
          { cmd: "attach.data", params: { terminal: "builder-1", text: "y\r" } },
          { cmd: "attach.resize", params: { terminal: "builder-1", cols: 100, rows: 30 } },
          { cmd: "attach.credit", params: { terminal: "builder-1", bytes: 9 } },
        ]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));

test("a terminal a whole window behind core is repainted, and the backlog never drawn", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { core, told, connect } = yield* coreRig;
        const opened = yield* attachCore(connect, "mk-pc", "builder-1", 80, 24);
        yield* core.print("builder-1", pipe_("x\r\n", Str.repeat(CORE_WINDOW)));

        const said = yield* told(
          (entries) => Arr.filter(entries, (entry) => entry.cmd === "terminal.attach").length === 2,
        );
        expect(Arr.filter(said, (entry) => pipe_(entry.cmd, Str.startsWith("attach")))).toEqual([
          { cmd: "attach.close", params: { terminal: "builder-1" } },
        ]);
        const first = yield* Stream.runHead(opened.events);
        expect(drawn(Option.getOrUndefined(first))).toBe(
          `\u001b[!p\u001b[H\u001b[2J${pipe_("x\r\n", Str.repeat(CORE_WINDOW), Str.slice(-200))}`,
        );
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));

test("Go to pane attaches to core for an agent on core, and runs herdr's controller for one on Herdr 1", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, core } = yield* coreRig;
        const shell = Bun.env.SHELL;
        Bun.env.SHELL = `${dir}/shell`;
        yield* Effect.addFinalizer(() => Effect.sync(() => (Bun.env.SHELL = shell)));
        yield* core.print("builder-1", "on core");
        const route = localRoute([], "mk-pc");
        const onCore: PaneAt = {
          session: null,
          workspace: "builder-1",
          tab: null,
          pane: "t1",
          agent: "builder-1",
          core: "builder-1",
        };
        const firstTwo = (at: PaneAt) =>
          Effect.scoped(
            Effect.flatMap(openTerminal(Effect.succeed(at), route, 80, 24), (opened) =>
              Stream.runCollect(Stream.take(opened.events, 2)),
            ),
          );

        const [opened, painted] = yield* firstTwo(onCore);
        expect(opened).toEqual({ _tag: "Opened", at: onCore });
        expect(drawn(painted)).toContain("on core");
        expect(yield* firstTwo({ ...AT, session: null })).toEqual([
          { _tag: "Opened", at: { ...AT, session: null } },
          { _tag: "Frame", bytes: "aGk=" },
        ]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));

test("Go to pane on another Machine's core agent attaches to <machine>/<terminal> through this computer's core", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, core, told } = yield* coreRig;
        const shell = Bun.env.SHELL;
        Bun.env.SHELL = `${dir}/shell`;
        yield* Effect.addFinalizer(() => Effect.sync(() => (Bun.env.SHELL = shell)));
        yield* Effect.scoped(
          Effect.flatMap(connect(core.socketPath), (hc) =>
            hc.call("machine.add", { name: "vm-mk", target: "mk@vm-mk" }),
          ),
        );
        yield* core.print("builder-1", "on vm-mk");
        const route = {
          machine: { profile: "vm", name: "vm-mk", target: "mk@vm-mk", route: "ssh" as const },
          sh: () => Effect.die("nothing runs over SSH"),
        };
        const at: PaneAt = {
          session: null,
          workspace: "builder-1",
          tab: null,
          pane: "t1",
          agent: "builder-1",
          core: "builder-1",
        };
        const [opened, painted] = yield* Effect.scoped(
          Effect.flatMap(openTerminal(Effect.succeed(at), route, 80, 24), (shown) =>
            Stream.runCollect(Stream.take(shown.events, 2)),
          ),
        );

        expect(opened).toEqual({ _tag: "Opened", at });
        expect(drawn(painted)).toContain("on vm-mk");
        const said = yield* told((entries) =>
          Arr.some(entries, (entry) => entry.cmd === "terminal.attach"),
        );
        expect(
          Arr.map(
            Arr.filter(said, (entry) => entry.cmd === "terminal.attach"),
            (entry) => entry.params,
          ),
        ).toEqual([expect.objectContaining({ terminal: "vm-mk/builder-1" })]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));
