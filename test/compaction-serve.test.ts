import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { servedEndpoint } from "../src/compactors";
import { envLines } from "../src/profile";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pids = () => path.join(dir, "pids");

const stand = Effect.fn("test.stand")(function* (says: string, after = "0") {
  const script = path.join(dir, "stand-in.sh");
  yield* fs.writeFileString(
    script,
    `#!/bin/sh\necho $$ >> ${pids()}\nsleep ${after}\necho '${says}'\nexec sleep 30\n`,
  );
  return `sh ${script}`;
});

const serve = (command: string, listening: RegExp, startMs = 5000) =>
  servedEndpoint({
    cwd: rig.projectDir,
    log: path.join(dir, "server.log"),
    command,
    listening,
    startMs,
    what: "the stand-in server",
  });

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const recorded = (yield* fs.exists(pids())) ? yield* fs.readFileString(pids()) : "";
      for (const pid of Arr.filter(Str.split(recorded, "\n"), Boolean)) {
        yield* Effect.ignore(Effect.sync(() => process.kill(Number(pid), "SIGKILL")));
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

      expect(served.found).toBe("34567");
      // WARNING: Detached and unreffed, or the spawner's finalizer would kill the server it just started; it must outlive the Run.
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

test("the server starts with the agent's profile environment, a file-held value read by its shell", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fs.writeFileString(path.join(dir, "token"), "from-the-file\n");
      const script = path.join(dir, "env-stand-in.sh");
      yield* fs.writeFileString(
        script,
        `#!/bin/sh\necho $$ >> ${pids()}\necho "up:$MODE:$TOKEN"\nexec sleep 30\n`,
      );
      const served = yield* servedEndpoint({
        cwd: rig.projectDir,
        log: path.join(dir, "server.log"),
        command: `sh ${script}`,
        listening: /up:(.*)/,
        startMs: 5000,
        what: "the stand-in server",
        env: envLines({ MODE: "off", TOKEN: { file: "~/token" } }, dir),
      });

      expect(served.found).toBe("off:from-the-file");
    }),
  ));
