// Desktop attaches only to core: local and remote terminals, input, resize and reconnect.

import { pipe as pipe_ } from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Option, Queue, Result, Schedule, Schema, Stream } from "effect";
import * as Base64 from "effect/encoding/Base64";
import type { PaneAt } from "../src/board-model";
import { type Door, focusOn, localRoute, type Reached } from "../desktop/src/bun/machine";
import type { TerminalEvent } from "../desktop/src/shared/flock";
import { connect } from "../src/hc";
import { CORE_WINDOW, serveFakeHc } from "./support/fake-hc";
import { socketDir } from "./support/fake-ssh";
import { attachCore, inTerminal, launched, openTerminal } from "../desktop/src/bun/terminal";
import { runEffect } from "./support/effect";
import { armTripwire, untripped } from "./support/herdr-tripwire";

const onPath =
  (...found: ReadonlyArray<string>) =>
  (name: string) =>
    found.includes(name) ? `/usr/bin/${name}` : null;

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

test("this computer's default terminal is x-terminal-emulator, else the first one found", () => {
  const command = ["hc", "attach", "vm-mk/t1"];
  expect(inTerminal(command, "linux", onPath("x-terminal-emulator", "kitty"))).toEqual([
    "/usr/bin/x-terminal-emulator",
    "-e",
    ...command,
  ]);
  expect(inTerminal(command, "linux", onPath("xterm", "gnome-terminal"))).toEqual([
    "/usr/bin/gnome-terminal",
    "--",
    ...command,
  ]);
  expect(inTerminal(command, "linux", onPath("kitty"))).toEqual(["/usr/bin/kitty", ...command]);
  expect(inTerminal(command, "linux", onPath())).toBeNull();
});

test("on macOS it is Terminal.app, told the command as a line", () => {
  expect(inTerminal(["hc", "attach", "my work"], "darwin", onPath())).toEqual([
    "osascript",
    "-e",
    `tell application "Terminal" to do script "hc attach 'my work'"`,
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

const AT: PaneAt = { session: "work", workspace: "workspace 3", tab: "tab 2", pane: "p-1" };

test("a legacy pane without a core terminal never starts a controller", () =>
  runEffect(
    Effect.gen(function* () {
      const route = {
        machine: { profile: "local", name: "mk-pc" },
        sh: () => Effect.die("a legacy controller must not start"),
      };
      const opened = yield* Effect.scoped(openTerminal(Effect.succeed(AT), route, 80, 24));
      expect(yield* Stream.runCollect(opened.events)).toEqual([{ _tag: "NoPane", at: AT }]);
    }),
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

/** A fake core and a login shell whose PATH rejects every legacy herdr call. */
const coreRig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* socketDir("desktop-core-");
  const tripwire = yield* armTripwire(dir);
  yield* Effect.addFinalizer(() => untripped(tripwire).pipe(Effect.ensuring(tripwire.stop)));
  yield* fs.makeDirectory(`${dir}/bin`);
  yield* fs.writeFileString(
    `${dir}/shell`,
    `#!/bin/sh
[ "$1" = -lc ] && shift
PATH='${dir}/bin':'${tripwire.binDir}':"$PATH" exec /bin/sh -c "$@"
`,
    { mode: 0o755 },
  );
  const logPath = `${dir}/core.jsonl`;
  const core = yield* serveFakeHc(`${dir}/hc.sock`, logPath, yield* Effect.scope);
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

test("Go to pane attaches to the core terminal without needing a legacy pane", () =>
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

test("reconnecting asks the host again and attaches to the replacement core terminal", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, core, told } = yield* coreRig;
        const shell = Bun.env.SHELL;
        Bun.env.SHELL = `${dir}/shell`;
        yield* Effect.addFinalizer(() => Effect.sync(() => (Bun.env.SHELL = shell)));
        const route = localRoute([], "mk-pc");
        let terminal = "builder-1";
        let focused = 0;
        const focus = Effect.sync(() => {
          focused++;
          return { session: null, workspace: "builder", tab: null, core: terminal };
        });
        const visit = Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* openTerminal(focus, route, 80, 24);
            const shown = yield* shownAll(opened);
            expect(yield* Queue.take(shown)).toEqual({
              _tag: "Opened",
              at: { session: null, workspace: "builder", tab: null, core: terminal },
            });
            expect(drawn(yield* Queue.take(shown))).toContain(terminal);
            yield* opened.send({ type: "terminal.input", text: `${terminal}\r` });
            yield* told((entries) =>
              Arr.some(
                entries,
                (entry) =>
                  entry.cmd === "attach.data" &&
                  Schema.is(Schema.Struct({ terminal: Schema.Literal(terminal) }))(entry.params),
              ),
            );
          }),
        );
        yield* core.print(terminal, terminal);
        yield* visit;
        yield* core.exit(terminal, 0);
        terminal = "builder-2";
        yield* Effect.scoped(
          Effect.flatMap(connect(core.socketPath), (hc) =>
            hc.call("terminal.run", { name: terminal, argv: ["claude"], cwd: dir }),
          ),
        );
        yield* core.print(terminal, terminal);
        yield* visit;
        expect(focused).toBe(2);
        const said = yield* told(
          (entries) => Arr.filter(entries, (entry) => entry.cmd === "terminal.attach").length === 2,
        );
        expect(
          Arr.map(
            Arr.filter(said, (entry) => entry.cmd === "attach.data"),
            (entry) => entry.params,
          ),
        ).toEqual([
          { terminal: "builder-1", text: "builder-1\r" },
          { terminal: "builder-2", text: "builder-2\r" },
        ]);
      }),
    ).pipe(Effect.provide(BunServices.layer)),
  ));
