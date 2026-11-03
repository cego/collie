// The host's door (ADR-draft-the-host-reads-records-on-a-thread-of-its-own): a Worker that
// owns the host's socket, answers the host's identity and a Run's record itself, and passes
// every other frame to the engine on the main thread, which feeds it what a record reads.

import * as Arr from "effect/Array";
import { isMainThread } from "node:worker_threads";
import { Context, Deferred, Effect, Layer, PubSub, Queue, Scope, Stream } from "effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as SocketServer from "effect/socket/SocketServer";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { IdentityRpc, RunDetailRpc, type MrPanel, type OfferView } from "./board-model";
import { mrOf } from "./board";
import type { PluginEnv } from "./env";
import { foregroundLayer } from "./foreground";
import type { AgentInfo } from "./herdr";
import { platformLayer, type PlatformServices } from "./platform";
import { drawerWrites, recordFrames, type RecordSources } from "./record";
import { markFirst } from "./record-marks";
import { RunModel, runModelLayer, type ModelLink } from "./run-model";
import type { RunFacts } from "./runs";

/** What the engine tells the door of a Run: its facts, the revision they were read at, its offers. */
export interface Listed {
  readonly fact: RunFacts;
  /** The Run's revision when its view was read; null for a view the engine reads every time. */
  readonly seq: number | null;
  readonly offers: ReadonlyArray<OfferView>;
}

export interface Opened {
  readonly socket: string;
  readonly env: PluginEnv;
  readonly identity: typeof IdentityRpc.successSchema.Type;
  /** The Run model the door keeps beside the engine's, undefined where the model is off. */
  readonly model:
    | {
        readonly counter: SharedArrayBuffer;
        readonly epoch: string;
        readonly installation: string;
      }
    | undefined;
}

export type Asked =
  | { readonly _tag: "Related"; readonly runId: string; readonly also: ReadonlyArray<string> }
  | { readonly _tag: "Mr"; readonly run: RunFacts; readonly fresh: boolean };

export type ToDoor =
  | ({ readonly _tag: "Open" } & Opened)
  | {
      readonly _tag: "Response";
      readonly conn: number;
      readonly frame: RpcMessage.FromServerEncoded;
    }
  | { readonly _tag: "Touched"; readonly run: string; readonly seq: number }
  | { readonly _tag: "Invalidated"; readonly path: string }
  | { readonly _tag: "Disabled" }
  | {
      readonly _tag: "Listed";
      readonly runs: ReadonlyArray<Listed>;
      readonly gone: ReadonlyArray<string>;
      /** Every Run's id in the engine's order, where that order moved. */
      readonly order: ReadonlyArray<string> | null;
      readonly alive: ReadonlyArray<AgentInfo>;
    }
  | { readonly _tag: "Wrote" }
  | { readonly _tag: "Answer"; readonly ask: number; readonly value: unknown };

export type FromDoor =
  | { readonly _tag: "Listening" }
  | {
      readonly _tag: "Request";
      readonly conn: number;
      readonly frame: RpcMessage.FromClientEncoded;
    }
  | { readonly _tag: "Gone"; readonly conn: number }
  | { readonly _tag: "Touched"; readonly run: string; readonly seq: number }
  | { readonly _tag: "Finished"; readonly run: string; readonly step: string; readonly seq: number }
  | { readonly _tag: "Unfinished"; readonly run: string; readonly step: string }
  | { readonly _tag: "Ask"; readonly ask: number; readonly asked: Asked };

/** What the door answers itself; every other request is the engine's. */
const DoorRpcs = RpcGroup.make(IdentityRpc, RunDetailRpc);
const MODELLED = new Set(["identity", "runDetail"]);
const UNMODELLED = new Set(["identity"]);

/** Where a Worker or a test's channel carries messages, one way and the other. */
export interface Port<Out, In> {
  readonly post: (message: Out) => void;
  readonly listen: (receive: (message: In) => void) => void;
}

// ---------------------------------------------------------------------------------------
// The engine's end.

/** What the engine does with what the door tells it of the Run model. */
export interface EngineModel {
  readonly heard: (run: string, seq: number) => void;
  readonly finishedAt: (run: string, step: string, seq: number) => number;
  readonly unfinished: (run: string, step: string) => void;
}

/** The engine's end of the door: its RPC protocol, the model link and the door's asks. */
export const engineEnd = (port: Port<ToDoor, FromDoor>) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<{
      readonly conn: number;
      readonly frame: RpcMessage.FromClientEncoded;
    }>();
    const disconnects = yield* Queue.unbounded<number>();
    const asks = yield* Queue.unbounded<{ readonly ask: number; readonly asked: Asked }>();
    const listening = yield* Deferred.make<void>();
    const clients = new Set<number>();
    let model: EngineModel | undefined;
    port.listen((message) => {
      switch (message._tag) {
        case "Listening":
          return Deferred.doneUnsafe(listening, Effect.void);
        case "Request":
          clients.add(message.conn);
          return Queue.offerUnsafe(requests, message);
        case "Gone":
          clients.delete(message.conn);
          return Queue.offerUnsafe(disconnects, message.conn);
        // Applied as it arrives: an act the door passes on after it is checked against it.
        case "Touched":
          return model?.heard(message.run, message.seq);
        case "Finished":
          return void model?.finishedAt(message.run, message.step, message.seq);
        case "Unfinished":
          return model?.unfinished(message.run, message.step);
        case "Ask":
          return Queue.offerUnsafe(asks, message);
      }
    });
    const protocol = RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        yield* Queue.take(requests).pipe(
          Effect.flatMap(({ conn, frame }) => writeRequest(conn, frame)),
          Effect.forever,
          Effect.forkScoped,
        );
        yield* Deferred.await(listening);
        return {
          disconnects,
          send: (conn: number, frame: RpcMessage.FromServerEncoded) =>
            Effect.sync(() => port.post({ _tag: "Response", conn, frame })),
          end: () => Effect.void,
          clientIds: Effect.succeed(clients),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: RpcSerialization.ndjson.codecFor,
        };
      }),
    );
    const link = (counter: SharedArrayBuffer, epoch: string): ModelLink => ({
      counter: new Int32Array(counter),
      epoch,
      touched: (run, seq) => port.post({ _tag: "Touched", run, seq }),
      invalidated: (path) => port.post({ _tag: "Invalidated", path }),
      disabled: () => port.post({ _tag: "Disabled" }),
    });
    return {
      protocol: Layer.effect(RpcServer.Protocol)(protocol),
      open: (opened: Opened) => port.post({ _tag: "Open", ...opened }),
      link,
      attach: (engine: EngineModel) => {
        model = engine;
      },
      asks,
      post: port.post,
    };
  });

export type EngineEnd = Effect.Success<ReturnType<typeof engineEnd>>;

/** The door on a thread of its own; the host stops once it has gone. */
export const doorThread = Effect.gen(function* () {
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => new Worker(new URL("./door.ts", import.meta.url).href)),
    (worker) => Effect.sync(() => worker.terminate()),
  );
  const gone = yield* Deferred.make<void>();
  worker.addEventListener("close", () => Deferred.doneUnsafe(gone, Effect.void));
  worker.addEventListener("error", () => Deferred.doneUnsafe(gone, Effect.void));
  const port: Port<ToDoor, FromDoor> = {
    post: (message) => worker.postMessage(message),
    listen: (receive) => worker.addEventListener("message", (event) => receive(event.data)),
  };
  return { port, gone: Deferred.await(gone) };
});

// ---------------------------------------------------------------------------------------
// The door's end.

/** The Runs a Run's record reads, as the engine's `related` chooses them, from what it was told. */
export const relatedOf = (
  facts: ReadonlyMap<string, RunFacts>,
  order: ReadonlyArray<string>,
  runId: string,
  also: ReadonlyArray<string>,
): ReadonlyArray<RunFacts> | null => {
  const self = facts.get(runId);
  const known = Arr.flatMap(order, (id) => {
    const fact = facts.get(id);
    return fact === undefined ? [] : [fact];
  });
  const listed = new Set(Arr.map(known, (one) => one.id));
  if (self === undefined || !listed.has(runId) || Arr.some(also, (id) => !listed.has(id)))
    return null;
  const own = new Set(
    Arr.map(
      Arr.filter(known, (one) => (self.task === null ? one.id === runId : one.task === self.task)),
      (one) => one.id,
    ),
  );
  const parents = new Set(
    Arr.map(
      Arr.filter(known, (one) => own.has(one.id)),
      (one) => one.parent,
    ),
  );
  const reads = (one: RunFacts) =>
    own.has(one.id) ||
    parents.has(one.id) ||
    own.has(one.parent ?? "") ||
    own.has(one.requestedBy?.run ?? "");
  const near = Arr.filter(known, (one) => reads(one) || one.requestedBy !== undefined);
  const wanted = new Set(also);
  return Arr.filter(
    [...near, ...Arr.filter(known, (one) => wanted.has(one.id) && !near.includes(one))],
    (one) => reads(one) || wanted.has(one.id),
  );
};

/** The door: everything it serves, over a socket server, with the engine at `port`. */
export const door = (port: Port<FromDoor, ToDoor>) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<ToDoor>();
    port.listen((message) => Queue.offerUnsafe(inbox, message));
    // What the engine's model moved before it opened the door is applied once the door's model is made.
    const early: Array<ToDoor> = [];
    let first = yield* Queue.take(inbox);
    while (first._tag !== "Open") {
      early.push(first);
      first = yield* Queue.take(inbox);
    }
    const { socket, env, identity } = first;
    const scope = yield* Effect.scope;
    const model =
      first.model === undefined
        ? undefined
        : Context.get(
            yield* Layer.build(
              runModelLayer(env.stateDir, first.model.installation, {
                counter: new Int32Array(first.model.counter),
                epoch: first.model.epoch,
                touched: (run, seq) => port.post({ _tag: "Touched", run, seq }),
                invalidated: () => {},
                disabled: () => {},
              }),
            ),
            RunModel,
          );
    const facts = new Map<string, RunFacts>();
    const read = new Map<string, number | null>();
    const offers = new Map<string, ReadonlyArray<OfferView>>();
    let order: ReadonlyArray<string> = [];
    let alive: ReadonlyArray<AgentInfo> = [];
    const writes = yield* PubSub.unbounded<void>();
    let asked = 0;
    const answers = new Map<number, Deferred.Deferred<unknown>>();
    const ask = (asking: Asked) =>
      Effect.gen(function* () {
        const id = ++asked;
        const answer = yield* Deferred.make<unknown>();
        answers.set(id, answer);
        port.post({ _tag: "Ask", ask: id, asked: asking });
        return yield* Deferred.await(answer).pipe(
          Effect.ensuring(Effect.sync(() => answers.delete(id))),
        );
      });
    const keep = (runs: ReadonlyArray<Listed>) => {
      for (const one of runs) {
        facts.set(one.fact.id, one.fact);
        read.set(one.fact.id, one.seq);
        offers.set(one.fact.id, one.offers);
      }
      model?.mirror(Arr.map(runs, (one) => one.fact));
    };

    const conns = new Map<
      number,
      {
        readonly write: (frame: RpcMessage.FromServerEncoded) => Effect.Effect<void>;
        readonly local: Set<string | number>;
      }
    >();
    const local = yield* Queue.unbounded<{
      readonly conn: number;
      readonly frame: RpcMessage.FromClientEncoded;
    }>();
    const localGone = yield* Queue.unbounded<number>();
    const engineFrames = yield* Queue.unbounded<{
      readonly conn: number;
      readonly frame: RpcMessage.FromServerEncoded;
    }>();

    const told = (message: ToDoor): Effect.Effect<unknown> => {
      switch (message._tag) {
        case "Response":
          return Queue.offer(engineFrames, message);
        case "Touched":
          return Effect.sync(() => model?.heard(message.run, message.seq));
        case "Invalidated":
          return model?.forget(message.path) ?? Effect.void;
        case "Disabled":
          return model?.disable ?? Effect.void;
        case "Listed":
          return Effect.suspend(() => {
            keep(message.runs);
            for (const run of message.gone) {
              facts.delete(run);
              read.delete(run);
              offers.delete(run);
            }
            model?.gone(message.gone);
            if (message.order !== null) order = message.order;
            alive = message.alive;
            return PubSub.publish(writes, undefined);
          });
        case "Wrote":
          return PubSub.publish(writes, undefined);
        case "Answer": {
          const answer = answers.get(message.ask);
          return answer === undefined ? Effect.void : Deferred.succeed(answer, message.value);
        }
        case "Open":
          return Effect.void;
      }
    };
    yield* Effect.forEach(early, told, { discard: true });
    yield* Queue.take(inbox).pipe(Effect.flatMap(told), Effect.forever, Effect.forkScoped);
    yield* Queue.take(engineFrames).pipe(
      Effect.flatMap(({ conn, frame }) => conns.get(conn)?.write(frame) ?? Effect.void),
      Effect.forever,
      Effect.forkScoped,
    );

    const ours = model === undefined ? UNMODELLED : MODELLED;
    const sources: RecordSources | undefined =
      model === undefined
        ? undefined
        : {
            env,
            model: {
              ...model,
              // What the engine read it already noted; what the door holds it has indexed.
              note: () => Effect.void,
              finishedAt: (run, step, seq) => {
                port.post({ _tag: "Finished", run, step, seq });
                return model.finishedAt(run, step, seq);
              },
              unfinished: (run, step) => {
                port.post({ _tag: "Unfinished", run, step });
                return model.unfinished(run, step);
              },
            },
            plans: new Map(),
            alive: Effect.sync(() => alive),
            offers: (runId) => Effect.sync(() => offers.get(runId) ?? []),
            related: (runId, also) =>
              Effect.gen(function* () {
                const held = relatedOf(facts, order, runId, also);
                const current =
                  held !== null &&
                  Arr.every(held, (one) => read.get(one.id) === model.revision(one.id).seq);
                if (current) return held;
                // SAFETY: the engine answers a `Related` ask with the Runs it read, as `Listed`.
                const runs = (yield* ask({
                  _tag: "Related",
                  runId,
                  also,
                })) as ReadonlyArray<Listed>;
                keep(runs);
                return Arr.map(runs, (one) => one.fact);
              }),
            mr: (run, fresh) =>
              mrOf(run) === null
                ? Effect.succeed(null)
                : ask({ _tag: "Mr", run, fresh }).pipe(
                    // SAFETY: the engine answers an `Mr` ask with the merge watch's panel.
                    Effect.map((panel) => panel as MrPanel | null),
                  ),
          };
    const changes = Stream.fromPubSub(writes);
    const bun = yield* Effect.context<PlatformServices>();
    const handlers = DoorRpcs.toLayer({
      identity: () => Effect.succeed(identity),
      runDetail: (key) =>
        sources === undefined
          ? Stream.die("the door reads no record without the Run model")
          : recordFrames(
              sources,
              key,
              Stream.merge(
                changes,
                drawerWrites(env.stateDir, key.runId).pipe(Stream.provideContext(bun)),
              ),
            ).pipe(markFirst("host:emit", key.runId), Stream.provideContext(bun), Stream.orDie),
    });
    const localProtocol = RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function* () {
        yield* Queue.take(local).pipe(
          Effect.flatMap(({ conn, frame }) => writeRequest(conn, frame)),
          Effect.forever,
          Effect.forkScoped,
        );
        return {
          disconnects: localGone,
          send: (conn: number, frame: RpcMessage.FromServerEncoded) => {
            const to = conns.get(conn);
            if (to === undefined) return Effect.void;
            if (frame._tag === "Exit") to.local.delete(frame.requestId);
            return to.write(frame);
          },
          end: () => Effect.void,
          clientIds: Effect.sync(() => new Set(conns.keys())),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: RpcSerialization.ndjson.codecFor,
        };
      }),
    );
    yield* Layer.build(
      RpcServer.layer(DoorRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.effect(RpcServer.Protocol)(localProtocol)),
      ),
    ).pipe(Scope.provide(scope));

    const server = Context.get(
      yield* Layer.build(BunSocketServer.layer({ path: socket })),
      SocketServer.SocketServer,
    );
    let next = 0;
    const route = (
      conn: number,
      held: Set<string | number>,
      frame: RpcMessage.FromClientEncoded,
    ) => {
      const mine =
        frame._tag === "Request"
          ? ours.has(frame.tag)
          : frame._tag === "Ack" || frame._tag === "Interrupt"
            ? held.has(frame.requestId)
            : false;
      if (frame._tag === "Request" && mine) held.add(frame.id);
      if (mine || frame._tag === "Eof") Queue.offerUnsafe(local, { conn, frame });
      if (!mine) port.post({ _tag: "Request", conn, frame });
    };
    yield* Effect.forkScoped(
      server.run((client) =>
        Effect.gen(function* () {
          const conn = next++;
          const parser = RpcSerialization.ndjson.makeUnsafe();
          const writer = yield* client.writer;
          const held = new Set<string | number>();
          conns.set(conn, {
            local: held,
            write: (frame) => {
              const encoded = parser.encode(frame);
              return encoded === undefined ? Effect.void : Effect.orDie(writer.write(encoded));
            },
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              conns.delete(conn);
              Queue.offerUnsafe(localGone, conn);
              port.post({ _tag: "Gone", conn });
            }),
          );
          const { pull } = yield* client.reader;
          for (;;) {
            const chunks = yield* pull;
            for (const chunk of chunks)
              // SAFETY: what a client sends the host is its RPC client's encoded frames.
              for (const frame of parser.decode(
                chunk,
              ) as ReadonlyArray<RpcMessage.FromClientEncoded>)
                route(conn, held, frame);
          }
        }).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.orDie,
          Effect.scoped,
        ),
      ),
    );
    port.post({ _tag: "Listening" });
    return yield* Effect.never;
  }).pipe(Effect.provide(foregroundLayer), Effect.scoped);

/** On the door's thread, its Worker's own scope. */
declare const self: Worker;

if (!isMainThread) {
  Effect.runFork(
    door({
      post: (message) => self.postMessage(message),
      listen: (receive) =>
        self.addEventListener("message", (event: MessageEvent<ToDoor>) => receive(event.data)),
    }).pipe(
      Effect.provide(platformLayer),
      Effect.catchCause((cause) => Effect.logError("the door has stopped", cause)),
      // Ends this thread alone; the engine stops the host once it has gone.
      Effect.ensuring(Effect.sync(() => process.exit(1))),
    ),
  );
}
