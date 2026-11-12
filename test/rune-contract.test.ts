// The Rune spike's side of `DesktopRpcs`: frames encoded here through the real Schemas,
// decoded and re-encoded by the Rust types, and decoded here again, come back equal. A field
// the Rust types lack is dropped on the way, and that turns this red. Needs cargo, which the
// `desktop-rune` CI job has.

import { beforeAll, describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, Exit, Schema } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import { ActionFailed, DesktopRpcs, FlockItem } from "../desktop/src/shared/flock";
import { runEffect } from "./support/effect";
import { AguiEvent } from "../desktop/src/shared/agui";
import { FLOCK, SAID } from "./support/rune-fixtures";
import { exec } from "./support/command";

const WORKSPACE = new URL("../desktop-rune/", import.meta.url).pathname;
const cargo = Bun.which("cargo");

const flock = DesktopRpcs.requests.get("flock")!;
const syncNow = DesktopRpcs.requests.get("syncNow")!;
const say = DesktopRpcs.requests.get("say")!;
/** Each request of the group, typed as all of them. */
type DesktopRpc = typeof flock;

// SAFETY: the schemas of the RPCs the spike speaks need no services to encode or decode.
const codec = (schema: Schema.Top) => Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>);
const encoder = (schema: Schema.Top) => Schema.encodeEffect(codec(schema));
const decoder = (schema: Schema.Top) => Schema.decodeUnknownEffect(codec(schema));

/** The frames of Desktop's channel, each RPC part still encoded. */
const Frame = Schema.Union([
  Schema.TaggedStruct("Hello", {}),
  Schema.TaggedStruct("Request", {
    id: Schema.Finite,
    tag: Schema.String,
    payload: Schema.Unknown,
    headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  }),
  Schema.TaggedStruct("Chunk", { requestId: Schema.Finite, values: Schema.Array(Schema.Unknown) }),
  Schema.TaggedStruct("Exit", { requestId: Schema.Finite, exit: Schema.Unknown }),
]);
type Frame = typeof Frame.Type;
const fromLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Frame));

const PAYLOAD = { profile: "build" };
const SYNCED = { said: "Synced Build box", failed: false };
const REFUSED = new ActionFailed({ reason: "no Machine is called gone", request: "q-7" });

/** Hello, then each RPC asked and answered as the main process answers it. */
const frames = Effect.gen(function* () {
  const syncNowPayload = encoder(syncNow.payloadSchema);
  const flockExit = encoder(Rpc.exitSchema(flock));
  const syncNowExit = encoder(Rpc.exitSchema(syncNow));
  const sayExit = encoder(Rpc.exitSchema(say));
  const sent: ReadonlyArray<Frame> = [
    { _tag: "Hello" },
    {
      _tag: "Request",
      id: 0,
      tag: "flock",
      payload: yield* encoder(flock.payloadSchema)(undefined),
      headers: [],
    },
    {
      _tag: "Request",
      id: 1,
      tag: "syncNow",
      payload: yield* syncNowPayload(PAYLOAD),
      headers: [],
    },
    {
      _tag: "Request",
      id: 2,
      tag: "syncNow",
      payload: yield* syncNowPayload({ profile: "gone" }),
      headers: [],
    },
    {
      _tag: "Request",
      id: 3,
      tag: "say",
      payload: yield* encoder(say.payloadSchema)({
        text: "What is blocked?",
        about: { machine: "Local", task: "t2", run: "r2", name: "Fix the login redirect" },
        now: true,
        attachments: ["a1"],
      }),
      headers: [],
    },
    {
      _tag: "Chunk",
      requestId: 0,
      values: yield* Effect.forEach(FLOCK, (item) => encoder(FlockItem)(item)),
    },
    {
      _tag: "Chunk",
      requestId: 3,
      values: yield* Effect.forEach(SAID, (event) => encoder(AguiEvent)(event)),
    },
    { _tag: "Exit", requestId: 3, exit: yield* sayExit(Exit.void) },
    { _tag: "Exit", requestId: 1, exit: yield* syncNowExit(Exit.succeed(SYNCED)) },
    { _tag: "Exit", requestId: 2, exit: yield* syncNowExit(Exit.fail(REFUSED)) },
    { _tag: "Exit", requestId: 0, exit: yield* flockExit(Exit.void) },
  ];
  return sent;
});

/** A frame with every part it carries decoded through its RPC's Schemas. */
const typed = (frame: Frame, tags: ReadonlyMap<number, DesktopRpc>) =>
  Effect.gen(function* () {
    switch (frame._tag) {
      case "Hello":
        return frame;
      case "Request":
        return {
          ...frame,
          payload: yield* decoder(tags.get(frame.id)!.payloadSchema)(frame.payload),
        };
      case "Chunk":
        return {
          ...frame,
          values: yield* Effect.forEach(frame.values, (value) =>
            decoder(frame.requestId === 3 ? AguiEvent : FlockItem)(value),
          ),
        };
      case "Exit":
        return {
          ...frame,
          exit: yield* decoder(Rpc.exitSchema(tags.get(frame.requestId)!))(frame.exit),
        };
    }
  });

describe.skipIf(cargo === null)("DesktopRpcs between the main process and the Rune shell", () => {
  let roundtrip = "";
  beforeAll(
    () =>
      runEffect(
        Effect.gen(function* () {
          const built = yield* exec(
            [cargo!, "build", "--quiet", "-p", "collie-desktop-protocol", "--bin", "roundtrip"],
            {
              cwd: WORKSPACE,
            },
          );
          if (built.exitCode !== 0)
            throw new Error(`cargo could not build the roundtrip binary: ${built.stderr}`);
          roundtrip = `${WORKSPACE}target/debug/roundtrip`;
        }),
      ),
    600_000,
  );

  test("the chat's turn carries an event of every AG-UI kind", () => {
    expect(new Set(Arr.map(SAID, (event) => event.type)).size).toBe(AguiEvent.members.length);
  });

  test("Hello, a flock chunk, an answer and a failure come back from Rust as they went", () =>
    runEffect(
      Effect.gen(function* () {
        const sent = yield* frames;
        const ran = yield* exec([roundtrip], {
          stdin: Buffer.from(
            Arr.join(
              Arr.map(sent, (frame) => `${JSON.stringify(frame)}\n`),
              "",
            ),
          ),
        });
        expect(ran.exitCode).toBe(0);
        expect(ran.stderr).toBe("");
        const back: ReadonlyArray<Frame> = yield* Effect.forEach(
          Str.split(Str.trimEnd(ran.stdout), "\n"),
          (line) => fromLine(line, { onExcessProperty: "error" }),
        );
        const tags = new Map<number, DesktopRpc>([
          [0, flock],
          [1, syncNow],
          [2, syncNow],
          [3, say],
        ]);
        const want = yield* Effect.forEach(sent, (frame) => typed(frame, tags));
        const got = yield* Effect.forEach(back, (frame) => typed(frame, tags));
        expect(got).toEqual(want);
      }),
    ));
});
