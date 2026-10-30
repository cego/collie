// The board's line about a newer release, for an installation that is a release: read in the
// background at most every few minutes, and never waited on while the board draws.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { buildView, renderWorkspace } from "../src/workspace";
import manifest from "../herdr-plugin.toml";

/** A release source whose newest release is `latest`. */
const releasesAt = (latest: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch: () => new Response(null, { status: 302, headers: { location: `/tag/${latest}` } }),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}`));

/** A release source that takes the connection and never answers. */
const silent = Effect.acquireRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } })),
  (listener) => Effect.sync(() => listener.stop(true)),
).pipe(Effect.map((listener) => `http://127.0.0.1:${listener.port}`));

/** The board's text, built for a release at `root` against `releases`. */
const board = (root: string, releases: string) =>
  Effect.gen(function* () {
    const view = yield* buildView({
      session: null,
      workspaceId: null,
      workspaceLabel: null,
      cwd: root,
      stateDir: `${root}/state`,
      alive: [],
      runs: [],
      tasks: [],
      registered: [],
      pluginRoot: root,
      releases,
    });
    return renderWorkspace(view);
  });

/** The board once the read it started has landed, or what it says after a second. */
const settled = (root: string, releases: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 20; tries++) {
      const text = yield* board(root, releases);
      if (pipe_(text, Str.includes("is out"))) return text;
      yield* Effect.sleep("50 millis");
    }
    return yield* board(root, releases);
  });

const release = Effect.gen(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "release-" });
});

test("a release behind the newest says which is out, with the command", () =>
  runEffect(
    Effect.gen(function* () {
      const text = yield* settled(yield* release, yield* releasesAt("99.0.0"));

      expect(text).toContain("Collie 99.0.0 is out — collie upgrade");
    }),
  ));

test("a release at the newest, or one whose newest cannot be read, says nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const root = yield* release;
      expect(yield* settled(root, yield* releasesAt(manifest.version))).not.toContain("is out");
      expect(yield* settled(root, "http://127.0.0.1:9")).not.toContain("is out");
    }),
  ));

test("the board never waits on the read", () =>
  runEffect(
    Effect.gen(function* () {
      const releases = yield* silent;
      const started = yield* Clock.currentTimeMillis;

      const text = yield* board(yield* release, releases);

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
      expect(text).not.toContain("is out");
    }),
  ));
