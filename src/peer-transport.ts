import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { createServer } from "node:net";
import { Deferred, Effect, Exit, Option, Schema, Scope } from "effect";
import { MachineUnreachable, type Peer } from "./peers-model";
import type { SshConnection } from "./ssh-connection";

export type Way = "direct" | "ssh";

type Ways = { -readonly [K in "direct" | "ssh" | "waits"]?: NonNullable<MachineUnreachable[K]> };

export const REACH_BOUND = "5 seconds";
export const LADDER_BOUND = "15 seconds";

// WARNING: Bun's WebSocket takes these options; where DOM's declaration of the global wins, its type does not say so.
const BunWebSocket = WebSocket as new (
  url: string,
  options?:
    | string
    | Array<string>
    | {
        readonly headers: Record<string, string>;
        readonly tls: { readonly ca?: string };
      },
) => WebSocket;

export interface Opened {
  readonly send: (data: Uint8Array) => void;
  readonly close: () => void;
  // WARNING: data that arrived before listen is buffered for the first listener.
  readonly listen: (deliver: (data: Uint8Array) => void, done: (reason: string) => void) => void;
  readonly way: Way;
  readonly direct: string | null;
}

const portOf = (url: string) =>
  Number(new URL(pipe_(url, Str.replace(/^wss:/, "https:"))).port || 443);

const Bound = Schema.Struct({ port: Schema.Finite });

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = Schema.is(Bound)(address) ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const dial = (peer: Peer, url: string, words: { refused: string; silent: string }) =>
  Effect.gen(function* () {
    const ws = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new BunWebSocket(url, {
            headers: { Authorization: `Bearer ${peer.secret}` },
            tls: { ca: peer.certificate },
          }),
      ),
      (ws) => Effect.sync(() => ws.close()),
    );
    ws.binaryType = "arraybuffer";
    const queued: Array<Uint8Array> = [];
    let deliver: (data: Uint8Array) => void = (data) => void queued.push(data);
    let done: (reason: string) => void = () => {};
    let ended: string | null = null;
    const answer = yield* Deferred.make<boolean>();
    ws.onopen = () => Deferred.doneUnsafe(answer, Exit.succeed(true));
    ws.onerror = () => Deferred.doneUnsafe(answer, Exit.succeed(false));
    ws.onmessage = (event) =>
      deliver(
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new TextEncoder().encode(event.data),
      );
    ws.onclose = (event) => {
      Deferred.doneUnsafe(answer, Exit.succeed(false));
      ended = event.reason;
      done(event.reason);
    };
    const open = yield* Deferred.await(answer).pipe(Effect.timeoutOption(REACH_BOUND));
    if (Option.isSome(open) && open.value)
      return {
        send: (data: Uint8Array) => ws.send(new Uint8Array(data)),
        close: () => ws.close(),
        listen: (to: (data: Uint8Array) => void, then: (reason: string) => void) => {
          for (const data of queued.splice(0)) to(data);
          deliver = to;
          done = then;
          if (ended !== null) then(ended);
        },
      };
    ws.close();
    return yield* Effect.fail(Option.isNone(open) ? words.silent : words.refused);
  });

export const openPeer = (
  peer: Peer,
  path: (way: Way, direct: string | null) => string,
  connection: Effect.Effect<SshConnection | null>,
  way?: Way,
) =>
  Effect.gen(function* () {
    const url = peer.url ?? "";
    const direct =
      way === "ssh"
        ? null
        : yield* dial(peer, `${url}${path("direct", null)}`, {
            refused: `${url} refused the connection`,
            silent: `no answer from ${url} within ${REACH_BOUND}`,
          }).pipe(
            Effect.map((opened) => {
              const returned: Opened = { ...opened, way: "direct", direct: null };
              return returned;
            }),
            Effect.flip,
            Effect.result,
          );
    if (direct !== null && direct._tag === "Failure") return direct.failure;
    const directSaw = direct === null ? null : direct.success;
    const unreachable = (ssh: string | null, waits = false) => {
      const seen: Array<string> = [];
      const ways: Ways = {};
      if (directSaw !== null) {
        seen.push(`direct: ${directSaw}`);
        ways.direct = directSaw;
      }
      if (ssh !== null) {
        seen.push(`ssh: ${ssh}`);
        ways.ssh = ssh;
      }
      if (waits) ways.waits = "ssh_connection";
      return new MachineUnreachable({ machine: peer.name, seen: Arr.join(seen, "; "), ...ways });
    };
    if (way === "direct") return yield* unreachable(null);
    const ssh = yield* connection;
    if (ssh === null) return yield* unreachable(`core lists no machine ${peer.name}`);
    if (!(yield* ssh.check))
      return yield* unreachable(
        `no SSH connection is open; \`collie machine connect ${peer.name}\` opens one`,
        true,
      );
    const outer = yield* Effect.scope;
    const tunnel = yield* Scope.fork(outer);
    const local = yield* freePort;
    const opened = yield* ssh.forward(local, portOf(url)).pipe(
      Effect.mapError((refused) => refused.reason),
      Effect.andThen(
        dial(peer, `wss://127.0.0.1:${local}${path("ssh", directSaw)}`, {
          refused: "the SSH connection's tunnel refused the connection",
          silent: `no answer through the SSH connection within ${REACH_BOUND}`,
        }),
      ),
      Scope.provide(tunnel),
      Effect.onError((cause) => Scope.close(tunnel, Exit.failCause(cause))),
      Effect.mapError((ssh) => unreachable(ssh)),
    );
    return { ...opened, way: "ssh", direct: directSaw } satisfies Opened;
  });
