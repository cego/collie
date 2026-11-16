// The Rune spike's shell services: a notification the main process asks the stdio stand-in for
// reaches the Rust side as one request. Needs cargo, which the `desktop` CI job has.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const WORKSPACE = new URL("../desktop/", import.meta.url).pathname;
const STAND_IN = new URL("../desktop/core/platform.ts", import.meta.url).pathname;
const cargo = Bun.which("cargo");

// The main process's side: the board's window takes the stand-in's stdout, then a Run asks.
const MAIN = `
import { BrowserWindow, Utils } from ${JSON.stringify(STAND_IN)};
new BrowserWindow({ rpc: { handlers: { messages: { frame: () => {} } } } });
Utils.showNotification({ title: "Needs you", body: "Release 0.119.0 asks a question", silent: false });
`;

describe.skipIf(cargo === null)("the shell's services", () => {
  let notices = "";
  beforeAll(
    () =>
      runEffect(
        Effect.gen(function* () {
          const built = yield* exec(
            [cargo!, "build", "--quiet", "-p", "collie-desktop-protocol", "--bin", "notices"],
            { cwd: WORKSPACE },
          );
          if (built.exitCode !== 0)
            throw new Error(`cargo could not build the notices binary: ${built.stderr}`);
          notices = `${WORKSPACE}target/debug/notices`;
        }),
      ),
    600_000,
  );

  test("a notification the main process asks for reaches the Rust side once, with its title and body", () =>
    runEffect(
      Effect.gen(function* () {
        const main = yield* exec([process.execPath, "-e", MAIN]);
        expect(main.exitCode).toBe(0);
        const heard = yield* exec([notices], { stdin: Buffer.from(main.stdout) });
        expect(heard.exitCode).toBe(0);
        expect(heard.stderr).toBe("");
        const lines = pipe(heard.stdout, Str.trim, Str.split("\n"), Arr.filter(Str.isNonEmpty));
        expect(Arr.map(lines, (line) => JSON.parse(line))).toEqual([
          { title: "Needs you", body: "Release 0.119.0 asks a question", silent: false },
        ]);
      }),
    ));
});
