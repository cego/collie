// Desktop opened from the Dock inherits launchd's PATH, so on macOS it takes the one the
// user's login shell sets, as Terminal would.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { loginPath, MARK, pathIn } from "../desktop/src/bun/login-path";
import { runEffect } from "./support/effect";

test("the PATH is what the shell printed between the markers, whatever it printed around them", () => {
  expect(pathIn(`Last login: today\n${MARK}/opt/homebrew/bin:/usr/bin${MARK}\nbye\n`)).toBe(
    "/opt/homebrew/bin:/usr/bin",
  );
});

test("a shell that printed no markers, or was cut off after one, has said no PATH", () => {
  expect(pathIn("zsh: command not found: compinit\n")).toBeNull();
  expect(pathIn(`${MARK}/opt/homebrew/b`)).toBeNull();
});

/** A login shell that prints `body` as its own, and notes that it ran. */
const shell = (body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "collie-login-path-",
    });
    yield* fs.writeFileString(`${dir}/sh`, `#!/bin/sh\ntouch '${dir}/ran'\n${body}\n`, {
      mode: 0o755,
    });
    return { path: `${dir}/sh`, ran: fs.exists(`${dir}/ran`) };
  });

test("on macOS the login shell's PATH is read", () =>
  runEffect(
    Effect.gen(function* () {
      const login = yield* shell(`PATH=/opt/homebrew/bin:/usr/bin; eval "$2"`);
      expect(yield* loginPath("darwin", login.path)).toBe("/opt/homebrew/bin:/usr/bin");
    }).pipe(Effect.scoped),
  ));

test("a login shell that never answers leaves the inherited PATH", () =>
  runEffect(
    Effect.gen(function* () {
      const login = yield* shell("exec sleep 30");
      expect(yield* loginPath("darwin", login.path, "200 millis")).toBeNull();
    }).pipe(Effect.scoped),
  ));

test("on Linux the inherited PATH is kept and no shell is asked", () =>
  runEffect(
    Effect.gen(function* () {
      const login = yield* shell(`eval "$2"`);
      expect(yield* loginPath("linux", login.path)).toBeNull();
      expect(yield* login.ran).toBe(false);
    }).pipe(Effect.scoped),
  ));
