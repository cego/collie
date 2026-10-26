import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { forwarderCommand } from "./support/forwarding";

test("a fake whose test process is gone fails loudly and answers nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const socket = `${yield* fs.makeTempDirectoryScoped({ prefix: "forwarder-" })}/nobody.sock`;
      const ran = yield* exec([...forwarderCommand(), "herdr", "agent", "list"], {
        env: { ...Bun.env, COLLIE_FAKE_SOCKET: socket },
      });
      expect({ failed: ran.exitCode !== 0, stdout: ran.stdout }).toEqual({
        failed: true,
        stdout: "",
      });
      expect(ran.stderr).toContain(socket);
    }),
  ));
