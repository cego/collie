// ADR-draft-a-blocked-link-rides-the-machines-ssh-connection: a resetter holds the port the
// second advertised, and the first's fake ssh forwards to where it moved.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Clock, Effect, Exit, FileSystem, Schema, Scope, flow, Result } from "effect";
import { connect } from "../src/host";
import { PeerView } from "../src/peers-model";
import { peersOf } from "../src/peers";
import { runEffect } from "./support/effect";
import { freePort, resetter } from "./support/fake-ssh";
import { stopHost, until } from "./support/host";
import { listenerPort, twoMachines, type Side } from "./support/peers";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Listed = Schema.Struct({ machines: Schema.Array(PeerView) });
const Connected = Schema.Struct({
  machine: Schema.String,
  path: Schema.String,
  opened: Schema.Boolean,
});
const Started = Schema.Struct({ runId: Schema.String });

/** How many times each side's `machine list` was read, each asking ssh's `-O check` once. */
const reads = new Map<string, number>();

/** How `side`'s `machine list` has the Machine `name`. */
const listed = (side: Side, name: string) =>
  side.cli(["machine", "list"]).pipe(
    Effect.tap(() => Effect.sync(() => reads.set(side.name, (reads.get(side.name) ?? 0) + 1))),
    Effect.map((read) => {
      const found = Option.getOrUndefined(
        Arr.findFirst(
          flow(Schema.decodeUnknownResult(Listed), Result.getOrThrow)(read.envelope.data).machines,
          (one) => one.name === name,
        ),
      );
      if (found === undefined)
        throw new Error(`${side.name} does not list ${name}: ${encode(read.envelope)}`);
      return found;
    }),
  );

const since = (side: Side, from: number) =>
  side.ssh.calls.pipe(Effect.map((all) => all.slice(from)));

test("an older Machine's list, without a link's way, still decodes", () => {
  const older = {
    installation: "i",
    name: "vm-mk",
    dials: "out",
    url: null,
    state: "live",
    since: null,
    failure: null,
  };
  expect(flow(Schema.decodeUnknownResult(PeerView), Result.getOrThrow)(older)).toMatchObject({
    transport: null,
    direct: null,
    ssh: null,
    connection: null,
    waits: null,
  });
});

test(
  "a link the network refuses waits on an SSH connection without a login, comes up over one that `machine connect` opens, and goes direct again by itself",
  () =>
    runEffect(
      twoMachines(
        "collie-over-ssh-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = `${second.world.home}/outputs.json`;
            yield* fs.writeFileString(
              outputs,
              encode(Array.from({ length: 8 }, () => ({ verdict: "done" }))),
            );
            const extra = { FAKE_HERDR_OUTPUTS: outputs };
            yield* second.cli(["machine", "list"], extra);
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            // Pairing's connection ends, as a laptop's does when it sleeps.
            yield* first.ssh.drop;
            const [laptop] = yield* peersOf(second.world.state);
            const advertised = Number(yield* listenerPort(first, second));
            const url = `wss://127.0.0.1:${advertised}`;

            // The network starts refusing the port: the listener moves, a resetter holds it.
            const moved = yield* freePort;
            const blocking = yield* Scope.make();
            // Counted from the stop, where the dialler's backoff starts, not the restart.
            const paired = (yield* first.ssh.calls).length;
            reads.set(first.name, 0);
            yield* stopHost(second.world.state);
            yield* resetter(advertised).pipe(Scope.provide(blocking));
            yield* first.ssh.maps({ [advertised]: moved });
            yield* second.cli(["machine", "list"], { ...extra, COLLIE_PEER_PORT: String(moved) });

            const waiting = yield* until(
              () => listed(first, "second"),
              (view) => view.waits === "ssh_connection",
            );
            expect(waiting.state).not.toBe("live");
            expect(waiting.direct).toContain(url);
            expect(waiting.connection).toBe(false);
            expect(waiting.ssh).toBe(
              "no SSH connection is open; `collie machine connect second` opens one",
            );

            // The dialler backs off to 8 s while it waits, having only checked.
            const checks = (from: number) =>
              since(first, from).pipe(
                Effect.map((calls) => {
                  expect(Arr.every(calls, (line) => line === "mux check mk@second")).toBe(true);
                  return calls.length;
                }),
              );
            const read = reads.get(first.name) ?? 0;
            yield* until(
              () => checks(paired),
              (count) => count >= read + 3,
            );
            const at = yield* Clock.currentTimeMillis;
            const connected = yield* first.cli(["machine", "connect", "second"]);
            expect(connected.envelope.error).toBeUndefined();
            const opened = yield* Schema.decodeUnknownEffect(Connected)(
              connected.envelope.data,
            ).pipe(Effect.orDie);
            expect(opened).toMatchObject({ machine: "second", opened: true });
            const live = yield* until(
              () => listed(first, "second"),
              (view) => view.state === "live",
            );
            expect((yield* Clock.currentTimeMillis) - at).toBeLessThan(7_000);
            expect(live).toMatchObject({ transport: "ssh", connection: true, waits: null });
            expect(live.direct).toContain(url);
            const theirs = yield* until(
              () => listed(second, laptop!.name),
              (view) => view.state === "live",
            );
            expect(theirs.transport).toBe("ssh");
            expect(theirs.direct).toBe(live.direct);

            const again = yield* first.cli(["machine", "connect", "second"]);
            expect(
              yield* Schema.decodeUnknownEffect(Connected)(again.envelope.data).pipe(Effect.orDie),
            ).toEqual({
              ...opened,
              opened: false,
            });
            const once = Arr.filter(
              yield* since(first, paired),
              (line) =>
                pipe_(line, Str.startsWith("master")) || pipe_(line, Str.startsWith("login")),
            );
            expect(once).toEqual(["master mk@second"]);

            // Runs go both ways through the tunnel while direct still resets.
            const started = yield* first.cli(
              ["--machine", "second", "run", "start", "attended", "--input", "work=over ssh"],
              extra,
            );
            expect(started.envelope.error).toBeUndefined();
            const { runId } = yield* Schema.decodeUnknownEffect(Started)(
              started.envelope.data,
            ).pipe(Effect.orDie);
            const there = yield* connect(second.world.state).pipe(Effect.orDie);
            yield* until(
              () => there.run({ runId }).pipe(Effect.orDie),
              (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
            );
            const steered = yield* first.cli(["run", "steer", runId, "hello over ssh"]);
            expect(steered.envelope.error).toBeUndefined();
            expect((yield* second.cli(["--machine", laptop!.name, "board"])).envelope.ok).toBe(
              true,
            );

            // Losing the connection loses the link, and nothing logs in.
            const before = (yield* first.ssh.calls).length;
            yield* first.ssh.drop;
            yield* until(
              () => listed(first, "second"),
              (view) => view.waits === "ssh_connection",
            );
            expect(
              Arr.filter(
                yield* since(first, before),
                (line) =>
                  pipe_(line, Str.startsWith("master")) || pipe_(line, Str.startsWith("login")),
              ),
            ).toEqual([]);

            // Lifting the block brings the next connect back direct.
            yield* Scope.close(blocking, Exit.void);
            yield* stopHost(second.world.state);
            yield* second.cli(["machine", "list"], extra);
            const direct = yield* until(
              () => listed(first, "second"),
              (view) => view.state === "live",
            );
            expect(direct.transport).toBe("direct");
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);
