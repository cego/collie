// The suite never reaches the operator's herd, even run from a herdr pane, whose shell
// exports the live session's socket and leaves the state directory to its default.

import { expect, test } from "bun:test";
import { userInfo } from "node:os";
import { Effect, FileSystem } from "effect";
import { readEnv } from "../src/env";
import { hosted, settledRun } from "./support/hosted";

const operatorHome = userInfo().homedir;

test("a test process sees no herdr session it was not given, and no default state directory of the operator's", () => {
  expect(Bun.env.HERDR_SOCKET_PATH).toBeUndefined();
  expect(Bun.env.COLLIE_USER_DIR).toBeUndefined();
  const env = readEnv(Bun.env);
  expect(env.home).not.toBe(operatorHome);
  expect(env.stateDir.startsWith(`${operatorHome}/`)).toBe(false);
});

test("a fixture Run started from a pane-like environment writes nothing outside the test's own directories", () => {
  // Checked first, so a suite that would still resolve the operator's directories touches nothing.
  const outside = readEnv(Bun.env);
  expect(outside.home).not.toBe(operatorHome);
  expect(outside.stateDir.startsWith(`${operatorHome}/`)).toBe(false);

  Bun.env.HERDR_SOCKET_PATH = `${outside.home}/pane-herdr.sock`;
  return hosted("collie-isolation-", ({ world }) =>
    Effect.gen(function* () {
      yield* settledRun(world, "hello");
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(outside.stateDir)).toBe(false);
      expect(yield* fs.exists(`${outside.home}/.local`)).toBe(false);
    }),
  ).finally(() => {
    delete Bun.env.HERDR_SOCKET_PATH;
  });
}, 60_000);
