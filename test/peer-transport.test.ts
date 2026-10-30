// ADR-draft-a-blocked-link-rides-the-machines-ssh-connection: a TLS WebSocket server stands
// in for the peer, a resetter for a network refusing its port.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { Effect, FileSystem, Option, type Scope } from "effect";
import { openPeer, type Way } from "../src/peer-transport";
import { certificateFor, keyOf } from "../src/peers";
import type { Peer } from "../src/peers-model";
import { openConnection, sshConnection } from "../src/ssh-connection";
import { runEffect } from "./support/effect";
import { freePort, portOf, resetter, writeFakeSsh, socketDir } from "./support/fake-ssh";

const vm = { label: "vm-mk", target: "mk@vm-mk" };
const SECRET = "the-secret";

/** A server on 127.0.0.1 that accepts each connection and never answers. */
const silent = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer((conn) => conn.on("error", () => {}));
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.sync(() => server.close()),
);

/** A port nothing listens on, held by a resetter for the test. */
const resetting = Effect.gen(function* () {
  const free = yield* freePort;
  const server = yield* resetter(free);
  let accepted = 0;
  server.on("connection", () => void accepted++);
  return { port: free, accepted: () => accepted };
});

/** A pinned TLS WebSocket server that echoes, letting in only the secret. */
const listener = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const certificate = yield* certificateFor(dir, "127.0.0.1");
    const server = Bun.serve<string>({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: certificate, key: yield* fs.readFileString(keyOf(dir)) },
      fetch: (request, server) =>
        request.headers.get("authorization") !== `Bearer ${SECRET}`
          ? new Response("not paired", { status: 401 })
          : server.upgrade(request, { data: new URL(request.url).pathname })
            ? undefined
            : new Response("", { status: 400 }),
      websocket: {
        open: (ws) => void ws.send(`at ${ws.data}`),
        message: (ws, message) => void ws.send(message),
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));
    return { port: server.port!, certificate };
  });

const rig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* socketDir("way-");
  const ssh = `${dir}/ssh`;
  const fake = yield* writeFakeSsh(ssh, dir);
  const state = `${dir}/state`;
  const peerDir = `${dir}/peer`;
  yield* fs.makeDirectory(peerDir);
  const far = yield* listener(peerDir);
  const handle = yield* sshConnection(state, vm, ssh);
  const connect = openConnection(state, vm, { ssh, said: () => Effect.void });
  const peerAt = (port: number, certificate = far.certificate): Peer => ({
    installation: "vm-install",
    name: vm.label,
    dials: "out",
    url: `wss://127.0.0.1:${port}`,
    certificate,
    secret: SECRET,
  });
  return { dir, fake, far, handle, connect, peerAt };
});

/** Opens `/control` on the peer and answers the way it went and the first thing it heard. */
const reached = (
  peer: Peer,
  connection: Effect.Success<typeof rig>["handle"] | null,
  way?: Way,
): Effect.Effect<
  { way: Way; direct: string | null; heard: string },
  Effect.Error<ReturnType<typeof openPeer>>,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const opened = yield* openPeer(peer, () => "/control", Effect.succeed(connection), way);
    const heard = yield* Effect.callback<string>((resume) =>
      opened.listen(
        (data) => resume(Effect.succeed(new TextDecoder().decode(data))),
        () => {},
      ),
    );
    return { way: opened.way, direct: opened.direct, heard };
  });

const mux = (calls: ReadonlyArray<string>, verb: string) =>
  Arr.filter(calls, (line) => pipe_(line, Str.startsWith(`mux ${verb}`)));

test("a peer whose port answers is opened direct, with no forward made", () =>
  runEffect(
    Effect.gen(function* () {
      const { far, fake, handle, peerAt } = yield* rig;
      const opened = yield* Effect.scoped(reached(peerAt(far.port), handle));
      expect(opened).toEqual({ way: "direct", direct: null, heard: "at /control" });
      expect(mux(yield* fake.calls, "")).toEqual([]);
    }),
  ));

test("a reset port is tried, then the tunnel through an open connection, which every forward's scope cancels", () =>
  runEffect(
    Effect.gen(function* () {
      const { far, fake, handle, connect, peerAt } = yield* rig;
      const blocked = yield* resetting;
      yield* connect;
      yield* fake.maps({ [blocked.port]: far.port });
      const opened = yield* Effect.scoped(reached(peerAt(blocked.port), handle));
      expect(opened.way).toBe("ssh");
      expect(opened.heard).toBe("at /control");
      expect(opened.direct).toContain(`wss://127.0.0.1:${blocked.port}`);
      const calls = yield* fake.calls;
      expect(mux(calls, "forward")).toHaveLength(1);
      expect(mux(calls, "cancel")).toHaveLength(1);
      expect(pipe_(mux(calls, "cancel")[0]!, Str.slice("mux cancel".length))).toBe(
        pipe_(mux(calls, "forward")[0]!, Str.slice("mux forward".length)),
      );
      expect(Arr.some(calls, (line) => pipe_(line, Str.startsWith("login")))).toBe(false);
    }),
  ));

test(
  "a port that never answers fails direct at its bound, and the tunnel is tried",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { far, fake, handle, connect, peerAt } = yield* rig;
        const quiet = portOf(yield* silent);
        yield* connect;
        yield* fake.maps({ [quiet]: far.port });
        const opened = yield* Effect.scoped(reached(peerAt(quiet), handle));
        expect(opened.way).toBe("ssh");
        expect(opened.direct).toBe(`no answer from wss://127.0.0.1:${quiet} within 5 seconds`);
      }),
    ),
  15_000,
);

test("a blocked port with no connection open waits on one, having only checked for it", () =>
  runEffect(
    Effect.gen(function* () {
      const { fake, handle, peerAt } = yield* rig;
      const blocked = yield* resetting;
      const failed = yield* Effect.scoped(reached(peerAt(blocked.port), handle)).pipe(Effect.flip);
      expect(failed._tag).toBe("MachineUnreachable");
      expect(failed.seen).toContain(`wss://127.0.0.1:${blocked.port}`);
      expect(failed.seen).toContain(
        "no SSH connection is open; `collie machine connect vm-mk` opens one",
      );
      expect(failed.waits).toBe("ssh_connection");
      expect(yield* fake.calls).toEqual(["mux check mk@vm-mk"]);

      const unlisted = yield* Effect.scoped(reached(peerAt(blocked.port), null)).pipe(Effect.flip);
      expect(unlisted.ssh).toBe("herdr lists no machine vm-mk");
      expect(unlisted.waits).toBeUndefined();
    }),
  ));

test(
  "a forward ssh refuses, a tunnel that does not answer, and a tunnel to another certificate are each the SSH way's failure",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { dir, far, fake, handle, connect, peerAt } = yield* rig;
        const blocked = yield* resetting;
        yield* connect;

        const taken = yield* silent;
        const refusing = { ...handle, forward: () => handle.forward(portOf(taken), far.port) };
        const refused = yield* Effect.scoped(reached(peerAt(blocked.port), refusing)).pipe(
          Effect.flip,
        );
        expect(refused.ssh).toContain("did not forward");

        const quiet = portOf(yield* silent);
        yield* fake.maps({ [blocked.port]: quiet });
        const unanswered = yield* Effect.scoped(reached(peerAt(blocked.port), handle)).pipe(
          Effect.flip,
        );
        expect(unanswered.ssh).toBe("no answer through the SSH connection within 5 seconds");

        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${dir}/other`);
        const other = yield* listener(`${dir}/other`);
        yield* fake.maps({ [blocked.port]: far.port });
        const pinned = yield* Effect.scoped(
          reached(peerAt(blocked.port, other.certificate), handle),
        ).pipe(Effect.flip);
        expect(pinned.ssh).toBe("the SSH connection's tunnel refused the connection");

        const calls = yield* fake.calls;
        expect(mux(calls, "forward").length).toBeGreaterThanOrEqual(2);
        expect(mux(calls, "cancel")).toHaveLength(mux(calls, "forward").length - 1);
      }),
    ),
  15_000,
);

test("a way given is the only way tried", () =>
  runEffect(
    Effect.gen(function* () {
      const { far, fake, handle, connect, peerAt } = yield* rig;
      const blocked = yield* resetting;
      yield* connect;
      yield* fake.maps({ [blocked.port]: far.port });
      const before = blocked.accepted();
      const tunnelled = yield* Effect.scoped(reached(peerAt(blocked.port), handle, "ssh"));
      expect(tunnelled).toMatchObject({ way: "ssh", direct: null });
      expect(blocked.accepted()).toBe(before);

      const calls = (yield* fake.calls).length;
      const direct = yield* Effect.scoped(reached(peerAt(blocked.port), handle, "direct")).pipe(
        Effect.flip,
      );
      expect(Option.fromNullishOr(direct.ssh)).toEqual(Option.none());
      expect((yield* fake.calls).length).toBe(calls);
    }),
  ));
