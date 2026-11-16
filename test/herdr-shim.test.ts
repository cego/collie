// Herdr 1 is gone: a rig whose code runs `herdr` or opens the socket a host may still
// inherit as `HERDR_SOCKET_PATH` fails, naming the call.

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

const closing = (rig: Rig) => rig.close().pipe(Effect.exit);

test("a rig whose code runs herdr fails, naming the call", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const ran = yield* exec(["sh", "-c", "herdr agent list"], { env: rig.env() });
      expect(ran.exitCode).not.toBe(0);
      const closed = yield* closing(rig);
      expect(Exit.isFailure(closed)).toBe(true);
      expect(String(closed)).toContain("herdr agent list");
    }),
  ));

test("a rig whose code opens the inherited herdr socket fails", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      yield* Effect.callback<void>((resume) => {
        const done = () => resume(Effect.void);
        void Bun.connect({
          unix: rig.env().HERDR_SOCKET_PATH,
          socket: {
            open: (socket) => {
              socket.write('{"id":"1","method":"agent.list"}\n');
              socket.end();
              done();
            },
            data: () => {},
            connectError: done,
          },
        });
      });
      const closed = yield* closing(rig);
      expect(Exit.isFailure(closed)).toBe(true);
      expect(String(closed)).toContain("herdr socket");
    }),
  ));

test("a rig whose code never reaches herdr closes cleanly", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      expect(Exit.isSuccess(yield* closing(rig))).toBe(true);
    }),
  ));
