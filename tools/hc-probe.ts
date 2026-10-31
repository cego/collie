// The live probe: `src/hc.ts`'s decoders against the real `hc` that `hc-pin.json` names.
// The contract test compares the decoders with the schema; only this catches a core that
// sends less than its schema promises (hc 0.1.14's `terminal.list` without `machines`).
//
//   bun run probe:hc
//   bun tools/hc-probe.ts --harness claude|codex|pi
//   bun tools/hc-probe.ts --harness opencode [--no-reporter]
//
// It downloads and checksums the pinned release, starts it on a session of its own with
// scratch XDG directories, and drives run, list, get, read, send, keys, events and attach.
// With `--harness`, it instead starts that harness in a core terminal and sends it a prompt
// as Collie does, then passes once the prompt arrived without core's `<hc from>` mark and
// the harness answered it, reporting `idle`, `working` and `done` through OSC 7501. It runs
// the installed harness, with no tool it would need to answer, and costs one turn of its model.
// OpenCode runs as Collie launches it on core: two agents in one checkout, each with Collie's
// reporter and its first prompt at launch. Each must report working then idle, one must act
// on a second prompt sent as Collie does, each reporter must write its own agent's session,
// and OpenCode's settings files must not change. `--no-reporter` leaves the reporter out,
// and fails for want of status. OpenCode's store is a scratch one, so it uses its free model.
// Then it stops that core, and fails if a process of the binary is still running or core's
// default state, config or runtime directory changed.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Config,
  Console,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Layer,
  Queue,
  Runtime,
  Schema,
  Stream,
} from "effect";
import * as Digest from "effect/crypto/Digest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  applyNote,
  connect,
  Kind,
  snapshotOf,
  type HcConnection,
  type HcNote,
  type HcReply,
} from "../src/hc";
import { opencodeReporter } from "../src/harness";
import { claudeTrust } from "../src/trust";

const ROOT = new URL("..", import.meta.url).pathname;
const Pin = Schema.Struct({
  version: Schema.String,
  sha256: Schema.Record(Schema.String, Schema.String),
});

const fail = (message: string) => Effect.fail(new Cause.UnknownError(message, message));

/** The release target names hc uses, for the platforms Collie ships. */
const target = () => {
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
};

/** Downloads the pinned archive, checks it against the pin, and unpacks `herdr-core` into `dir`. */
const fetchPinned = Effect.fn("HcProbe.fetchPinned")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const pin = yield* Schema.decodeEffect(Schema.fromJsonString(Pin))(
    yield* fs.readFileString(`${ROOT}hc-pin.json`),
  );
  const on = target();
  const want = pin.sha256[on];
  if (want === undefined) return yield* fail(`hc-pin.json pins no hc for ${on}`);
  const url = `https://releases.herdr.dev/core/${pin.version}/herdr-core-${on}.tar.gz`;
  const response = yield* HttpClient.get(url);
  if (response.status !== 200) return yield* fail(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(yield* response.arrayBuffer);
  const got = yield* digest.digestHex(Digest.sha256, bytes);
  if (got !== want) return yield* fail(`${url} hashed ${got}, but hc-pin.json says ${want}`);
  yield* fs.writeFile(`${dir}/hc.tar.gz`, bytes);
  yield* run("tar", ["-xzf", `${dir}/hc.tar.gz`, "-C", dir, "herdr-core"], {});
  yield* Console.error(`hc ${pin.version} ${on} sha256 ${got}`);
  return `${dir}/herdr-core`;
});

const run = Effect.fn("HcProbe.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      env,
      cwd,
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (code !== 0) return yield* fail(`${command} ${Arr.join(args, " ")} exited ${code}: ${stderr}`);
  return stdout;
}, Effect.scoped);

/**
 * Every entry under each of `dirs`, by name and type: what a probe leaking into them would
 * add or remove. Not contents, which a live core on the same Machine changes by itself.
 */
const fingerprint = Effect.fn("HcProbe.fingerprint")(function* (dirs: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const lines: string[] = [];
  for (const dir of dirs) {
    if (!(yield* fs.exists(dir))) {
      lines.push(`${dir} absent`);
      continue;
    }
    for (const name of (yield* fs.readDirectory(dir, { recursive: true })).sort()) {
      const info = yield* fs.stat(`${dir}/${name}`);
      lines.push(`${dir}/${name} ${info.type}`);
    }
  }
  return lines;
});

/** Pids whose executable is `binary`, read from /proc where there is one. */
const runningFrom = Effect.fn("HcProbe.runningFrom")(function* (binary: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists("/proc/self/exe"))) return [];
  const pids = Arr.filter(yield* fs.readDirectory("/proc"), (name) => /^\d+$/.test(name));
  const running: string[] = [];
  for (const pid of pids) {
    const exe = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.orElseSucceed(() => ""));
    if (exe === binary || exe === `${binary} (deleted)`) running.push(pid);
  }
  return running;
});

const within = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => fail(`timed out waiting for ${what}`),
    }),
  );

const expect = (ok: boolean, what: string) => (ok ? Effect.void : fail(`expected ${what}`));

const untilRead = (hc: HcConnection, terminal: string, line: string) =>
  within(
    `${terminal} to print ${line}`,
    Effect.gen(function* () {
      for (;;) {
        const read = yield* hc.call("terminal.read", { terminal });
        if (Arr.some(pipe(read.text, Str.split("\n")), (l) => Str.trimEnd(l) === line)) return read;
        yield* Effect.sleep("100 millis");
      }
    }),
  );

const plain = Effect.fn("HcProbe.plain")(function* (socket: string, cwd: string) {
  const events = yield* connect(socket);
  yield* events.call("hello", { generation: 1 });
  const subscribed: HcReply<"events.subscribe"> = yield* events.call("events.subscribe", {});

  const api = yield* connect(socket);
  const hello = yield* api.call("hello", { generation: 1 });
  yield* expect(hello.generation === 1 && !hello.framed, "a plain hello at generation 1");

  const echo = yield* api.call("terminal.run", {
    argv: ["sh", "-c", 'echo ready; read line; echo "got: $line"'],
    name: "probe-echo",
    cwd,
    no_parent: true,
  });
  const list = yield* api.call("terminal.list", {});
  yield* expect(
    Arr.some(list.terminals, (t) => t.address === echo.address),
    "the new terminal in terminal.list",
  );
  yield* api.call("terminal.get", { terminal: echo.address });
  yield* untilRead(api, echo.address, "ready");
  yield* api.call("terminal.send", { terminal: echo.address, text: "hello" });

  const notes: HcNote[] = [];
  yield* within(
    `${echo.address} to finish`,
    Effect.gen(function* () {
      for (;;) {
        const note = yield* Queue.take(events.notes);
        notes.push(note);
        if (
          note.method === "event" &&
          note.params.type === "finished" &&
          note.params.terminal === echo.address
        )
          return;
      }
    }),
  );
  yield* untilRead(api, echo.address, "got: hello");
  const final = yield* api.call("terminal.get", { terminal: echo.address });
  const seen = Arr.reduce(notes, snapshotOf(subscribed), applyNote).terminals.get(echo.address);
  yield* expect(
    seen?.state === "finished" &&
      seen.exit_code === 0 &&
      final.state === "finished" &&
      final.exit_code === 0,
    "the snapshot built from events to agree with terminal.get",
  );

  const keyed = yield* api.call("terminal.run", {
    argv: ["sh", "-c", 'read line; echo "keys: $line"'],
    name: "probe-keys",
    cwd,
    no_parent: true,
  });
  yield* api.call("terminal.keys", { terminal: keyed.address, keys: ["o", "k", "enter"] });
  yield* untilRead(api, keyed.address, "keys: ok");
});

const framed = Effect.fn("HcProbe.framed")(function* (socket: string, cwd: string) {
  const viewer = yield* connect(socket);
  const hello = yield* viewer.call("hello", { generation: 1, framed: true });
  yield* expect(hello.framed, "hello to switch to framed mode");
  const target = yield* viewer.call("terminal.run", {
    argv: ["sh", "-c", 'echo paint-marker; read keys; echo "keys: $keys"; stty size; exit 3'],
    name: "probe-attach",
    cwd,
    no_parent: true,
  });
  yield* untilRead(viewer, target.address, "paint-marker");
  const attach = yield* viewer.call("terminal.attach", {
    terminal: target.address,
    cols: 80,
    rows: 24,
  });
  const frames = yield* viewer.channel(attach.channel);
  const decoder = new TextDecoder();
  let output = "";
  let close: Uint8Array | undefined;
  const until = (what: string, done: () => boolean) =>
    within(
      what,
      Effect.gen(function* () {
        while (!done()) {
          const frame = yield* Queue.take(frames);
          if (frame.kind === Kind.DATA) output += decoder.decode(frame.payload);
          if (frame.kind === Kind.CLOSE) close = frame.payload;
        }
      }),
    );
  yield* until("the first paint", () => pipe(output, Str.includes("paint-marker")));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint16(0, 100, true);
  new DataView(size.buffer).setUint16(2, 30, true);
  yield* viewer.send(attach.channel, Kind.RESIZE, size);
  yield* viewer.send(attach.channel, Kind.DATA, new TextEncoder().encode("abc\r"));
  yield* until("CLOSE", () => close !== undefined);
  const reason = decoder.decode(close);
  yield* expect(
    pipe(output, Str.includes("keys: abc")),
    `the keys sent to reach the program, in ${output}`,
  );
  yield* expect(pipe(output, Str.includes("30 100")), "the resize to reach the program's terminal");
  yield* expect(
    /"reason":"exited"/.test(reason) && /"exit_code":3/.test(reason),
    `CLOSE exited 3, not ${reason}`,
  );
});

/** How each harness starts as an interactive agent that answers in text and asks nothing. */
const harnessArgv = (name: string) => {
  switch (name) {
    case "claude":
      return ["claude", "--tools", ""];
    case "codex":
      return [
        "codex",
        "--no-daemon",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
      ];
    case "pi":
      return ["pi"];
    default:
      return undefined;
  }
};

// The answer is not in the prompt, so seeing it shows the harness acted on what it was sent.
const ANSWER = "DETCA";
const PROMPT = "Reply with the word acted spelled backwards in capital letters, and nothing else.";
const TURN_SECONDS = 300;

const harness = Effect.fn("HcProbe.harness")(function* (socket: string, cwd: string, name: string) {
  const argv = harnessArgv(name);
  if (argv === undefined) return yield* fail(`no harness ${name}: claude, codex or pi`);
  // As Collie's launch does, so Claude opens at its prompt and not its folder-trust dialog.
  if (name === "claude") {
    const granted = yield* claudeTrust(yield* Config.String("HOME"), `${cwd}/..`).grant(cwd);
    if (!granted.ok) return yield* fail(granted.message);
  }
  const events = yield* connect(socket);
  yield* events.call("hello", { generation: 1 });
  let snapshot = snapshotOf(yield* events.call("events.subscribe", {}));
  const api = yield* connect(socket);
  yield* api.call("hello", { generation: 1 });

  const agent = yield* api.call("terminal.run", {
    argv,
    name: `probe-${name}`,
    cwd,
    no_parent: true,
    env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const words: string[] = [];
  const statusOf = () => snapshot.terminals.get(agent.address)?.status?.state ?? null;
  const screen = api
    .call("terminal.read", { terminal: agent.address })
    .pipe(Effect.map((read) => read.text));
  const until = <E>(what: string, done: () => Effect.Effect<boolean, E>) =>
    Effect.gen(function* () {
      while (!(yield* done())) {
        snapshot = applyNote(snapshot, yield* Queue.take(events.notes));
        const word = statusOf();
        if (word !== null && words.at(-1) !== word) words.push(word);
        if (word === "blocked" || word === "error")
          return yield* fail(`${name} reported ${word}:\n${yield* screen}`);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(TURN_SECONDS),
        orElse: () =>
          Effect.flatMap(screen, (text) =>
            fail(
              `timed out waiting for ${what}; ${name} reported ${Arr.join(words, ", ")}:\n${text}`,
            ),
          ),
      }),
    );

  yield* until(`${name} to report idle`, () => Effect.succeed(statusOf() === "idle"));
  const before = words.length;
  const sent = yield* api.call("terminal.send", { terminal: agent.address, text: PROMPT });
  yield* Console.error(`${name}: sent as turn ${sent.turn}, started ${String(sent.started)}`);
  yield* until(`${name} to answer and report done`, () =>
    Effect.gen(function* () {
      const after = words.slice(before);
      return (
        after.includes("working") &&
        after.includes("done") &&
        pipe(yield* screen, Str.includes(ANSWER))
      );
    }),
  );
  const shown = yield* screen;
  yield* Console.error(`${name}: reported ${Arr.join(words, ", ")}; answered ${ANSWER}`);
  // A TUI wraps and indents a long line, so the prompt is looked for with its spacing evened out.
  const even = (text: string) => pipe(text, Str.replace(/\s+/g, " "));
  yield* expect(
    pipe(even(shown), Str.includes(even(PROMPT))),
    `${name}'s screen to show the prompt:\n${shown}`,
  );
  // Measured on 0.1.14: a plain send is not marked. A pin that marks it is the planner's question.
  yield* expect(
    !pipe(shown, Str.includes("<hc from")),
    `${name}'s screen to show the prompt without core's <hc from> mark:\n${shown}`,
  );
  yield* api.call("terminal.kill", { terminal: agent.address });
});

/**
 * Each OpenCode agent's first prompt, given at launch, and the answer that shows it acted.
 * Its free model misspells a word spelled backwards, so these are facts it gets right.
 */
const capital = (country: string, answer: string) => ({
  prompt: `Reply with the capital of ${country} in capital letters, and nothing else.`,
  answer,
});
const FIRST = [capital("France", "PARIS"), capital("Italy", "ROME")];
const SECOND = capital("Spain", "MADRID");
const OPENCODE_SETTINGS = [
  "opencode.json",
  "opencode.jsonc",
  "config.json",
  "tui.json",
  "tui.jsonc",
  "cli.json",
];
const OpenCodeContent = Schema.fromJsonString(
  Schema.Struct({ plugin: Schema.Array(Schema.String) }),
);
const OpenCodeExport = Schema.Struct({
  info: Schema.Struct({ id: Schema.String, parentID: Schema.optionalKey(Schema.String) }),
  messages: Schema.Array(
    Schema.Struct({
      info: Schema.Struct({ role: Schema.String }),
      parts: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});

const opencode = Effect.fn("HcProbe.opencode")(function* (
  socket: string,
  dir: string,
  reporter: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Config.String("HOME");
  const configHome = `${home}/.config`;
  const settings = Effect.forEach(OPENCODE_SETTINGS, (name) =>
    fs
      .readFileString(`${configHome}/opencode/${name}`)
      .pipe(Effect.orElseSucceed(() => `${name} absent`)),
  );
  const before = yield* settings;
  const cwd = `${dir}/work`;
  // The operator's settings, and a store of the probe's own.
  const openEnv = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: `${dir}/opencode-data`,
  };
  const events = yield* connect(socket);
  yield* events.call("hello", { generation: 1 });
  let snapshot = snapshotOf(yield* events.call("events.subscribe", {}));
  const api = yield* connect(socket);
  yield* api.call("hello", { generation: 1 });

  const agents = yield* Effect.forEach(FIRST, (first, at) =>
    Effect.gen(function* () {
      const name = `probe-opencode-${at + 1}`;
      const sessionFile = `${dir}/${name}.session`;
      const plugin = `${dir}/${name}.status.js`;
      yield* fs.writeFileString(plugin, opencodeReporter({ sessionFile, tty: "/dev/tty" }));
      const content = yield* Schema.encodeEffect(OpenCodeContent)({ plugin: [`file://${plugin}`] });
      const env = reporter ? { ...openEnv, OPENCODE_CONFIG_CONTENT: content } : openEnv;
      const started = yield* api.call("terminal.run", {
        argv: ["opencode", "--prompt", first.prompt],
        name,
        cwd,
        no_parent: true,
        env,
      });
      return { name, address: started.address, sessionFile, first };
    }),
  );
  const words = new Map<string, string[]>(Arr.map(agents, (one) => [one.address, []]));
  const screen = (address: string) =>
    api.call("terminal.read", { terminal: address }).pipe(Effect.map((read) => read.text));
  const until = <E>(what: string, done: () => Effect.Effect<boolean, E>) =>
    Effect.gen(function* () {
      while (!(yield* done())) {
        snapshot = applyNote(snapshot, yield* Queue.take(events.notes));
        for (const [address, seen] of words) {
          const word = snapshot.terminals.get(address)?.status?.state ?? null;
          if (word !== null && seen.at(-1) !== word) seen.push(word);
          if (word === "blocked" || word === "error")
            return yield* fail(`${address} reported ${word}:\n${yield* screen(address)}`);
        }
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(TURN_SECONDS),
        orElse: () =>
          Effect.gen(function* () {
            const shown = yield* Effect.forEach(agents, (one) =>
              Effect.map(
                screen(one.address),
                (text) =>
                  `${one.name} reported ${Arr.join(reported(one.address), ", ") || "no status"}:\n${text}`,
              ),
            );
            return yield* fail(`timed out waiting for ${what}\n${Arr.join(shown, "\n")}`);
          }),
      }),
    );
  const reported = (address: string, from = 0) => (words.get(address) ?? []).slice(from);
  const workedThenIdle = (seen: ReadonlyArray<string>) =>
    seen.includes("working") && seen.lastIndexOf("idle") > seen.indexOf("working");

  // Settled by the screen, not by status, so a run without the reporter still gets this far.
  yield* until("each agent to answer its first prompt", () =>
    Effect.gen(function* () {
      for (const one of agents)
        if (!pipe(yield* screen(one.address), Str.includes(one.first.answer))) return false;
      return Arr.every(agents, (one) => workedThenIdle(reported(one.address)) || !reporter);
    }),
  );
  for (const one of agents) {
    const seen = reported(one.address);
    yield* Console.error(
      `${one.name}: answered ${one.first.answer}; reported ${Arr.join(seen, ", ") || "no status"}`,
    );
    yield* expect(workedThenIdle(seen), `${one.name} to report working, then idle`);
  }

  const [first] = agents;
  const after = reported(first!.address).length;
  const sent = yield* api.call("terminal.send", { terminal: first!.address, text: SECOND.prompt });
  yield* Console.error(
    `${first!.name}: sent as turn ${sent.turn}, started ${String(sent.started)}`,
  );
  yield* until(`${first!.name} to act on the sent prompt`, () =>
    Effect.gen(function* () {
      return (
        workedThenIdle(reported(first!.address, after)) &&
        pipe(yield* screen(first!.address), Str.includes(SECOND.answer))
      );
    }),
  );
  const shown = yield* screen(first!.address);
  const even = (text: string) => pipe(text, Str.replace(/\s+/g, " "));
  yield* expect(
    pipe(even(shown), Str.includes(even(SECOND.prompt))),
    `${first!.name}'s screen to show the sent prompt:\n${shown}`,
  );
  yield* expect(
    !pipe(shown, Str.includes("<hc from")),
    `${first!.name}'s screen to show the sent prompt without core's <hc from> mark:\n${shown}`,
  );
  yield* Console.error(`${first!.name}: acted on the sent prompt, answering ${SECOND.answer}`);

  const sessions = yield* Effect.forEach(agents, (one) =>
    Effect.gen(function* () {
      const id = yield* fs.readFileString(one.sessionFile);
      const exported = yield* run(
        "opencode",
        ["export", id],
        { PATH: yield* Config.String("PATH"), HOME: home, ...openEnv },
        cwd,
      );
      const session = yield* Schema.decodeEffect(Schema.fromJsonString(OpenCodeExport))(exported);
      const asked = pipe(
        Arr.findFirst(session.messages, (message) => message.info.role === "user"),
        Option.flatMap((message) => Arr.findFirst(message.parts, (part) => part.type === "text")),
        Option.flatMap((part) => Option.fromNullishOr(part.text)),
        Option.getOrUndefined,
      );
      yield* Console.error(`${one.name}: recorded session ${id}, opened on: ${asked ?? "nothing"}`);
      yield* expect(
        session.info.id === id && session.info.parentID === undefined && asked === one.first.prompt,
        `${one.name}'s recorded session to be the one OpenCode opened on its first prompt`,
      );
      return id;
    }),
  );
  yield* expect(new Set(sessions).size === agents.length, "each agent to record its own session");
  yield* expect(
    Arr.join(before, "\0") === Arr.join(yield* settings, "\0"),
    "OpenCode's settings files to be the same before and after",
  );
  for (const one of agents) yield* api.call("terminal.kill", { terminal: one.address });
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* Config.String("HOME");
  const xdg = (name: string, fallback: string) =>
    Config.String(name).pipe(Config.withDefault(fallback));
  const uid = process.getuid?.() ?? 0;
  const defaults = [
    `${yield* xdg("XDG_STATE_HOME", `${home}/.local/state`)}/herdr-core`,
    `${yield* xdg("XDG_CONFIG_HOME", `${home}/.config`)}/herdr-core`,
    `${yield* xdg("XDG_RUNTIME_DIR", `/run/user/${uid}`)}/herdr-core`,
  ];
  const before = yield* fingerprint(defaults);

  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hc-probe-" });
  for (const sub of ["state", "config", "run"])
    yield* fs.makeDirectory(`${dir}/${sub}`, { mode: 0o700 });
  const binary = yield* fetchPinned(dir);
  const socket = `${dir}/run/hc.sock`;
  // Only what hc and the probe's shells need: nothing that names a live core, herdr or agent.
  const env = {
    PATH: yield* Config.String("PATH"),
    HOME: home,
    HC_SESSION: "collie-probe",
    HC_SOCKET: socket,
    XDG_STATE_HOME: `${dir}/state`,
    XDG_CONFIG_HOME: `${dir}/config`,
    XDG_RUNTIME_DIR: `${dir}/run`,
  };

  const probed = yield* Effect.exit(
    Effect.gen(function* () {
      yield* run(binary, ["server", "start", "--json"], env);
      const at = process.argv.indexOf("--harness");
      if (at >= 0) {
        yield* fs.makeDirectory(`${dir}/work`);
        const name = process.argv[at + 1] ?? "";
        yield* (
          name === "opencode"
            ? opencode(socket, dir, !process.argv.includes("--no-reporter"))
            : harness(socket, `${dir}/work`, name)
        ).pipe(Effect.scoped);
        return;
      }
      yield* plain(socket, dir).pipe(Effect.scoped);
      yield* framed(socket, dir).pipe(Effect.scoped);
    }),
  );
  yield* run(binary, ["server", "stop", "--json"], env).pipe(Effect.ignore);
  const left = yield* runningFrom(binary);
  for (const pid of left) process.kill(Number(pid));
  const after = yield* fingerprint(defaults);

  const problems = [
    ...(Exit.isFailure(probed) ? [`probe: ${Cause.pretty(probed.cause)}`] : []),
    ...Arr.map(left, (pid) => `pid ${pid} still ran ${binary} after the core stopped`),
    ...Arr.map(
      Arr.difference(after, before),
      (line) => `core's default directories gained ${line}`,
    ),
    ...Arr.map(Arr.difference(before, after), (line) => `core's default directories lost ${line}`),
  ];
  for (const problem of problems) yield* Console.error(problem);
  yield* Console.error(problems.length === 0 ? "probe: every reply decoded" : "probe: FAILED");
  return problems.length === 0 ? 0 : 1;
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
    Effect.provide(Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto, FetchHttpClient.layer)),
  ),
  {
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit)
        ? onExit(exit.value === 0 ? 0 : 1)
        : Runtime.defaultTeardown(exit, onExit),
  },
);
