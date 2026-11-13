// The Rune spike's updates: Desktop's own `updates.ts` checks, downloads and verifies a release
// as today, through the stdio stand-in's Updater, which stages the verified tar and its
// signature where the Rune shell installs them at its next launch (desktop-rune/update).

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as Str from "effect/String";
import { Effect, FileSystem, Schema } from "effect";
import { electrobunUpdater } from "../desktop/src/bun/electrobun-updater";
import { restartToUpdate, updatesOf } from "../desktop/src/bun/updates";
import { runEffect } from "./support/effect";

const FIXTURES = new URL("../desktop-rune/fixtures/update/", import.meta.url).pathname;
const OS = process.platform === "darwin" ? "macos" : "linux";
const PLATFORM = `${OS}-${process.arch}`;
const ARCHIVE = `stable-${PLATFORM}-collie-desktop.tar.zst`;
const KEY = await Bun.file(`${FIXTURES}release-test.pub`).text();
const TAR = await Bun.file(`${FIXTURES}bundle.tar`).bytes();

let signature = await Bun.file(`${FIXTURES}bundle.tar.sig`).text();
let hash = "new0131";
let published = "0.131.0";
let signatureStatus = 200;
const responseOf = (url: URL) => {
  const path = Str.replace(/^\/cego\/collie\/releases/, "")(url.pathname);
  if (path === `/latest/download/stable-${PLATFORM}-update.json`)
    return Response.json({
      schemaVersion: 1,
      identifier: "dk.cego.collie.desktop",
      channel: "stable",
      platform: OS,
      arch: process.arch,
      version: published,
      hash,
      artifact: { file: ARCHIVE },
    });
  if (path === `/latest/download/${ARCHIVE}`) return new Response(Bun.zstdCompressSync(TAR));
  if (path === `/download/0.131.0/stable-${PLATFORM}-collie-desktop.tar.sig`)
    return new Response(signature, { status: signatureStatus });
  return new Response("not found", { status: 404 });
};

// The production policy sees real release URLs; only the network edge is replaced.
const network = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(init?.redirect).toBe("manual");
      if (url.origin !== "https://github.com")
        return Promise.reject(new Error("unexpected test request"));
      return Promise.resolve(responseOf(url));
    },
    { preconnect: () => {} },
  ),
);

const VersionJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
    hash: Schema.String,
  }),
);

let install = "";
let standIn: typeof import("../desktop-rune/core/platform");
beforeAll(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      install = yield* fs.makeTempDirectory({ prefix: "collie-rune-updater-" });
      yield* fs.makeDirectory(`${install}/collie-desktop`);
      yield* fs.writeFileString(
        `${install}/collie-desktop/version.json`,
        yield* Schema.encodeEffect(VersionJson)({
          version: "0.130.0",
          channel: "stable",
          identifier: "dk.cego.collie.desktop",
          baseUrl: "https://github.com/cego/collie/releases/latest/download",
          hash: "old0130",
        }),
      );
      Bun.env.COLLIE_RUNE_VERSION = `${install}/collie-desktop/version.json`;
      Bun.env.COLLIE_RUNE_STAGED = `${install}/.update/collie-desktop.tar`;
      Bun.env.COLLIE_RUNE_USER_DATA = `${install}/data`;
      standIn = yield* Effect.promise(() => import("../desktop-rune/core/platform"));
    }),
  ),
);
afterAll(() =>
  runEffect(
    Effect.gen(function* () {
      network.mockRestore();
      yield* (yield* FileSystem.FileSystem).remove(install, { recursive: true, force: true });
    }),
  ),
);

const releasedAt = (baseUrl: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(
      `${install}/collie-desktop/version.json`,
      yield* Schema.encodeEffect(VersionJson)({
        version: "0.130.0",
        channel: "stable",
        identifier: "dk.cego.collie.desktop",
        baseUrl,
        hash: "old0130",
      }),
    );
  });

const checked = Effect.gen(function* () {
  const port = yield* electrobunUpdater(standIn.Updater);
  const updates = yield* updatesOf(port, "0.130.0", KEY);
  const news = yield* updates.check;
  return { port, news };
});

test("a release Desktop's updates verify is staged, and the restart to it accepted, for the shell", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { port, news } = yield* checked;
      expect(news).toEqual({ _tag: "Ready", version: "0.131.0" });
      expect(yield* fs.exists(`${install}/.update`)).toBe(false);
      yield* restartToUpdate(port, KEY);
      expect(yield* fs.readFile(`${install}/.update/collie-desktop.tar`)).toEqual(TAR);
      expect(yield* fs.readFileString(`${install}/.update/collie-desktop.tar.sig`)).toBe(signature);
    }),
  ));

test("a release whose signature does not match is refused and nothing is staged", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${install}/.update`, { recursive: true, force: true });
      yield* fs.remove(`${install}/data`, { recursive: true, force: true });
      signature = yield* fs.readFileString(`${FIXTURES}truncated.tar.sig`);
      const { news } = yield* checked;
      expect(news).toMatchObject({ _tag: "Refused", version: "0.131.0" });
      expect(yield* fs.exists(`${install}/.update`)).toBe(false);
    }),
  ));

test("a release whose hash names a path is refused before anything is written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${install}/data`, { recursive: true, force: true });
      hash = "../../victim";
      const { news } = yield* checked;
      expect(news).not.toMatchObject({ _tag: "Ready" });
      expect(yield* fs.exists(`${install}/victim.tar`)).toBe(false);
      expect(yield* fs.exists(`${install}/data/self-extraction`)).toBe(false);
    }),
  ));

test("an update source outside Collie's releases is refused before download", () =>
  runEffect(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).writeFileString(
        `${install}/collie-desktop/version.json`,
        yield* Schema.encodeEffect(VersionJson)({
          version: "0.130.0",
          channel: "stable",
          identifier: "dk.cego.collie.desktop",
          baseUrl: "http://localhost:12345/latest/download",
          hash: "old0130",
        }),
      );
      const result = yield* Effect.promise(() => standIn.Updater.checkForUpdate());
      expect(result.updateAvailable).toBe(false);
      expect(result.error).toContain("not a Collie release");
    }),
  ));

test("a release that is not newer than this Desktop is not offered", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${install}/data`, { recursive: true, force: true });
      yield* releasedAt("https://github.com/cego/collie/releases/latest/download");
      hash = "new0131";
      signature = yield* fs.readFileString(`${FIXTURES}bundle.tar.sig`);
      for (const older of ["0.129.0", "0.130.0"]) {
        published = older;
        const found = yield* Effect.promise(() => standIn.Updater.checkForUpdate());
        expect(found).toMatchObject({ error: "", updateAvailable: false });
      }
      published = "0.131.0";
    }),
  ));

test("a signature the release could not serve fails the check instead of refusing the update", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${install}/data`, { recursive: true, force: true });
      yield* releasedAt("https://github.com/cego/collie/releases/latest/download");
      signatureStatus = 503;
      const { news } = yield* checked.pipe(
        Effect.ensuring(Effect.sync(() => (signatureStatus = 200))),
      );
      expect(news).toMatchObject({ _tag: "Failed" });
      expect(news._tag === "Failed" && news.reason).toContain("503");
      expect(yield* fs.exists(`${install}/data/self-extraction`)).toBe(true);
    }),
  ));

test("a release published without a signature is refused as unsigned and nothing is staged", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(`${install}/.update`, { recursive: true, force: true });
      yield* fs.remove(`${install}/data`, { recursive: true, force: true });
      yield* releasedAt("https://github.com/cego/collie/releases/latest/download");
      signatureStatus = 404;
      const { news } = yield* checked.pipe(
        Effect.ensuring(Effect.sync(() => (signatureStatus = 200))),
      );
      expect(news).toEqual({
        _tag: "Refused",
        version: "0.131.0",
        reason: "the download is unsigned, so it was refused",
      });
      expect(yield* fs.exists(`${install}/.update`)).toBe(false);
    }),
  ));
