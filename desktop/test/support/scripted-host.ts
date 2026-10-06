// A Machine's host as Desktop meets it, behind a bridge: login-shell noise, the ready
// marker, then `FrontDoorRpcs` over stdio. Its installation, Herds and TaskViews are
// whatever the file named first on its command line holds, read again every 100 ms.
// Every operation it is asked is appended to `<board.json>.ops.jsonl`; an answer also
// takes the decision off its Task, as a host's would.
//
// Usage: bun scripted-host.ts <board.json> bridge --as desktop|chat --client <computer>

import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun";
import { Effect, Encoding, FileSystem, Layer, Result, Schedule, Schema, Stream } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { BRIDGE_READY, FrontDoorRpcs, HostRefused, PROTOCOL } from "../../../src/board-model";
import { boardMessages } from "../../../src/board-stream";
import { OFFERS, REFUSED_RUN, STARTABLE, ScriptedMachine } from "./scripted-machine";

const [board, ...bridge] = Bun.argv.slice(2);
if (board === undefined || !/^bridge --as (desktop|chat)$/.test(bridge.slice(0, 3).join(" "))) {
  process.stderr.write(`scripted host: started as ${Bun.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

const MachineFile = Schema.fromJsonString(ScriptedMachine);
/** Smaller than a host's, so a test's large item is read in several parts. */
const PART_BYTES = 16 * 1024;
const asLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What an operation was asked with, as it is logged. */
type Asked = Parameters<typeof asLine>[0];

const Served = FrontDoorRpcs.omit("propose", "act", "reconcile", "settleDelivery");

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
    const { installation, herds } = yield* read;
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
          head: { installation, build: "scripted", protocol: PROTOCOL, herds },
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
      declare: (payload) => logged("declare", payload),
      news: (payload) =>
        Effect.gen(function* () {
          yield* logged("news", payload);
          const machine = yield* read;
          const items = machine.news ?? [];
          const taken = payload.keys ?? items.map(({ key }) => key);
          if (payload.as === "read" && taken.length > 0)
            yield* write({ ...machine, news: items.filter(({ key }) => !taken.includes(key)) });
          return { items, omitted: 0 };
        }),
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
      runDetail: (payload) =>
        Stream.fromSchedule(Schedule.spaced("100 millis")).pipe(
          Stream.mapEffect(() => read),
          Stream.map(({ details }) => details?.[payload.runId] ?? null),
          Stream.changesWith((a, b) => asLine(a) === asLine(b)),
        ),
      runFile: (payload) =>
        Effect.flatMap(read, ({ files }) => {
          const content = files?.[`${payload.runId} ${payload.ref}`];
          if (content === undefined)
            return Effect.fail(
              new HostRefused({ reason: `${payload.ref} is not ${payload.runId}'s` }),
            );
          // As a host hands out an item: in parts, and as base64 unless it is text and whole.
          const [text, bytes] = Schema.is(Schema.String)(content)
            ? [content, new TextEncoder().encode(content)]
            : [null, Encoding.decodeBase64(content.base64).pipe(Result.getOrThrow)];
          const offset = payload.offset ?? 0;
          const part = bytes.subarray(offset, offset + PART_BYTES);
          return Effect.succeed(
            text !== null && part.length === bytes.length
              ? { ref: payload.ref, encoding: "utf8" as const, content: text, size: bytes.length }
              : {
                  ref: payload.ref,
                  encoding: "base64" as const,
                  content: Encoding.encodeBase64(part),
                  size: bytes.length,
                },
          );
        }),
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

process.stdout.write(`Welcome to the scripted Machine\n${BRIDGE_READY}\n`);

Layer.launch(
  RpcServer.layer(Served).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide([RpcSerialization.layerNdjson, BunStdio.layer, BunFileSystem.layer]),
  ),
).pipe(BunRuntime.runMain);
