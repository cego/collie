// `collie upgrade` on a legacy clone at the Collie directory: the target release's runner
// places the release inside it, and the clone is deleted only when nothing in it is the
// human's. Real git, because that is git's answer.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { upgrade } from "../src/operations";
import { ownPlatform } from "../src/releases";
import { signRelease } from "../src/signing";

let rig: Rig;
let origin: string;
let clone: string;
let served: ReturnType<typeof Bun.serve>;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const ASSET = `collie-${ownPlatform()}`;

const git = (cwd: string, ...args: string[]) =>
  exec(["git", ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: rig.root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).pipe(
    Effect.flatMap((done) =>
      done.exitCode === 0
        ? Effect.succeed(Str.trim(done.stdout))
        : Effect.die(new Error(`git ${Arr.join(args, " ")}: ${done.stderr}`)),
    ),
  );

const write = (file: string, text: string) => Effect.promise(() => Bun.write(file, text));

/** The release's runner: it places a stand-in release and answers as an upgrade. */
const RUNNER = new TextEncoder().encode(`#!/bin/sh
mkdir -p "$COLLIE_DIR/release"
echo '{"version":"99.0.0","files":{}}' > "$COLLIE_DIR/release/placed.json"
echo "$HERDR_PLUGIN_ROOT $*" > "$COLLIE_DIR/../handed-off"
echo '{"ok":true,"data":{"root":"'"$COLLIE_DIR"'/release","checkout":false,"release":"99.0.0","kept":[],"steps":[{"step":"plugin-link","state":"done","detail":""}]}}'
`);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      origin = `${rig.root}/origin`;
      clone = `${rig.root}/collie`;
      yield* exec(["mkdir", "-p", origin]);
      yield* git(origin, "init", "--quiet", "-b", "master");
      yield* write(`${origin}/version`, "0.1.0\n");
      yield* write(`${origin}/.gitignore`, "bin/\nnode_modules/\nuser/\n.env\n");
      yield* git(origin, "add", ".");
      yield* git(origin, "commit", "--quiet", "-m", "0.1.0");
      yield* git(rig.root, "clone", "--quiet", origin, clone);
      // What an install already holds that is Collie's or the human's by design.
      yield* write(`${clone}/bin/collie`, "the runner built here\n");
      yield* write(`${clone}/user/config.json`, `{"mine":true}\n`);
      served = Bun.serve({
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/latest") {
            return new Response(null, { status: 302, headers: { location: "/tag/99.0.0" } });
          }
          if (path === `/download/99.0.0/${ASSET}`) return new Response(RUNNER);
          if (path === `/download/99.0.0/${ASSET}.sig`) {
            return new Response(
              signRelease(RUNNER, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
            );
          }
          return new Response("no", { status: 404 });
        },
      });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.promise(() => served.stop(true));
      yield* rig.close();
    }),
  ),
);

const migrate = (live: ReadonlyArray<string> | null = []) => {
  const env = rig.pluginEnv();
  return upgrade(
    {
      ...env,
      pluginRoot: clone,
      collieDir: clone,
      userDir: `${clone}/user`,
      raw: { ...env.raw, COLLIE_RELEASES: `http://127.0.0.1:${served.port}` },
    },
    { key: KEY, liveCheckouts: Effect.succeed(live) },
  );
};

/** Every file in the clone but `.git`, `release/` and `kept/`, with its content. */
const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const all = yield* fs.readDirectory(clone, { recursive: true });
  const kept: Record<string, string> = {};
  for (const name of all.sort()) {
    if (/^(\.git|release|kept)(\/|$)/.test(name)) continue;
    const at = `${clone}/${name}`;
    if ((yield* fs.stat(at)).type === "File") kept[name] = yield* fs.readFileString(at);
  }
  return kept;
});

/** What git says of the clone, without the two entries a migration adds to its excludes. */
const status = Effect.gen(function* () {
  const said = yield* git(clone, "status", "--porcelain", "--ignored");
  return Arr.join(
    Arr.filter(Str.split(said, "\n"), (line) => line !== "!! release/" && line !== "!! kept/"),
    "\n",
  );
});

const keptFor = <E>(prepare: Effect.Effect<unknown, E, never>, why: RegExp) =>
  Effect.gen(function* () {
    yield* prepare;
    const before = { files: yield* files, status: yield* status };

    const migrated = yield* migrate();

    expect(migrated).toMatchObject({ ok: true, data: { release: "99.0.0" } });
    const clone_ = migrated.ok && "clone" in migrated.data ? migrated.data.clone : null;
    expect(clone_).toMatchObject({ kept: expect.arrayContaining([expect.stringMatching(why)]) });
    expect(migrated.ok && migrated.human).toMatch(why);
    expect(yield* files).toEqual(before.files);
    expect(yield* status).toBe(before.status);
  });

test("a pristine clone is replaced by the release, and the human's user/ stays", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const migrated = yield* migrate();

      expect(migrated).toMatchObject({ ok: true, data: { release: "99.0.0", clone: "removed" } });
      expect((yield* fs.readDirectory(clone)).sort()).toEqual(["release", "user"]);
      expect(yield* fs.readFileString(`${clone}/user/config.json`)).toBe(`{"mine":true}\n`);
      // The release's own runner did the placing, pointed at the release rather than the clone.
      expect(yield* fs.readFileString(`${rig.root}/handed-off`)).toBe(
        `${clone}/release --json upgrade --to 99.0.0\n`,
      );
    }),
  ));

test("the release is excluded by the clone before anything is written", () =>
  runEffect(
    Effect.gen(function* () {
      yield* write(`${clone}/notes.md`, "mine\n");

      yield* migrate();

      const exclude = yield* (yield* FileSystem.FileSystem).readFileString(
        `${clone}/.git/info/exclude`,
      );
      expect(exclude).toContain("/release/\n");
      expect(exclude).toContain("/kept/\n");
    }),
  ));

test("a changed file keeps the clone exactly as it was", () =>
  runEffect(keptFor(write(`${clone}/version`, "edited\n"), /changed or untracked/)));

test("an untracked file keeps the clone exactly as it was", () =>
  runEffect(keptFor(write(`${clone}/notes.md`, "mine\n"), /changed or untracked/)));

test("an ignored file of the human's keeps the clone exactly as it was", () =>
  runEffect(keptFor(write(`${clone}/.env`, "SECRET=1\n"), /ignored/)));

test("a commit no remote has keeps the clone exactly as it was", () =>
  runEffect(keptFor(git(clone, "commit", "--quiet", "--allow-empty", "-m", "mine"), /no remote/)));

test("a stash keeps the clone exactly as it was", () =>
  runEffect(
    keptFor(
      Effect.gen(function* () {
        yield* write(`${clone}/version`, "stashed\n");
        yield* git(clone, "stash", "--quiet");
      }),
      /stash/,
    ),
  ));

test("a linked worktree keeps the clone exactly as it was", () =>
  runEffect(
    keptFor(git(clone, "worktree", "add", "--quiet", `${rig.root}/side`, "-b", "side"), /worktree/),
  ));

test("a live Run working in the clone, or a host that cannot be asked, keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const working = yield* migrate([`${clone}/sub`]);
      expect(working.ok && "clone" in working.data && working.data.clone).toMatchObject({
        kept: [expect.stringMatching(/live Run/)],
      });
      const unasked = yield* migrate(null);
      expect(unasked.ok && "clone" in unasked.data && unasked.data.clone).toMatchObject({
        kept: [expect.stringMatching(/could not be asked/)],
      });
      expect(yield* fs.exists(`${clone}/.git`)).toBe(true);
      expect(yield* fs.readFileString(`${clone}/user/config.json`)).toBe(`{"mine":true}\n`);
    }),
  ));
