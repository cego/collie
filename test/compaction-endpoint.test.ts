// Whether a recorded pid is still a compaction endpoint of Collie's, where there is no /proc
// to read it from, as on macOS: `ps` says what the process is.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { endpointPid } from "../src/compaction";
import { runEffect } from "./support/effect";

const asked = (running: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ps-" });
    yield* fs.writeFileString(
      `${bin}/ps`,
      `#!/bin/sh\n[ "$*" = "-ww -o command= -p 4242" ] && echo '${running}'\n`,
      { mode: 0o755 },
    );
    const path = Bun.env.PATH;
    Bun.env.PATH = `${bin}:${path ?? ""}`;
    return yield* endpointPid({ pid: 4242, command: "opencode serve" }, `${bin}/no-proc`).pipe(
      Effect.ensuring(Effect.sync(() => (Bun.env.PATH = path))),
    );
  }).pipe(Effect.scoped);

test("a pid whose command is the recorded endpoint is the endpoint", () =>
  runEffect(
    Effect.map(asked("/usr/local/bin/opencode serve --port 4096"), (pid) => expect(pid).toBe(4242)),
  ));

test("a pid that came round to another program is not", () =>
  runEffect(Effect.map(asked("vim notes.md"), (pid) => expect(pid).toBeNull())));
