// Writes what the Rune spike's cargo tests read (desktop-rune/README.md):
//
//   bun run tools/rune-fixtures.ts
//
// - `fixtures/flock.ndjson`: the test Flock, one encoded `flock` item a line;
// - `fixtures/flows.json`: Desktop's Flow test case as it moves on, by name;
// - `fixtures/transcripts/*.ndjson`: Effect's own RPC client and server speaking over
//   Desktop's channel, every frame each way as `{"from":"shell"|"core","frame":…}`.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Effect, Layer, Schema, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { RequestId } from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import {
  clientProtocol,
  heldUntilListened,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../desktop/src/shared/channel";
import { ActionFailed, DesktopRpcs, FlockItem } from "../desktop/src/shared/flock";
import { Flow } from "../src/board-model";
import { FLOCK } from "../test/support/rune-fixtures";
import { mainFlow } from "../test/support/flow";

const FIXTURES = new URL("../desktop-rune/fixtures/", import.meta.url).pathname;

type Unspoken = Exclude<RpcGroup.Rpcs<typeof DesktopRpcs>["_tag"], "flock" | "syncNow">;
const Spoken = DesktopRpcs.omit(
  // SAFETY: every key of `requests` is one of DesktopRpcs' tags.
  ...(Arr.filter(
    [...DesktopRpcs.requests.keys()],
    (tag) => tag !== "flock" && tag !== "syncNow",
  ) as Array<Unspoken>),
);
type Client = RpcClient.FromGroup<typeof Spoken, RpcClientError>;

/** The test Flock in three chunks: what the core sends while the shell acks each one. */
const CHUNKS = [FLOCK.slice(0, 3), FLOCK.slice(3, 6), FLOCK.slice(6)];
const chunks = (count: number) =>
  Stream.concat(
    Stream.fromArrays(...CHUNKS.slice(0, count)),
    count < CHUNKS.length ? Stream.never : Stream.empty,
  );

/** Trace ids are random, and the shell sends none. */
const untraced = (frame: ToMain) => {
  if (frame._tag !== "Request") return frame;
  const { traceId: _, spanId: __, sampled: ___, ...kept } = frame;
  return kept;
};

const recorded = (
  flock: Stream.Stream<FlockItem>,
  shell: (client: Client) => Effect.Effect<unknown, ActionFailed | RpcClientError>,
) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const toCore = heldUntilListened<ToMain>();
    const toShell = heldUntilListened<ToView>();
    const core = {
      send: (frame: ToView) => {
        lines.push(JSON.stringify({ from: "core", frame }));
        toShell.receive(frame);
      },
      listen: toCore.listen,
    };
    const handlers = Spoken.toLayer({
      flock: () => flock,
      syncNow: ({ profile }) =>
        profile === "build"
          ? Effect.succeed({ said: "Synced Build box", failed: false })
          : Effect.fail(new ActionFailed({ reason: `no Machine is called ${profile}` })),
    });
    yield* Layer.launch(
      RpcServer.layer(Spoken).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(core))),
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.gen(function* () {
      let next = 0;
      // SAFETY: a request id is a number the client counts; each transcript counts from 0.
      const client = yield* RpcClient.make(Spoken, {
        generateRequestId: () => next++ as RequestId,
      });
      yield* Effect.exit(shell(client));
      // What the core says after the shell is done, such as the exit an interrupt brings.
      yield* Effect.sleep("100 millis");
    }).pipe(
      Effect.provide(
        Layer.effect(
          RpcClient.Protocol,
          clientProtocol({
            send: (frame) => {
              lines.push(JSON.stringify({ from: "shell", frame: untraced(frame) }));
              toCore.receive(frame);
            },
            listen: toShell.listen,
          }),
        ),
      ),
    );
    return lines;
  }).pipe(Effect.scoped);

const TRANSCRIPTS = {
  // A request answered, then one refused.
  answered: recorded(Stream.empty, (client) =>
    Effect.andThen(
      client.syncNow({ profile: "build" }),
      Effect.exit(client.syncNow({ profile: "gone" })),
    ),
  ),
  // Every chunk, each acked, then the stream's end.
  stream: recorded(chunks(3), (client) => Stream.runCollect(client.flock())),
  // One chunk taken, and the stream interrupted by the shell.
  interrupt: recorded(chunks(1), (client) => Stream.runCollect(Stream.take(client.flock(), 3))),
  // Two chunks, each acked, and the core gone before its next.
  "core-gone": Effect.map(
    recorded(chunks(2), (client) =>
      Effect.timeoutOption(Stream.runCollect(client.flock()), "100 millis"),
    ),
    (lines) =>
      Arr.take(
        lines,
        Option.getOrElse(
          Option.map(Arr.findLastIndex(lines, Str.includes('"Ack"')), (at) => at + 1),
          () => 0,
        ),
      ),
  ),
};

/** `test/desktop-flow.test.ts`'s Flow: as it starts, once Review is current, once it asks. */
const before = mainFlow();
const after: Flow = { ...before, current: { run: "build-run", node: "review" } };
const asking: Flow = {
  ...after,
  lanes: Arr.map(after.lanes, (lane) => ({
    ...lane,
    nodes: Arr.map(lane.nodes, (node) =>
      node.id === "review"
        ? { ...node, state: "needs-you" as const, said: "Asked 1 min ago" }
        : node,
    ),
  })),
};
const FLOWS = { before, after, asking };

const Flows = Schema.Struct({ before: Flow, after: Flow, asking: Flow });

const written = Effect.gen(function* () {
  const flows = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Flows)))(FLOWS);
  yield* Effect.promise(() => Bun.write(`${FIXTURES}flows.json`, `${flows}\n`));
  const flock = yield* Effect.forEach(FLOCK, (item) =>
    Schema.encodeEffect(Schema.toCodecJson(FlockItem))(item),
  );
  yield* Effect.promise(() =>
    Bun.write(
      `${FIXTURES}flock.ndjson`,
      Arr.join(
        Arr.map(flock, (item) => `${JSON.stringify(item)}\n`),
        "",
      ),
    ),
  );
  for (const [name, transcript] of Rec.toEntries(TRANSCRIPTS)) {
    const lines = yield* transcript;
    yield* Effect.promise(() =>
      Bun.write(
        `${FIXTURES}transcripts/${name}.ndjson`,
        Arr.join(
          Arr.map(lines, (line) => `${line}\n`),
          "",
        ),
      ),
    );
  }
});

await Effect.runPromise(written);
