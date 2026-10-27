import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { Clock, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { certificateFor, pairWith, peersOf, relayOf } from "../src/peers";
import { connect, ownerOf } from "../src/host";
import { runEffect } from "./support/effect";
import { FakeBin } from "./support/bin";
import { twoMachines } from "./support/peers";
import { signalProcess } from "../src/lock";
import { exec } from "./support/command";
import { until } from "./support/host";

test(
  "a pairing whose invite never answers times out and closes its session",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pair-limit-" });
        const fifo = `${dir}/wait`;
        const bin = yield* FakeBin.make(`${dir}/bin`);
        yield* Effect.addFinalizer(() => bin.restore());
        yield* bin.add(
          "ssh",
          `[ "$1" = -G ] && { echo 'hostname 127.0.0.1'; exit 0; }
echo "$$" > '${dir}/started'
read -r approval < '${fifo}'`,
        );
        yield* exec(["mkfifo", fifo]);
        const clock = yield* TestClock.make();
        const pairing = yield* pairWith(
          { id: "vm", label: "vm", target: "mk@vm", session: "default", enabled: true },
          { installation: "requester", name: "laptop", control: `${dir}/control` },
        ).pipe(Effect.result, Effect.provideService(Clock.Clock, clock), Effect.forkChild);
        yield* until(
          () => fs.exists(`${dir}/started`),
          (exists) => exists,
        );
        yield* clock.adjust("2 minutes");
        const answer = yield* Fiber.join(pairing);
        expect(
          yield* signalProcess(Number((yield* fs.readFileString(`${dir}/started`)).trim())),
        ).toBe(false);
        expect(answer._tag).toBe("Failure");
        if (answer._tag === "Failure")
          expect(
            Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(answer.failure)
              .reason,
          ).toContain("within two minutes");
      }),
    ),
  30_000,
);

const Bound = Schema.Struct({ port: Schema.Number });

test(
  "a paired listener's occupied port is reported by machine list and doctor",
  () =>
    runEffect(
      Effect.gen(function* () {
        const server = createServer();
        const port = yield* Effect.callback<number>((resume) => {
          server.listen(0, "0.0.0.0", () =>
            resume(Effect.succeed(Schema.decodeUnknownSync(Bound)(server.address()).port)),
          );
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.close();
          }),
        );
        return yield* twoMachines(
          "collie-port-",
          (first, second) =>
            Effect.gen(function* () {
              yield* first.lists([second]);
              const pair = yield* first.cli(["--machine", "second", "board"]);
              expect(pair.envelope.ok).toBe(false);
              const listed = yield* second.cli(["machine", "list"]);
              const views = Schema.decodeUnknownSync(
                Schema.Struct({
                  machines: Schema.Array(Schema.Struct({ failure: Schema.NullOr(Schema.String) })),
                }),
              )(listed.envelope.data).machines;
              expect(
                views.some((one) => one.failure?.includes(`could not listen on port ${port}`)),
              ).toBe(true);
              const owner = yield* ownerOf(second.world.state);
              const checked = yield* second.cli(["doctor"]);
              const checks = Schema.decodeUnknownSync(
                Schema.Struct({
                  checks: Schema.Array(
                    Schema.Struct({
                      name: Schema.String,
                      ok: Schema.Boolean,
                      detail: Schema.String,
                    }),
                  ),
                }),
              )(checked.envelope.data ?? checked.envelope.error?.details).checks;
              expect(checks.find((one) => one.name === "paired links")).toMatchObject({
                ok: false,
                detail: expect.stringContaining(`could not listen on port ${port}`),
              });
              yield* Effect.callback<void>((resume) => {
                server.close(() => resume(Effect.void));
              });
              const recovered = yield* second.cli(["machine", "list"]);
              expect(recovered.envelope.data).toMatchObject({
                machines: [{ failure: "no control link from it yet" }],
              });
              expect((yield* ownerOf(second.world.state))?.pid).toBe(owner?.pid);
              expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            }),
          [],
          { ports: { second: port } },
        );
      }),
    ),
  120_000,
);

test(
  "replacing a pairing changes its relay name and credentials without restarting either host",
  () =>
    runEffect(
      twoMachines(
        "collie-replace-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const renamed = { ...second, name: "second-renamed" };
            yield* first.lists([second, renamed]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const local = yield* connect(first.world.state);
            const remote = yield* connect(second.world.state);
            const owner = yield* ownerOf(first.world.state);
            const farOwner = yield* ownerOf(second.world.state);
            const peer = (yield* peersOf(first.world.state))[0]!;
            const changed = { ...peer, name: renamed.name };
            yield* local.pair({ peer: changed });
            expect((yield* first.cli(["--machine", renamed.name, "board"])).envelope.ok).toBe(true);
            yield* until(
              () => fs.exists(relayOf(first.world.state, peer.name)),
              (exists) => !exists,
            );
            const inward = (yield* peersOf(second.world.state))[0]!;
            const secret = "replacement-credential";
            yield* remote.pair({ peer: { ...inward, secret } });
            yield* local.pair({
              peer: { ...changed, secret },
            });
            expect((yield* first.cli(["--machine", renamed.name, "board"])).envelope.ok).toBe(true);
            yield* until(
              () => remote.peers(),
              (peers) => peers.some((one) => one.state === "live"),
            );
            expect((yield* second.cli(["--machine", inward.name, "board"])).envelope.ok).toBe(true);
            expect((yield* ownerOf(first.world.state))?.pid).toBe(owner?.pid);
            expect((yield* ownerOf(second.world.state))?.pid).toBe(farOwner?.pid);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "repeated invitations keep one credential despite reversed replies",
  () =>
    runEffect(
      twoMachines(
        "collie-repeat-invite-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const caller = yield* connect(first.world.state);
            const receiver = yield* connect(second.world.state);
            const original = (yield* peersOf(first.world.state))[0]!;
            const inward = (yield* peersOf(second.world.state))[0]!;
            const invitations = yield* Effect.forEach(
              [0, 1],
              () =>
                receiver.invite({
                  for: inward.installation,
                  name: inward.name,
                  address: "127.0.0.1",
                }),
              { concurrency: "unbounded" },
            );
            expect(invitations.map((one) => one.secret)).toEqual([
              original.secret,
              original.secret,
            ]);
            for (const invitation of invitations.toReversed())
              yield* caller.pair({ peer: { ...original, secret: invitation.secret } });
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "address aliases keep the established certificate and reach both addresses",
  () =>
    runEffect(
      twoMachines(
        "collie-address-alias-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            const initial = yield* first.cli(["--machine", "second", "board"]);
            expect(initial.envelope.error).toBeUndefined();
            expect(initial.envelope.ok).toBe(true);
            const caller = yield* connect(first.world.state);
            const receiver = yield* connect(second.world.state);
            const original = (yield* peersOf(first.world.state))[0]!;
            const aliased = yield* receiver.invite({
              for: "third",
              name: "third",
              address: "127.0.0.2",
            });
            expect(aliased.certificate).toBe(original.certificate!);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            yield* caller.pair({
              peer: { ...original, url: original.url!.replace("127.0.0.1", "127.0.0.2") },
            });
            const reached = yield* first.cli(["--machine", "second", "board"]);
            expect(reached.envelope.error).toBeUndefined();
            expect(reached.envelope.ok).toBe(true);
            const fs = yield* FileSystem.FileSystem;
            const elsewhere = yield* certificateFor(
              yield* fs.makeTempDirectoryScoped({ prefix: "collie-wrong-pin-" }),
              "127.0.0.2",
            );
            yield* caller.pair({ peer: { ...original, certificate: elsewhere } });
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(false);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "simultaneous first pairing in both directions keeps a listener and matching credentials",
  () =>
    runEffect(
      twoMachines(
        "collie-cross-pair-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            yield* second.lists([first]);
            expect((yield* first.cli(["machine", "list"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["machine", "list"])).envelope.ok).toBe(true);
            const a = yield* connect(first.world.state);
            const b = yield* connect(second.world.state);
            const ai = (yield* a.identity()).installation!;
            const bi = (yield* b.identity()).installation!;
            const [toA, toB] = yield* Effect.all(
              [
                a.invite({ for: bi, name: second.name, address: "127.0.0.1" }),
                b.invite({ for: ai, name: first.name, address: "127.0.0.1" }),
              ],
              { concurrency: "unbounded" },
            );
            yield* Effect.all(
              [
                a.pair({
                  peer: {
                    installation: bi,
                    name: second.name,
                    dials: "out",
                    url: `wss://127.0.0.1:${toB.port}`,
                    certificate: toB.certificate,
                    secret: toB.secret,
                  },
                }),
                b.pair({
                  peer: {
                    installation: ai,
                    name: first.name,
                    dials: "out",
                    url: `wss://127.0.0.1:${toA.port}`,
                    certificate: toA.certificate,
                    secret: toA.secret,
                  },
                }),
              ],
              { concurrency: "unbounded" },
            );
            expect((yield* first.cli(["--machine", second.name, "board"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["--machine", first.name, "board"])).envelope.ok).toBe(true);
            const higher = ai > bi ? a : b;
            const lower = ai > bi ? b : a;
            const lowSide = ai > bi ? second : first;
            const highSide = ai > bi ? first : second;
            const delayed = yield* higher.invite({
              for: ai > bi ? bi : ai,
              name: lowSide.name,
              address: "127.0.0.1",
            });
            yield* lower.pair({
              peer: {
                installation: delayed.installation,
                name: highSide.name,
                dials: "out",
                url: `wss://127.0.0.1:${delayed.port}`,
                certificate: delayed.certificate,
                secret: delayed.secret,
              },
            });
            expect((yield* first.cli(["--machine", second.name, "board"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["--machine", first.name, "board"])).envelope.ok).toBe(true);
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "an opposite invitation preserves an established lower-id dialler",
  () =>
    runEffect(
      twoMachines(
        "collie-keep-direction-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            yield* second.lists([first]);
            expect((yield* first.cli(["machine", "list"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["machine", "list"])).envelope.ok).toBe(true);
            const a = yield* connect(first.world.state);
            const b = yield* connect(second.world.state);
            const ai = (yield* a.identity()).installation!;
            const bi = (yield* b.identity()).installation!;
            const low = ai < bi ? a : b;
            const high = ai < bi ? b : a;
            const lowSide = ai < bi ? first : second;
            const highSide = ai < bi ? second : first;
            const invited = yield* high.invite({
              for: ai < bi ? ai : bi,
              name: lowSide.name,
              address: "127.0.0.1",
            });
            yield* low.pair({
              peer: {
                installation: invited.installation,
                name: highSide.name,
                dials: "out",
                url: `wss://127.0.0.1:${invited.port}`,
                certificate: invited.certificate,
                secret: invited.secret,
              },
            });
            yield* until(
              () => high.peers(),
              (peers) => peers.some((peer) => peer.state === "live"),
            );
            const opposite = yield* low.invite({
              for: ai < bi ? bi : ai,
              name: highSide.name,
              address: "127.0.0.1",
            });
            expect(opposite.dials).toBe("in");
            yield* high.pair({
              peer: {
                installation: opposite.installation,
                name: lowSide.name,
                dials: opposite.dials!,
                secret: opposite.secret,
              },
            });
            expect((yield* low.peers())[0]?.dials).toBe("out");
            expect((yield* high.peers())[0]?.dials).toBe("in");
            expect((yield* lowSide.cli(["--machine", highSide.name, "board"])).envelope.ok).toBe(
              true,
            );
            expect((yield* highSide.cli(["--machine", lowSide.name, "board"])).envelope.ok).toBe(
              true,
            );
          }),
        [],
      ),
    ),
  120_000,
);

test(
  "concurrent invitations and additions keep every pairing and one serving listener",
  () =>
    runEffect(
      twoMachines(
        "collie-concurrent-pairs-",
        (first, second) =>
          Effect.gen(function* () {
            expect((yield* first.cli(["machine", "list"])).envelope.ok).toBe(true);
            expect((yield* second.cli(["machine", "list"])).envelope.ok).toBe(true);
            const caller = yield* connect(first.world.state);
            const receiver = yield* connect(second.world.state);
            const names = Array.from({ length: 8 }, (_, i) => `inviter-${i}`);
            const invited = yield* Effect.forEach(
              names,
              (name) =>
                receiver.invite({ for: name, name, address: "127.0.0.1" }).pipe(Effect.result),
              { concurrency: "unbounded" },
            );
            expect(invited.map((result) => result._tag)).toEqual(names.map(() => "Success"));
            expect((yield* receiver.peers()).map((peer) => peer.installation).sort()).toEqual(
              [...names].sort(),
            );
            expect(
              (yield* peersOf(second.world.state)).map((peer) => peer.installation).sort(),
            ).toEqual([...names].sort());
            const additions = yield* Effect.forEach(
              names,
              (installation) =>
                caller
                  .pair({
                    peer: {
                      installation,
                      name: installation,
                      dials: "in",
                      secret: `test-secret-${installation}`,
                    },
                  })
                  .pipe(Effect.result),
              { concurrency: "unbounded" },
            );
            expect(additions.map((result) => result._tag)).toEqual(names.map(() => "Success"));
            expect((yield* caller.peers()).map((peer) => peer.installation).sort()).toEqual(
              [...names].sort(),
            );
            expect(
              (yield* peersOf(first.world.state)).map((peer) => peer.installation).sort(),
            ).toEqual([...names].sort());
          }),
        [],
      ),
    ),
  120_000,
);
