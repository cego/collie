import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { forwarderCommand, forwarding } from "./support/forwarding";

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

const shim = (dir: string, name: string, stdout: (cwd: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const line = yield* forwarding("", ["fake"], (_argv, _env, cwd) =>
      Effect.succeed({ code: 0, stdout: stdout(cwd), stderr: "" }),
    );
    const file = `${dir}/${name}`;
    yield* fs.writeFileString(file, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
    return file;
  });

test("each of two fakes of one name answers from its own answerer", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "forwarder-" });
      const first = yield* shim(dir, "first", () => "first");
      const second = yield* shim(dir, "second", () => "second");
      expect([(yield* exec([first])).stdout, (yield* exec([second])).stdout]).toEqual([
        "first",
        "second",
      ]);
    }),
  ));

test("the answerer is told the directory the fake was started in", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "forwarder-" }));
      const fake = yield* shim(dir, "fake", (cwd) => cwd);
      expect((yield* exec([fake], { cwd: dir })).stdout).toBe(dir);
    }),
  ));
