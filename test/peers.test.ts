// Two Machines reach each other over a paired link (ADR-0057): adding a Machine to herdr
// is all it takes, a command about a Run goes to the Machine that has it, and the host
// there records who asked and from where. Two real hosts, each with its own state
// directory and fake herdr, paired on 127.0.0.1.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import { createConnection, createServer, type Server } from "node:net";
import { Clock, Deferred, Effect, Exit, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { readEnv } from "../src/env";
import { findRun } from "../src/runs";
import { connect, connectPeer, ownerOf } from "../src/host";
import { certOf, certificateFor, keyOf, peersOf, relayOf } from "../src/peers";
import { runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { listenerPort, twoMachines, type Side } from "./support/peers";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Started = Schema.Struct({ runId: Schema.String });
const Shown = Schema.Record(Schema.String, Schema.Json);
const CallLine = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, argv: Schema.Array(Schema.String) }),
);

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(Effect.orDie);

/** What a fake agent answers each prompt with, so a Run gets as far as its question. */
const answering = (side: Side) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const outputs = `${side.world.home}/outputs.json`;
    yield* fs.writeFileString(
      outputs,
      encode(Array.from({ length: 4 }, () => ({ verdict: "done" }))),
    );
    return { FAKE_HERDR_OUTPUTS: outputs };
  }).pipe(Effect.orDie);

/** A Run of `attended` on `side`, waiting on its question with its agent alive. */
const waitingRun = (side: Side) =>
  Effect.gen(function* () {
    const extra = yield* answering(side);
    const started = yield* side.cli(
      ["run", "start", "attended", "--input", "work=the link"],
      extra,
    );
    expect(started.envelope.error).toBeUndefined();
    const { runId } = yield* Schema.decodeUnknownEffect(Started)(started.envelope.data).pipe(
      Effect.orDie,
    );
    const client = yield* connect(side.world.state).pipe(Effect.orDie);
    yield* until(
      () => client.run({ runId }).pipe(Effect.orDie),
      (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
    );
    return { runId, extra };
  });

const prompts = (side: Side) =>
  read(side.herdrLog).pipe(
    Effect.map((text) =>
      Arr.map(
        Arr.filter(
          Arr.map(
            Arr.filter(Str.split(text, "\n"), (line) => line !== ""),
            (line) => flow(Schema.decodeResult(CallLine), Result.getOrThrow)(line),
          ),
          (call) => call.cmd === "agent prompt",
        ),
        (call) => Arr.join(call.argv, " "),
      ),
    ),
  );

test("Bun's WebSocket trusts the certificate Collie makes, pinned as the only CA, and no other", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const one = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pin-" });
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pin-other-" });
      const certificate = yield* certificateFor(one, "127.0.0.1");
      const elsewhere = yield* certificateFor(other, "127.0.0.1");
      expect((yield* fs.stat(keyOf(one))).mode & 0o777).toBe(0o600);
      expect(yield* read(certOf(one))).toBe(certificate);
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert: certificate, key: yield* read(keyOf(one)) },
        fetch: (request, server) =>
          server.upgrade(request) ? undefined : new Response("", { status: 400 }),
        websocket: { message: (ws, message) => void ws.send(message) },
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));
      const dial = (ca: string) =>
        Effect.callback<string>((resume) => {
          const ws = new WebSocket(`wss://127.0.0.1:${server.port}/`, { tls: { ca } });
          ws.onopen = () => ws.send("hello");
          ws.onmessage = (event) => {
            resume(Effect.succeed(String(event.data)));
            ws.close();
          };
          ws.onerror = () => resume(Effect.succeed("refused"));
        });
      expect(yield* dial(certificate)).toBe("hello");
      expect(yield* dial(elsewhere)).toBe("refused");
    }).pipe(Effect.orDie),
  ));

test(
  "a command about a Run on a Machine herdr lists pairs the two by itself and reaches the Run, recorded as its front door from this Machine",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId } = yield* waitingRun(second);
            yield* first.lists([second]);

            const steered = yield* first.cli(["run", "steer", runId, "hello from the laptop"]);
            expect(steered.envelope.error).toBeUndefined();
            expect(steered.envelope.ok).toBe(true);
            expect(
              Arr.some(yield* prompts(second), (text) =>
                pipe_(text, Str.includes("hello from the laptop")),
              ),
            ).toBe(true);

            // The one connection was the pairing's, and its invite rode it.
            const calls = Str.split(yield* read(first.sshLog), "\n");
            expect(Arr.filter(calls, (line) => pipe_(line, Str.startsWith("master")))).toHaveLength(
              1,
            );
            expect(Arr.filter(calls, (line) => pipe_(line, Str.startsWith("login")))).toEqual([]);
            expect(
              Arr.some(
                calls,
                (line) =>
                  pipe_(line, Str.startsWith("ride")) && pipe_(line, Str.includes(" invite ")),
              ),
            ).toBe(true);

            const fs = yield* FileSystem.FileSystem;
            const firstPeers = yield* peersOf(first.world.state);
            const secondPeers = yield* peersOf(second.world.state);
            const firstId = Str.trim(yield* read(`${first.world.state}/installation`));
            const secondId = Str.trim(yield* read(`${second.world.state}/installation`));
            expect(firstPeers).toMatchObject([
              { installation: secondId, name: "second", dials: "out" },
            ]);
            expect(secondPeers).toMatchObject([{ installation: firstId, dials: "in" }]);
            for (const side of [first, second])
              expect((yield* fs.stat(`${side.world.state}/peers.json`)).mode & 0o777).toBe(0o600);

            const delivered = Option.getOrUndefined(
              Arr.findFirst(
                yield* readAudit(runDir(second.world.state, runId)).pipe(Effect.orDie),
                (line) => line.operation === "deliver",
              ),
            );
            expect(delivered?.actor.origin).toBe("cli");
            expect(delivered?.actor.from?.machine).toEqual({
              installation: firstId,
              name: secondPeers[0]!.name,
            });

            // A second command needs no connection of its own.
            const shown = yield* first.cli(["run", "show", runId]);
            expect(shown.envelope.error).toBeUndefined();
            const local = yield* second.cli(["run", "show", runId]);
            expect(shown.envelope.data).toEqual({
              ...(yield* Schema.decodeUnknownEffect(Shown)(local.envelope.data).pipe(Effect.orDie)),
              machine: "second",
            });
            expect(
              Arr.filter(
                Str.split(yield* read(first.sshLog), "\n"),
                (line) =>
                  pipe_(line, Str.startsWith("login")) || pipe_(line, Str.startsWith("master")),
              ),
            ).toEqual(["master mk@second"]);
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "finding a Run on another Machine asks that Machine's host",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-find-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId } = yield* waitingRun(second);
            yield* first.lists([second]);
            expect((yield* first.cli(["run", "show", runId])).envelope.error).toBeUndefined();

            const found = yield* findRun({ ...readEnv(first.env), machine: "second" }, runId);
            expect(found?.id).toBe(runId);
            expect(yield* findRun(readEnv(first.env), runId)).toBeNull();
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

/** A listener of another process's on this port, for as long as the scope lasts. */
const occupy = (port: string) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer();
      server.once("error", (cause) => resume(Effect.die(cause)));
      server.listen(Number(port), "0.0.0.0", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

test(
  "a port another process takes before any host starts is never the listener's, so pairing still succeeds",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-taken-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          }),
        [],
        { before: (ports) => Effect.forEach(Rec.values(ports), occupy, { discard: true }) },
      ),
    ),
  180_000,
);

/** Whether something accepts a connection on this port of 127.0.0.1. */
const listening = (port: string) =>
  Effect.callback<boolean>((resume) => {
    const conn = createConnection({ host: "127.0.0.1", port: Number(port) });
    conn.once("connect", () => {
      conn.destroy();
      resume(Effect.succeed(true));
    });
    conn.once("error", () => resume(Effect.succeed(false)));
  });

test(
  "a listener given port 0 keeps the port it got when it opens again, in a later host too, and invitations answer that port",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-reopen-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const port = yield* listenerPort(first, second);
            expect(yield* listening(port)).toBe(true);

            yield* first.lists([]);
            yield* stopHost(first.world.state);
            yield* first.cli(["machine", "list"]);
            yield* until(
              () => listening(port),
              (open) => !open,
            );

            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            expect(yield* listenerPort(first, second)).toBe(port);
            expect(yield* listening(port)).toBe(true);

            yield* stopHost(second.world.state);
            yield* second.cli(["machine", "list"]);
            yield* until(
              () => listening(port),
              (open) => open,
            );
          }),
        [],
      ),
    ),
  180_000,
);

/** A /proc table's rows, under its header line; none where the kernel has no such table (no IPv6). */
const procTable = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => Str.split(text, "\n").slice(1)),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
  );

test("a /proc table the kernel does not have is no rows, and any other read failure fails", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-proc-" });
      yield* fs.writeFileString(`${dir}/tcp`, "  sl  local_address\n   0: 0100007F:1F90\n");
      expect(yield* procTable(`${dir}/tcp`)).toEqual(["   0: 0100007F:1F90", ""]);
      expect(yield* procTable(`${dir}/tcp6`)).toEqual([]);
      expect(Exit.isFailure(yield* Effect.exit(procTable(dir)))).toBe(true);
    }),
  ));

/** The TCP ports a process listens on: its sockets among the kernel's listening ones. */
const listensOn = (pid: number, tables = ["/proc/net/tcp", "/proc/net/tcp6"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sockets = new Set<string>();
    for (const fd of yield* fs.readDirectory(`/proc/${pid}/fd`)) {
      const target = yield* fs
        .readLink(`/proc/${pid}/fd/${fd}`)
        .pipe(Effect.orElseSucceed(() => ""));
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode !== undefined) sockets.add(inode);
    }
    const ports: number[] = [];
    for (const table of tables) {
      for (const row of yield* procTable(table)) {
        // local_address, rem_address, st, …, inode; st 0A is LISTEN.
        const [, local, , state, , , , , , inode] = Str.split(Str.trim(row), /\s+/);
        if (state === "0A" && inode !== undefined && sockets.has(inode))
          ports.push(Number.parseInt(Str.split(local!, ":")[1]!, 16));
      }
    }
    return ports;
  }).pipe(Effect.orDie);

test.skipIf(process.platform !== "linux")(
  "a process's listening ports are found on a kernel without IPv6's table",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { port } = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Finite }))(
          (yield* occupy("0")).address(),
        ).pipe(Effect.orDie);
        const ports = yield* listensOn(process.pid, ["/proc/net/tcp", "/proc/net/no-such-table"]);
        expect(ports).toContain(port);
      }),
    ),
);

/** A WebSocket to a listener: open, or refused. */
const dialListener = (
  port: string,
  ca: string,
  headers: Readonly<Record<string, string>>,
  path = "/channel?as=cli&client=probe",
) =>
  Effect.callback<string>((resume) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}${path}`, {
      headers: { ...headers },
      tls: { ca },
    });
    ws.onopen = () => {
      resume(Effect.succeed("open"));
      ws.close();
    };
    ws.onerror = () => resume(Effect.succeed("refused"));
  });

test(
  "dial-back tickets are single-use, expire, belong to one installation, and a control link requires its secret",
  () =>
    runEffect(
      twoMachines(
        "collie-tickets-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const [peer] = yield* peersOf(first.world.state);
            const [laptop] = yield* peersOf(second.world.state);
            const port = yield* listenerPort(first, second);
            yield* stopHost(first.world.state);
            const ca = peer!.certificate!;
            const headers = { Authorization: `Bearer ${peer!.secret}` };
            expect(
              yield* dialListener(port, ca, { Authorization: "Bearer wrong" }, "/control"),
            ).toBe("refused");
            const other = yield* second.cli([
              "machine",
              "invite",
              "--for",
              "another-installation",
              "--name",
              "another",
            ]);
            const Other = Schema.Struct({ secret: Schema.String });
            const otherHeaders = {
              Authorization: `Bearer ${(yield* Schema.decodeUnknownEffect(Other)(other.envelope.data).pipe(Effect.orDie)).secret}`,
            };
            const minted = yield* Deferred.make<string>();
            const control = yield* Effect.acquireRelease(
              Effect.callback<WebSocket>((resume) => {
                const ws = new WebSocket(`wss://127.0.0.1:${port}/control`, {
                  headers,
                  tls: { ca },
                });
                ws.onopen = () => resume(Effect.succeed(ws));
                ws.onmessage = (event) => {
                  const Dial = Schema.fromJsonString(Schema.Struct({ dial: Schema.String }));
                  const dial = Schema.decodeUnknownOption(Dial)(event.data);
                  if (dial._tag === "Some")
                    Deferred.doneUnsafe(minted, Exit.succeed(dial.value.dial));
                };
              }),
              (ws) => Effect.sync(() => ws.close()),
            );
            const waiting = yield* Effect.forkScoped(
              relayAnswer(
                relayOf(second.world.state, laptop!.name),
                '{"as":"cli","client":"probe"}',
              ),
            );
            const ticket = yield* Deferred.await(minted);
            const path = `/reverse?ticket=${ticket}`;
            expect(yield* dialListener(port, ca, otherHeaders, path)).toBe("refused");
            expect(yield* dialListener(port, ca, headers, path)).toBe("open");
            expect(yield* dialListener(port, ca, headers, path)).toBe("refused");
            yield* Fiber.await(waiting);
            const expired = yield* Deferred.make<string>();
            control.onmessage = (event) => {
              const dial = Schema.decodeUnknownOption(
                Schema.fromJsonString(Schema.Struct({ dial: Schema.String })),
              )(event.data);
              if (dial._tag === "Some") Deferred.doneUnsafe(expired, Exit.succeed(dial.value.dial));
            };
            yield* Effect.forkScoped(
              relayAnswer(
                relayOf(second.world.state, laptop!.name),
                '{"as":"cli","client":"expiry"}',
              ),
            );
            const expires = yield* Deferred.await(expired);
            yield* Effect.sleep("10 seconds");
            expect(yield* dialListener(port, ca, headers, `/reverse?ticket=${expires}`)).toBe(
              "refused",
            );
          }),
        [],
      ),
    ),
  180_000,
);

/** One line written to a relay socket, and the line it answered with. */
const relayAnswer = (path: string, header: string) =>
  Effect.callback<string>((resume) => {
    const conn = createConnection(path);
    let said = "";
    conn.once("connect", () => conn.write(`${header}\n`));
    conn.on("data", (chunk) => {
      said += chunk.toString("utf8");
      if (pipe_(said, Str.includes("\n"))) conn.destroy();
    });
    conn.once("close", () => resume(Effect.succeed(Str.trim(said))));
  });

const Board = Schema.Struct({ tasks: Schema.Array(Schema.Struct({ id: Schema.String })) });
const NotFound = Schema.Struct({ machines: Schema.Array(Schema.String) });
test(
  "an invitation refuses a relay name that escapes its directory or exceeds a unix socket path",
  () =>
    runEffect(
      twoMachines(
        "collie-name-",
        (_, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const kept = `${second.world.state}/outside.sock`;
            yield* fs.writeFileString(kept, "kept");
            for (const name of ["../outside", pipe_("x", Str.repeat(105))]) {
              const refused = yield* second.cli([
                "machine",
                "invite",
                "--for",
                "invalid",
                "--name",
                name,
              ]);
              expect(refused.envelope.ok).toBe(false);
              expect(yield* fs.readFileString(kept)).toBe("kept");
              expect(yield* peersOf(second.world.state)).toHaveLength(0);
            }
          }),
        [],
      ),
    ),
  180_000,
);

const Machines = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
});

test(
  "an undialable Machine is reached by dial-back, reconnects without a login, and an away Machine is refused within five seconds",
  () =>
    runEffect(
      twoMachines(
        "collie-reverse-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId, extra } = yield* waitingRun(first);
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const [laptop] = yield* peersOf(second.world.state);
            const state = (side: Side, name: string) =>
              side
                .cli(["machine", "list"])
                .pipe(
                  Effect.map(
                    (read) =>
                      Option.getOrUndefined(
                        Arr.findFirst(
                          flow(
                            Schema.decodeUnknownResult(Machines),
                            Result.getOrThrow,
                          )(read.envelope.data).machines,
                          (one) => one.name === name,
                        ),
                      )?.state,
                  ),
                );
            yield* until(
              () => state(second, laptop!.name),
              (state) => state === "live",
            );
            expect((yield* second.cli(["--machine", laptop!.name, "board"])).envelope.ok).toBe(
              true,
            );
            expect(
              (yield* second.cli(["run", "steer", runId, "hello by dial-back"])).envelope.ok,
            ).toBe(true);
            expect(
              Arr.some(yield* prompts(first), (text) =>
                pipe_(text, Str.includes("hello by dial-back")),
              ),
            ).toBe(true);
            const audit = yield* readAudit(runDir(first.world.state, runId)).pipe(Effect.orDie);
            expect(
              Option.getOrUndefined(Arr.findFirst(audit, (line) => line.operation === "deliver"))
                ?.actor.from?.machine?.name,
            ).toBe("second");
            const started = yield* second.cli(
              ["--machine", laptop!.name, "run", "start", "attended", "--input", "work=reverse"],
              extra,
            );
            expect(started.envelope.error).toBeUndefined();

            const [dialled] = yield* peersOf(first.world.state);
            yield* Effect.callback<void>((resume) => {
              const ws = new WebSocket(`${dialled!.url}/control`, {
                headers: { Authorization: `Bearer ${dialled!.secret}` },
                tls: { ca: dialled!.certificate },
              });
              ws.onclose = () => resume(Effect.void);
              ws.onerror = () => resume(Effect.die("the replacement control link was refused"));
              return Effect.sync(() => ws.close());
            }).pipe(Effect.timeout("5 seconds"));
            yield* until(
              () => state(second, laptop!.name),
              (state) => state === "live",
            );
            expect((yield* second.cli(["--machine", laptop!.name, "board"])).envelope.ok).toBe(
              true,
            );

            yield* stopHost(first.world.state);
            yield* until(
              () => state(second, laptop!.name),
              (state) => state === "away",
            );
            const at = yield* Clock.currentTimeMillis;
            const away = yield* second.cli(["--machine", laptop!.name, "board"]);
            expect(away.envelope.error?.code).toBe("machine_unreachable");
            expect((yield* Clock.currentTimeMillis) - at).toBeLessThan(5000);
            yield* first.cli(["machine", "list"]);
            yield* until(
              () => state(second, laptop!.name),
              (state) => state === "live",
            );
            expect((yield* second.cli(["--machine", laptop!.name, "board"])).envelope.ok).toBe(
              true,
            );

            yield* stopHost(second.world.state);
            yield* until(
              () => state(first, "second"),
              (state) => state === "connecting",
            );
            yield* second.cli(["machine", "list"]);
            yield* until(
              () => state(first, "second"),
              (state) => state === "live",
            );
            expect((yield* second.cli(["--machine", laptop!.name, "board"])).envelope.ok).toBe(
              true,
            );
            expect(
              Arr.filter(
                Str.split(yield* read(first.sshLog), "\n"),
                (line) =>
                  pipe_(line, Str.startsWith("login")) || pipe_(line, Str.startsWith("master")),
              ),
            ).toEqual(["master mk@second"]);
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "across Machines a Run is answered and stopped, and --machine reaches the board and a start, with the envelopes they give at home",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-across-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId, extra } = yield* waitingRun(second);
            yield* first.lists([second]);

            const answered = yield* first.cli(["run", "answer", runId, "yes", "--decision", "go"]);
            expect(answered.envelope.error).toBeUndefined();
            const firstId = Str.trim(yield* read(`${first.world.state}/installation`));
            expect(answered.envelope.data).toMatchObject({
              run: runId,
              decision: "go",
              value: "yes",
            });

            const board = yield* first.cli(["--machine", "second", "board"]);
            const home = yield* second.cli(["board"]);
            expect(board.envelope.ok).toBe(true);
            const ids = (envelope: { readonly data?: unknown }) =>
              Arr.map(
                flow(Schema.decodeUnknownResult(Board), Result.getOrThrow)(envelope.data).tasks,
                (task) => task.id,
              );
            expect(ids(board.envelope)).toEqual(ids(home.envelope));

            const started = yield* first.cli(
              ["--machine", "second", "run", "start", "attended", "--input", "work=from afar"],
              extra,
            );
            expect(started.envelope.error).toBeUndefined();
            expect(
              Rec.keys(
                yield* Schema.decodeUnknownEffect(Shown)(started.envelope.data).pipe(Effect.orDie),
              ).sort(),
            ).toEqual(["fresh", "registration", "requestId", "runId", "workflow"].sort());
            const other = (yield* Schema.decodeUnknownEffect(Started)(started.envelope.data).pipe(
              Effect.orDie,
            )).runId;
            const listed = yield* second.cli(["run", "list"]);
            expect(encode(listed.envelope.data)).toContain(other);

            const stopped = yield* first.cli(["run", "stop", other]);
            expect(stopped.envelope.error).toBeUndefined();
            const trail = yield* readAudit(runDir(second.world.state, other)).pipe(Effect.orDie);
            for (const line of Arr.filter(trail, (one) =>
              ["start", "stop"].includes(one.operation),
            ))
              expect(line.actor.from?.machine?.installation).toBe(firstId);
            const answerLine = Option.getOrUndefined(
              Arr.findFirst(
                yield* readAudit(runDir(second.world.state, runId)).pipe(Effect.orDie),
                (line) => line.operation === "answer",
              ),
            );
            expect(answerLine?.actor).toMatchObject({
              origin: "cli",
              from: { machine: { installation: firstId } },
            });
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a dial-back refused because its ticket expired is in the dialling host's log",
  () =>
    runEffect(
      twoMachines(
        "collie-dialfail-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const [laptop] = yield* peersOf(second.world.state);
            const relay = relayOf(second.world.state, laptop!.name);
            // A dial-back that works first, so the link was heard just before it is frozen.
            yield* until(
              () => relayAnswer(relay, '{"as":"cli","client":"probe"}'),
              (said) => pipe_(said, Str.includes('"ok":true')),
            );
            const owner = yield* ownerOf(first.world.state);
            process.kill(owner!.pid, "SIGSTOP");
            const resumed = Effect.sync(() => process.kill(owner!.pid, "SIGCONT"));
            yield* Effect.gen(function* () {
              yield* relayAnswer(relay, '{"as":"cli","client":"late"}');
              // Past the ticket's life, so the dial-back the frozen host makes is refused.
              yield* Effect.sleep("6 seconds");
            }).pipe(Effect.ensuring(resumed));
            const logged = yield* until(
              () => read(`${first.world.state}/host.log`),
              (log) => pipe_(log, Str.includes("dial-back to second failed")),
            );
            expect(
              Option.getOrUndefined(
                Arr.findFirst(Str.split(logged, "\n"), (line) =>
                  pipe_(line, Str.includes("dial-back to second failed")),
                ),
              ),
            ).toContain("level=WARN");
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "a listener lets in only its paired installation over its own certificate, a relay only a front door, and a far host of another build is refused, left running",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-refused-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId } = yield* waitingRun(second);
            // A host nobody dials listens on nothing but its socket.
            expect(yield* peersOf(first.world.state)).toEqual([]);
            if (process.platform === "linux") {
              const host = yield* ownerOf(second.world.state);
              expect(yield* listensOn(host!.pid)).toEqual([]);
            }
            yield* first.lists([second]);
            expect((yield* first.cli(["run", "show", runId])).envelope.ok).toBe(true);
            const port = yield* listenerPort(first, second);
            expect(yield* listening(port)).toBe(true);

            const [paired] = yield* peersOf(first.world.state);
            const ca = paired!.certificate!;
            expect(
              yield* dialListener(port, ca, { Authorization: `Bearer ${paired!.secret}` }),
            ).toBe("open");
            expect(yield* dialListener(port, ca, { Authorization: "Bearer not-the-secret" })).toBe(
              "refused",
            );
            expect(yield* dialListener(port, ca, {})).toBe("refused");
            const fs = yield* FileSystem.FileSystem;
            const elsewhere = yield* certificateFor(
              yield* fs.makeTempDirectoryScoped({ prefix: "collie-pin-elsewhere-" }),
              "127.0.0.1",
            );
            expect(
              yield* dialListener(port, elsewhere, { Authorization: `Bearer ${paired!.secret}` }),
            ).toBe("refused");

            const relay = relayOf(first.world.state, "second");
            expect(yield* relayAnswer(relay, '{"as":"nobody","client":"x"}')).toContain("refused");
            expect(yield* relayAnswer(relay, '{"as":"host","client":"x"}')).toContain(
              "only this Machine's host speaks as host",
            );

            const local = yield* connect(second.world.state).pipe(Effect.orDie);
            const claimed = yield* local
              .declare({ frontDoor: "cli", from: { machine: { installation: "x", name: "y" } } })
              .pipe(Effect.flip);
            expect(claimed._tag).toBe("HostRefused");

            const before = yield* ownerOf(second.world.state);
            const mismatch = yield* Effect.scoped(
              connectPeer(
                first.world.state,
                "second",
                { as: "cli", client: "probe" },
                { build: "0.0.0-elsewhere" },
              ),
            ).pipe(Effect.flip);
            expect(mismatch._tag).toBe("HostVersionMismatch");
            if (mismatch._tag === "HostVersionMismatch") {
              expect(mismatch.client).toBe("0.0.0-elsewhere");
              expect(mismatch.restart).toContain(mismatch.host);
            }
            expect((yield* ownerOf(second.world.state))?.pid).toBe(before?.pid);

            const nowhere = yield* first.cli(["run", "show", "run-nowhere"]);
            expect(nowhere.envelope.error?.code).toBe("run_not_found");
            const asked = (yield* Schema.decodeUnknownEffect(NotFound)(
              nowhere.envelope.error?.details,
            ).pipe(Effect.orDie)).machines;
            expect(asked).toHaveLength(2);
            expect(asked).toContain("second");
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);

test(
  "a Machine herdr no longer lists is forgotten on both sides when the host that dials it starts, and the other stops listening",
  () =>
    runEffect(
      twoMachines(
        "collie-peers-forget-",
        (first, second) =>
          Effect.gen(function* () {
            const { runId } = yield* waitingRun(second);
            yield* first.lists([second]);
            expect((yield* first.cli(["run", "show", runId])).envelope.ok).toBe(true);
            expect(yield* peersOf(second.world.state)).toHaveLength(1);
            const port = yield* listenerPort(first, second);

            yield* first.lists([]);
            const { stopHost } = yield* Effect.promise(() => import("./support/host"));
            yield* stopHost(first.world.state);
            yield* first.cli(["machine", "list"]);
            yield* until(
              () => Effect.all([peersOf(first.world.state), peersOf(second.world.state)]),
              ([mine, theirs]) => mine.length === 0 && theirs.length === 0,
            );
            yield* until(
              () => listening(port),
              (open) => !open,
            );
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);
