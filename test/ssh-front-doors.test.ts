// ADR-draft-a-blocked-link-rides-the-machines-ssh-connection, across two real hosts.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Schema, Scope, flow, Result } from "effect";
import { readEnv } from "../src/env";
import { machineList } from "../src/lifecycle";
import { peersOf } from "../src/peers";
import { PeerView } from "../src/peers-model";
import { runEffect } from "./support/effect";
import { blackhole, freePort, resetter } from "./support/fake-ssh";
import { stopHost, until } from "./support/host";
import { listenerPort, twoMachines, type Side } from "./support/peers";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const Listed = Schema.Struct({ machines: Schema.Array(PeerView) });
const Checks = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      detail: Schema.String,
      fix: Schema.String,
    }),
  ),
});

const listed = (side: Side, name: string) =>
  side.cli(["machine", "list"]).pipe(
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

const pairedLinks = (side: Side) =>
  side
    .cli(["doctor"])
    .pipe(
      Effect.map((read) =>
        Option.getOrUndefined(
          Arr.findFirst(
            flow(
              Schema.decodeUnknownResult(Checks),
              Result.getOrThrow,
            )(read.envelope.data ?? read.envelope.error?.details).checks,
            (one) => one.name === "paired links",
          ),
        )!,
      ),
    );

/** What the fake ssh logged from `from` on that starts as one of `kinds`. */
const logged = (side: Side, from: number, ...kinds: ReadonlyArray<string>) =>
  side.ssh.calls.pipe(
    Effect.map((all) =>
      Arr.filter(all.slice(from), (line) =>
        Arr.some(kinds, (kind) => pipe_(line, Str.startsWith(kind))),
      ),
    ),
  );

/** Every line of the log is the host's `-O` call or a front door's master or ride. */
const onlyMuxFromTheHost = (side: Side) =>
  side.ssh.calls.pipe(
    Effect.map((all) =>
      Arr.filter(all, (line) => !/^(master|ride|mux (check|forward|cancel|exit)) /.test(line)),
    ),
  );

test(
  "pairing rides one connection, a host job is refused while the link waits on one, and a command opens it and carries on",
  () =>
    runEffect(
      twoMachines(
        "collie-front-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            expect(yield* logged(first, 0, "master", "login")).toEqual(["master mk@second"]);
            const rides = yield* logged(first, 0, "ride");
            expect(rides).toHaveLength(1);
            expect(rides[0]).toContain(" machine invite --for ");

            // The network starts refusing the port: the link comes up over the open connection.
            const advertised = Number(yield* listenerPort(first, second));
            const moved = yield* freePort;
            const blocking = yield* Scope.make();
            yield* stopHost(second.world.state);
            yield* resetter(advertised).pipe(Scope.provide(blocking));
            yield* first.ssh.maps({ [advertised]: moved });
            yield* second.cli(["machine", "list"], { COLLIE_PEER_PORT: String(moved) });
            const paired = (yield* first.ssh.calls).length;
            const over = yield* until(
              () => listed(first, "second"),
              (view) => view.state === "live" && view.transport === "ssh",
            );
            expect(over.direct).toContain(`${advertised}`);
            expect(yield* logged(first, paired, "master", "login")).toEqual([]);
            const viaSsh = yield* pairedLinks(first);
            expect(viaSsh.ok).toBe(true);
            expect(viaSsh.detail).toBe(`second's link goes over SSH: direct ${over.direct}.`);

            // The connection drops: a host job is refused, and nothing logs in.
            yield* first.ssh.drop;
            yield* until(
              () => listed(first, "second"),
              (view) => view.waits === "ssh_connection",
            );
            const dropped = (yield* first.ssh.calls).length;
            const job = yield* machineList({
              ...readEnv(first.env),
              machine: "second",
              pairs: false,
            });
            expect(job.ok).toBe(false);
            if (!job.ok) {
              expect(job.error.code).toBe("machine_unreachable");
              expect(job.error.details?.waits).toBe("ssh_connection");
              expect(job.error.message).toBe(
                "second did not answer: its link waits on an SSH connection, and none is open; collie machine connect second opens one.",
              );
            }
            const waiting = yield* pairedLinks(first);
            expect(waiting).toMatchObject({
              ok: true,
              detail: "second's link waits on an SSH connection",
              fix: "collie machine connect second",
            });
            expect(yield* logged(first, dropped, "master", "login")).toEqual([]);

            // A command opens it, once, and carries on.
            const board = yield* first.cli(["--machine", "second", "board"]);
            expect(board.envelope.error).toBeUndefined();
            expect(yield* logged(first, dropped, "master", "login")).toEqual(["master mk@second"]);
            const live = yield* until(
              () => listed(first, "second"),
              (view) => view.state === "live",
            );
            expect(live.transport).toBe("ssh");
            const opened = (yield* first.ssh.calls).length;
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            expect(yield* logged(first, opened, "master", "login")).toEqual([]);
            expect(yield* onlyMuxFromTheHost(first)).toEqual([]);
            yield* Scope.close(blocking, Exit.void);
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "a link whose direct way never answers still says it waits on an SSH connection, and a command opens it",
  () =>
    runEffect(
      twoMachines(
        "collie-mute-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const advertised = Number(yield* listenerPort(first, second));
            const moved = yield* freePort;
            const muting = yield* Scope.make();
            yield* stopHost(second.world.state);
            yield* blackhole(advertised).pipe(Scope.provide(muting));
            yield* first.ssh.maps({ [advertised]: moved });
            yield* second.cli(["machine", "list"], { COLLIE_PEER_PORT: String(moved) });
            yield* first.ssh.drop;
            yield* until(
              () => listed(first, "second"),
              (view) => view.waits === "ssh_connection",
            );

            const job = yield* machineList({
              ...readEnv(first.env),
              machine: "second",
              pairs: false,
            });
            expect(job.ok).toBe(false);
            if (!job.ok) expect(job.error.details?.waits).toBe("ssh_connection");

            const dropped = (yield* first.ssh.calls).length;
            const board = yield* first.cli(["--machine", "second", "board"]);
            expect(board.envelope.error).toBeUndefined();
            expect(yield* logged(first, dropped, "master", "login")).toEqual(["master mk@second"]);
            yield* Scope.close(muting, Exit.void);
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "pairing whose connection ends before its invite fails with what ssh said and never logs in",
  () =>
    runEffect(
      twoMachines(
        "collie-ends-",
        (first, second) =>
          Effect.gen(function* () {
            yield* first.lists([second]);
            yield* first.ssh.dropsBeforeRide(true);
            const failed = yield* first.cli(["--machine", "second", "board"]);
            expect(failed.envelope.ok).toBe(false);
            expect(failed.envelope.error?.message).toContain(
              "Connection closed by UNKNOWN port 65535",
            );
            expect(yield* logged(first, 0, "login")).toEqual([]);
            expect(yield* logged(first, 0, "master")).toEqual(["master mk@second"]);
          }),
        [],
      ),
    ),
  120_000,
);
