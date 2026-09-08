// The local server two harness adapters each need: Codex's App Server, whose port is
// only on its own stdout, and the OpenCode `serve` that exists just long enough to
// create a session. Both said the same thing twice until this seam existed — and the
// half that had no test was the half that read its log before the shell had made it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { servedEndpoint } from "../src/compactors";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;
const started: number[] = [];

/** Whether a pid is still there, which is what a stopped server is not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in server: it says what it was told to say, after the delay it was told to
 * wait, and then stays up like a real one. A script rather than a shell one-liner
 * because `command` is one command — the seam adds the `exec` and the redirect.
 */
const stand = Effect.fn("test.stand")(function* (says: string, after = "0") {
  const script = path.join(dir, "stand-in.sh");
  yield* fs.writeFileString(script, `#!/bin/sh\nsleep ${after}\necho '${says}'\nsleep 30\n`);
  return `sh ${script}`;
});

const serve = (command: string, listening: RegExp, startMs = 5_000) =>
  servedEndpoint({
    cwd: rig.projectDir,
    log: path.join(dir, "server.log"),
    command,
    listening,
    startMs,
    what: "the stand-in server",
  }).pipe(
    Effect.tap((served) =>
      Effect.sync(() => {
        started.push(served.pid);
      }),
    ),
  );

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
      started.length = 0;
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      for (const pid of started) {
        yield* Effect.ignore(Effect.sync(() => process.kill(pid, "SIGKILL")));
      }
      yield* rig.close();
    }),
  ),
);

test("the line the server prints is what comes back, and the server outlives the call", () =>
  runEffect(
    Effect.gen(function* () {
      const served = yield* serve(
        yield* stand("listening on: ws://127.0.0.1:34567"),
        /ws:\/\/127\.0\.0\.1:(\d+)/,
      );

      // Group 1 where the pattern has one: Codex's port is read out of its own log.
      expect(served.found).toBe("34567");
      // Detached and unreffed, or the spawner's own finalizer would take down the
      // server it just started — and this endpoint has to outlive the Run.
      expect(alive(served.pid)).toBe(true);
    }),
  ));

test("a pattern with nothing to capture still says the server is up", () =>
  runEffect(
    Effect.gen(function* () {
      const served = yield* serve(
        yield* stand("opencode server listening on http://127.0.0.1:1234"),
        /http:\/\/127\.0\.0\.1:\d+/,
      );

      expect(served.found).toBe("");
      expect(alive(served.pid)).toBe(true);
    }),
  ));

test("the log is there to be read before the server has written a byte of it", () =>
  runEffect(
    Effect.gen(function* () {
      // The server takes its time; the wait still has a file to read, which is what a
      // launch that failed on a missing log did not.
      const served = yield* serve(
        yield* stand("up on ws://127.0.0.1:22222", "0.6"),
        /ws:\/\/127\.0\.0\.1:(\d+)/,
      );

      expect(served.found).toBe("22222");
    }),
  ));

test("a server that never says it is up fails with what to look at", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* serve(yield* stand("nothing to see"), /never/, 600).pipe(
        Effect.result,
      );

      expect(failure._tag).toBe("Failure");
      expect(String(failure)).toContain("the stand-in server");
      expect(String(failure)).toContain(path.join(dir, "server.log"));
    }),
  ));

test("what the server printed stays in the agent's own log, for the human", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve(yield* stand("listening on: ws://127.0.0.1:34567"), /:(\d+)/);

      const written = yield* fs.readFileString(path.join(dir, "server.log"));
      expect(written).toContain("ws://127.0.0.1:34567");
    }),
  ));
