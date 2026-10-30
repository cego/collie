// The client for herdr-core (`hc`): JSON-RPC lines on the session socket, then frames
// after `hello {framed: true}`, as core's API.md describes. Every reply Collie reads is
// decoded by `replies`, which `test/hc-contract.test.ts` holds to the pinned
// `hc.openrpc.json` and `tools/hc-probe.ts` runs against the pinned `hc`.

import * as Arr from "effect/Array";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Socket from "effect/socket/Socket";
import { Data, Deferred, Effect, FileSystem, Option, Queue, Schema, Struct } from "effect";

const opt = Schema.optionalKey;
const NullOr = Schema.NullOr;

const HcStatus = Schema.Struct({ state: Schema.String, kind: opt(NullOr(Schema.String)) });

export const HcTerminal = Schema.Struct({
  address: Schema.String,
  name: opt(NullOr(Schema.String)),
  labels: Schema.Record(Schema.String, Schema.String),
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  state: Schema.String,
  created_ms: Schema.Finite,
  cols: Schema.Finite,
  rows: Schema.Finite,
  pid: opt(NullOr(Schema.Finite)),
  exit_code: opt(NullOr(Schema.Finite)),
  reason: opt(NullOr(Schema.String)),
  finished_ms: opt(NullOr(Schema.Finite)),
  status: opt(NullOr(HcStatus)),
  turn: opt(Schema.Finite),
});
export type HcTerminal = typeof HcTerminal.Type;

const Machine = Schema.Struct({ name: Schema.String, state: Schema.String });

/** The decoder of each method's reply, by method. A method Collie calls has a row here. */
export const replies = {
  hello: Schema.Struct({
    generation: Schema.Finite,
    version: Schema.String,
    framed: Schema.Boolean,
  }),
  "terminal.run": HcTerminal,
  "terminal.list": Schema.Struct({
    terminals: Schema.Array(HcTerminal),
    // Required by the schema, but hc 0.1.14 leaves it out.
    machines: opt(Schema.Array(Machine)),
  }),
  "terminal.get": HcTerminal,
  "terminal.kill": HcTerminal,
  "terminal.read": Schema.Struct({ text: Schema.String, complete: Schema.Boolean }),
  "terminal.send": Schema.Struct({
    turn: Schema.Finite,
    started: opt(NullOr(Schema.Boolean)),
    status: opt(NullOr(Schema.String)),
  }),
  "terminal.keys": Schema.Struct({ turn: Schema.Finite, status: opt(NullOr(Schema.String)) }),
  "terminal.attach": Schema.Struct({ channel: Schema.Finite, terminal: HcTerminal }),
  "events.subscribe": Schema.Struct({
    seq: Schema.Finite,
    terminals: Schema.Array(HcTerminal),
    channel: opt(NullOr(Schema.Finite)),
  }),
};
type Replies = typeof replies;
export type HcMethod = keyof Replies;
export type HcReply<M extends HcMethod> = Replies[M]["Type"];

/**
 * Where this Machine's core listens, found as core finds it: `HC_SOCKET`, else the
 * session's socket under the runtime directory, else under the session's state directory.
 */
export const coreSocket = Effect.fn("Hc.coreSocket")(function* (
  raw: Readonly<Record<string, string | undefined>>,
) {
  if (raw.HC_SOCKET) return raw.HC_SOCKET;
  const session = raw.HC_SESSION || "default";
  if (raw.XDG_RUNTIME_DIR) return `${raw.XDG_RUNTIME_DIR}/herdr-core/${session}.sock`;
  const runtime = `/run/user/${process.getuid?.() ?? 0}`;
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(runtime).pipe(Effect.orElseSucceed(() => false)))
    return `${runtime}/herdr-core/${session}.sock`;
  const state = raw.XDG_STATE_HOME || `${raw.HOME ?? ""}/.local/state`;
  return `${state}/herdr-core/${session}/${session}.sock`;
});

export class HcError extends Data.TaggedError("HcError")<{
  readonly method: string;
  readonly message: string;
  /** Core's `data.kind`, or `unreachable` and `undecodable` for what Collie found. */
  readonly kind: string;
}> {}

const EventNote = Schema.Struct({
  method: Schema.Literal("event"),
  params: Schema.Struct({
    seq: Schema.Finite,
    type: Schema.String,
    terminal: opt(Schema.String),
    data: Schema.Json,
  }),
});
const MissedNote = Schema.Struct({
  method: Schema.Literal("missed"),
  params: Schema.Struct({ seq: Schema.Finite, terminals: Schema.Array(HcTerminal) }),
});
const HeartbeatNote = Schema.Struct({
  method: Schema.Literal("heartbeat"),
  params: Schema.Struct({ seq: Schema.Finite }),
});
export const HcNote = Schema.Union([EventNote, MissedNote, HeartbeatNote]);
export type HcNote = typeof HcNote.Type;

/** The terminals an `events.subscribe` stream describes, as of event `seq`. */
export interface HcSnapshot {
  readonly seq: number;
  readonly terminals: ReadonlyMap<string, HcTerminal>;
}

export const snapshotOf = (reply: HcReply<"events.subscribe">): HcSnapshot => ({
  seq: reply.seq,
  terminals: new Map(Arr.map(reply.terminals, (terminal) => [terminal.address, terminal])),
});

const Patch = HcTerminal.mapFields(Struct.map(Schema.optionalKey));
const LabelsData = Schema.Struct({ labels: HcTerminal.fields.labels, record: opt(HcTerminal) });
const TurnData = Schema.Struct({ turn: Schema.Finite });
const decodeOr = <S extends Schema.Decoder<unknown>>(schema: S, data: Schema.Json) =>
  Option.getOrUndefined(Schema.decodeOption(schema)(data));

/** The snapshot after `note`, as API.md §Events says to apply it. */
export function applyNote(snapshot: HcSnapshot, note: HcNote): HcSnapshot {
  if (note.method === "missed") return snapshotOf(note.params);
  if (note.method === "heartbeat" || note.params.seq <= snapshot.seq) return snapshot;
  const { seq, type, terminal: at = "", data } = note.params;
  const terminals = new Map(snapshot.terminals);
  const current = terminals.get(at);
  const patch = (fields: Partial<HcTerminal> | undefined) => {
    if (current && fields) terminals.set(at, { ...current, ...fields });
  };
  switch (type) {
    case "created":
    case "restarted": {
      const record = decodeOr(HcTerminal, data);
      if (record) terminals.set(at, record);
      break;
    }
    case "removed":
      terminals.delete(at);
      break;
    case "labels": {
      const labels = decodeOr(LabelsData, data);
      if (labels?.record) terminals.set(at, labels.record);
      else patch(labels && { labels: labels.labels });
      break;
    }
    case "turn":
      patch(decodeOr(TurnData, data));
      break;
    case "lost": {
      const fields = decodeOr(Patch, data);
      patch(fields && { ...fields, pid: null });
      break;
    }
    case "finished": {
      const fields = decodeOr(Patch, data);
      patch(fields && { ...fields, state: "finished" });
      break;
    }
    case "status":
    case "size":
      patch(decodeOr(Patch, data));
      break;
  }
  return { seq, terminals };
}

export const Kind = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3 } as const;

export interface Frame {
  readonly kind: number;
  readonly payload: Uint8Array;
}

const Message = Schema.Struct({
  id: opt(Schema.Finite),
  method: opt(Schema.String),
  params: opt(Schema.Json),
  result: opt(Schema.Json),
  error: opt(
    Schema.Struct({
      message: Schema.String,
      data: opt(Schema.Struct({ kind: opt(Schema.String) })),
    }),
  ),
});
type Message = typeof Message.Type;
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

export interface HcConnection {
  readonly call: <M extends HcMethod>(
    method: M,
    params: Schema.JsonObject,
  ) => Effect.Effect<HcReply<M>, HcError>;
  /** Every notification, in arrival order. */
  readonly notes: Queue.Dequeue<HcNote>;
  /** What arrives on a stream channel; DATA is credited as it is read off the socket. */
  readonly channel: (id: number) => Effect.Effect<Queue.Dequeue<Frame>>;
  readonly send: (
    channel: number,
    kind: number,
    payload?: Uint8Array,
  ) => Effect.Effect<void, HcError>;
}

const join = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const frame = (channel: number, kind: number, payload: Uint8Array) => {
  const header = new Uint8Array(9);
  const view = new DataView(header.buffer);
  view.setUint32(0, channel, true);
  view.setUint8(4, kind);
  view.setUint32(5, payload.length, true);
  return join(header, payload);
};

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

/** A connection to the core listening at `path`, closed with the scope. */
export const connect = Effect.fn("Hc.connect")(function* (path: string) {
  const unreachable = (cause: Socket.SocketError) =>
    new HcError({ method: "connect", message: `${path}: ${String(cause)}`, kind: "unreachable" });
  const socket = yield* BunSocket.makeNet({ path });
  const pull = yield* Socket.readerBytes(socket).pipe(Effect.mapError(unreachable));
  const writer = yield* socket.writer;
  const write = (bytes: Uint8Array) => writer.write(bytes).pipe(Effect.mapError(unreachable));

  const pending = new Map<number, Deferred.Deferred<Message, HcError>>();
  const framesAfter = new Set<number>();
  const notes = yield* Queue.unbounded<HcNote>();
  const channels = new Map<number, Queue.Queue<Frame>>();
  const channel = (id: number) =>
    Effect.gen(function* () {
      const found = channels.get(id);
      if (found) return found;
      const made = yield* Queue.unbounded<Frame>();
      channels.set(id, made);
      return made;
    });
  let framed = false;
  let nextId = 1;
  let buffer = new Uint8Array(0);

  const receive = (message: Message) => {
    const reply = message.id === undefined ? undefined : pending.get(message.id);
    if (message.id === undefined || !reply) {
      const note = Schema.decodeUnknownOption(HcNote)(message);
      return Option.isSome(note) ? Queue.offer(notes, note.value).pipe(Effect.asVoid) : Effect.void;
    }
    pending.delete(message.id);
    // Framed mode starts with the bytes after the hello reply, which are still to be parsed.
    if (framesAfter.delete(message.id) && message.result !== undefined) framed = true;
    return Deferred.succeed(reply, message).pipe(Effect.asVoid);
  };

  const drain = Effect.gen(function* () {
    for (;;) {
      if (!framed) {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        const line = new TextDecoder().decode(buffer.subarray(0, end));
        buffer = buffer.subarray(end + 1);
        const message = decodeMessage(line);
        if (Option.isSome(message)) yield* receive(message.value);
        continue;
      }
      if (buffer.length < 9) return;
      const view = new DataView(buffer.buffer, buffer.byteOffset);
      const id = view.getUint32(0, true);
      const kind = view.getUint8(4);
      const length = view.getUint32(5, true);
      if (buffer.length < 9 + length) return;
      const payload = buffer.slice(9, 9 + length);
      buffer = buffer.subarray(9 + length);
      if (id === 0 && kind === Kind.DATA) {
        const message = decodeMessage(new TextDecoder().decode(payload));
        if (Option.isSome(message)) yield* receive(message.value);
        continue;
      }
      yield* Queue.offer(yield* channel(id), { kind, payload });
      if (kind === Kind.DATA) yield* write(frame(id, Kind.CREDIT, u32(payload.length)));
    }
  });

  const closed = Effect.suspend(() => {
    const gone = new HcError({ method: "connect", message: `${path} closed`, kind: "unreachable" });
    return Effect.forEach([...pending.values()], (reply) => Deferred.fail(reply, gone)).pipe(
      Effect.andThen(Queue.shutdown(notes)),
      Effect.andThen(Effect.forEach([...channels.values()], Queue.shutdown)),
    );
  });

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        for (const chunk of yield* pull) buffer = join(buffer, chunk);
        yield* drain;
      }),
    ).pipe(Effect.ignore, Effect.ensuring(closed)),
  );

  const call = <M extends HcMethod>(method: M, params: Schema.JsonObject) =>
    Effect.gen(function* () {
      const id = nextId++;
      const reply = yield* Deferred.make<Message, HcError>();
      pending.set(id, reply);
      if (method === "hello" && params.framed === true) framesAfter.add(id);
      const text = yield* encodeJson({ jsonrpc: "2.0", id, method, params }).pipe(Effect.orDie);
      const bytes = new TextEncoder().encode(framed ? text : `${text}\n`);
      yield* write(framed ? frame(0, Kind.DATA, bytes) : bytes);
      const message = yield* Deferred.await(reply);
      if (message.error)
        return yield* new HcError({
          method,
          message: message.error.message,
          kind: message.error.data?.kind ?? "error",
        });
      const decoder: Schema.Decoder<HcReply<M>> = replies[method];
      return yield* Schema.decodeEffect(decoder)(message.result).pipe(
        Effect.mapError(
          (cause) =>
            new HcError({
              method,
              message: `${method} answered with a reply Collie cannot decode: ${cause.message}`,
              kind: "undecodable",
            }),
        ),
      );
    });

  const send = (id: number, kind: number, payload: Uint8Array = new Uint8Array(0)) =>
    write(frame(id, kind, payload));

  return { call, notes, channel, send } satisfies HcConnection;
});
