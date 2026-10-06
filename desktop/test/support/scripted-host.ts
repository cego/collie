// A Machine's host as Desktop meets it, behind a bridge: login-shell noise, the ready
// marker, then `FrontDoorRpcs` over stdio. Its installation, Herds and TaskViews are
// whatever the file named first on its command line holds, read again every 100 ms.
// Every operation it is asked is appended to `<board.json>.ops.jsonl`; an answer also
// takes the decision off its Task, as a host's would. Run as `--json upgrade --to <v>`
// instead, it logs that and moves the Machine's build to `v`, as a release's would. Run as
// `--json doctor`, it fails the checks its board names as `failing`, where it names any.
//
// Usage: bun scripted-host.ts <board.json> bridge --as desktop --client <computer>
//        bun scripted-host.ts <board.json> --json upgrade --to <version>
//        bun scripted-host.ts <board.json> --json doctor

import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schedule, Schema, Stream } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { BRIDGE_READY, FrontDoorRpcs, HostRefused, PROTOCOL } from "../../../src/board-model";
import { boardMessages } from "../../../src/board-stream";
import { OFFERS, REFUSED_RUN, STARTABLE, ScriptedMachine } from "./scripted-machine";

const [board, ...bridge] = Bun.argv.slice(2);
const MachineFile = Schema.fromJsonString(ScriptedMachine);
const asLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const upgrading = board !== undefined && bridge.slice(0, 3).join(" ") === "--json upgrade --to";
const failing =
  board !== undefined && bridge.join(" ") === "--json doctor"
    ? Schema.decodeUnknownSync(MachineFile)(await Bun.file(board).text()).failing
    : undefined;
if (failing !== undefined) {
  const checks = failing.map((check) => ({ ...check, ok: false }));
  process.stdout.write(
    `${asLine(checks.length === 0 ? { ok: true, data: { ready: true, checks } } : { ok: false, error: { code: "operation_failed", message: "not ready", details: { ready: false, checks } } })}\n`,
  );
  process.exit(checks.length === 0 ? 0 : 1);
}
if (!upgrading && (board === undefined || bridge.slice(0, 3).join(" ") !== "bridge --as desktop")) {
  process.stderr.write(`scripted host: started as ${Bun.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

/** What an operation was asked with, as it is logged. */
type Asked = Parameters<typeof asLine>[0];

const Served = FrontDoorRpcs.omit(
  "declare",
  "runDetail",
  "runFile",
  "propose",
  "act",
  "reconcile",
  "settleDelivery",
  "news",
);

const handlers = Served.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = fs
      .readFileString(board)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MachineFile)), Effect.orDie);
    const write = (machine: ScriptedMachine) =>
      fs
        .writeFileString(`${board}.new`, asLine(machine))
        .pipe(Effect.andThen(fs.rename(`${board}.new`, board)), Effect.orDie);
    const { installation, herds, build, development, protocol } = yield* read;
    const developing = development === undefined ? {} : { development };
    const logged = (op: string, payload: Asked) =>
      fs
        .writeFileString(`${board}.ops.jsonl`, `${asLine({ op, payload })}\n`, { flag: "a" })
        .pipe(Effect.orDie);
    /** Logs what was asked, then refuses it for the refused Run or answers it. */
    const asked = <A>(op: string, payload: Asked, answer: A, runId?: string) =>
      logged(op, payload).pipe(
        Effect.andThen(
          runId === REFUSED_RUN
            ? Effect.fail(new HostRefused({ reason: `${op} refused for ${REFUSED_RUN}` }))
            : Effect.succeed(answer),
        ),
      );
    const started = { runId: "r-new", registration: "r", execution: "e", fresh: true };
    const controlled = (runId: string, control: string, set: boolean) => ({
      runId,
      control,
      set,
      applied: true,
      detail: "",
      left: [],
    });
    return {
      board: () =>
        boardMessages({
          head: {
            installation,
            build: build ?? "scripted",
            ...developing,
            protocol: protocol ?? PROTOCOL,
            herds,
          },
          build: Effect.map(read, ({ tasks }) => tasks),
          changed: Stream.fromSchedule(Schedule.spaced("100 millis")),
        }),
      answer: (payload) =>
        asked(
          "answer",
          payload,
          {
            runId: payload.runId,
            decision: payload.decision ?? "",
            value: payload.value,
            fresh: true,
          },
          payload.runId,
        ).pipe(
          Effect.tap(() =>
            Effect.flatMap(read, (machine) =>
              write({
                ...machine,
                tasks: machine.tasks.map((task) =>
                  task.run === payload.runId
                    ? { ...task, state: "active", decision: null, sentence: "Carrying on." }
                    : task,
                ),
              }),
            ),
          ),
        ),
      control: (payload) =>
        asked(
          "control",
          payload,
          controlled(payload.runId, payload.control, payload.set),
          payload.runId,
        ),
      resume: (payload) =>
        asked("resume", payload, controlled(payload.runId, "stop", false), payload.runId),
      start: (payload) => asked("start", payload, started),
      invoke: (payload) => asked("invoke", payload, started, payload.runId),
      followUp: (payload) => asked("followUp", payload, started, payload.runId),
      offers: (payload) => asked("offers", payload, OFFERS, payload.runId),
      workflows: (payload) => logged("workflows", payload).pipe(Effect.as(STARTABLE)),
      confirm: (payload) => asked("confirm", payload, { proposal: payload.proposal, results: [] }),
      decline: (payload) => asked("decline", payload, { proposal: payload.proposal }),
      dispose: (payload) =>
        asked(
          "dispose",
          payload,
          {
            at: "2026-10-05T00:00:00Z",
            by: "desktop",
            kind: payload.kind,
            ref: payload.ref,
            note: null,
          },
          payload.runId,
        ),
      steerAbout: (payload) =>
        logged("steerAbout", payload).pipe(
          Effect.as({
            ok: true,
            code: null,
            human: `Collie will propose what ${payload.runId} should do about it.`,
            data: null,
          }),
        ),
    };
  }),
);

/** Moves the Machine's build to the version asked for, as `collie upgrade --to` would. */
const upgrade = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const to = bridge[3]!;
  const file = board!;
  const machine = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MachineFile)));
  yield* fs.writeFileString(
    `${file}.ops.jsonl`,
    `${asLine({ op: "upgrade", payload: { to } })}\n`,
    {
      flag: "a",
    },
  );
  yield* fs.writeFileString(`${file}.new`, asLine({ ...machine, build: to }));
  yield* fs.rename(`${file}.new`, file);
  process.stdout.write(`${asLine({ ok: true, data: { version: to } })}\n`);
}).pipe(Effect.orDie, Effect.provide(BunFileSystem.layer));

if (upgrading) BunRuntime.runMain(upgrade);
else {
  process.stdout.write(`Welcome to the scripted Machine\n${BRIDGE_READY}\n`);
  Layer.launch(
    RpcServer.layer(Served).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolStdio),
      Layer.provide([RpcSerialization.layerNdjson, BunStdio.layer, BunFileSystem.layer]),
    ),
  ).pipe(BunRuntime.runMain);
}
