// The one way Collie gives a login a pseudo-terminal: util-linux `script` on Linux and BSD
// `script` on macOS, which takes neither `-e`, `-f` nor `-c`.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { scriptCommand, scriptLine } from "../src/script";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const LOGIN = `BROWSER='/tmp/a b/shim' claude mcp login "linear server"`;

test.each<[NodeJS.Platform, [string, ...string[]]]>([
  ["linux", ["script", "-qefc", LOGIN, "/dev/null"]],
  ["darwin", ["script", "-q", "/dev/null", "/bin/sh", "-c", LOGIN]],
])("on %s a login runs under that platform's script, as one argument", (platform, argv) =>
  expect(scriptCommand(LOGIN, platform)).toEqual(argv),
);

test.each([
  ["Darwin", "darwin"],
  ["Linux", "linux"],
  ["", "linux"],
] as const)("a line run on a Machine whose uname says %p takes the %s form", (system, platform) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* fs.makeTempDirectoryScoped({
        prefix: "collie-script-",
      });
      yield* fs.writeFileString(`${bin}/uname`, `#!/bin/sh\necho '${system}'\n`, {
        mode: 0o755,
      });
      yield* fs.writeFileString(`${bin}/script`, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, {
        mode: 0o755,
      });
      const ran = yield* exec(["/bin/sh", "-c", scriptLine(LOGIN)], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
      });
      expect(ran.stdout).toBe(`${scriptCommand(LOGIN, platform).slice(1).join("\n")}\n`);
    }).pipe(Effect.scoped),
  ),
);
