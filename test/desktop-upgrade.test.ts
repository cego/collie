// `collie upgrade` brings Desktop on this computer to the same version, by staging the
// update the way Electrobun's own download does: never installed until it verifies, and
// never under a running Desktop. A throwaway data home and a local release, signed with a
// key of the test's own.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema, Scope } from "effect";
import { updateDesktop } from "../src/desktop";
import { upgrade } from "../src/operations";
import { signRelease } from "../src/signing";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const TAR = new TextEncoder().encode("the 0.34.0 bundle");
const ARTIFACT = "stable-linux-x64-collie-desktop.tar.zst";
const ROOT = "dk.cego.collie.desktop/stable";

interface Release {
  readonly base: string;
  readonly asked: string[];
}

/** Serves release 0.34.0 under `/download/0.34.0/`, its tar signed `signature`. */
const serveRelease = (signature: string | null, tar: Uint8Array = TAR) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const asked: string[] = [];
      const files = new Map<string, string | Uint8Array>([
        [
          "stable-linux-x64-update.json",
          asJson({
            schemaVersion: 1,
            identifier: "dk.cego.collie.desktop",
            channel: "stable",
            version: "0.34.0",
            hash: "new34",
            platform: "linux",
            arch: "x64",
            artifact: { file: ARTIFACT },
          }),
        ],
        [ARTIFACT, Bun.zstdCompressSync(tar)],
      ]);
      if (signature !== null) files.set("stable-linux-x64-collie-desktop.tar.sig", signature);
      const server = Bun.serve({
        port: 0,
        fetch: (request) => {
          const name = new URL(request.url).pathname.replace("/download/0.34.0/", "");
          asked.push(name);
          const body = files.get(name);
          return body === undefined ? new Response("", { status: 404 }) : new Response(body);
        },
      });
      return { server, asked };
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(
    Effect.map(({ server, asked }): Release => ({
      base: `http://localhost:${server.port}`,
      asked,
    })),
  );

/** A released Desktop installed at `version` under `data`, as Electrobun's installer leaves it. */
const install = (data: string, base: string, version: string, channel = "stable") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resources = `${data}/dk.cego.collie.desktop/${channel}/app/Resources`;
    yield* fs.makeDirectory(resources, { recursive: true });
    yield* fs.writeFileString(
      `${resources}/version.json`,
      asJson({
        version,
        hash: "old33",
        channel,
        identifier: "dk.cego.collie.desktop",
        name: "collie-desktop",
        baseUrl: `${base}/latest/download`,
      }),
    );
  });

const run = <A, E>(
  effect: (data: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* effect(yield* fs.makeTempDirectoryScoped());
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

const staged = (data: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const record = `${data}/${ROOT}/self-extraction/.electrobun-prepared-update.json`;
    if (!(yield* fs.exists(record))) return null;
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* fs.readFileString(record),
    );
  });

test("an older released Desktop gets the new version staged, verified, as Electrobun's download would leave it", () => {
  const key = pair();
  return run((data) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const release = yield* serveRelease(signRelease(TAR, key.privateKey));
      yield* install(data, release.base, "0.33.0");

      const step = yield* updateDesktop("0.34.0", {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: () => Effect.succeed(false),
      });

      expect(step).toEqual({
        step: "desktop",
        state: "done",
        detail: "Desktop 0.33.0 → 0.34.0 installs when Desktop next starts",
      });
      const tar = `${data}/${ROOT}/self-extraction/new34.tar`;
      expect(yield* staged(data)).toEqual({
        schema_version: 1,
        identifier: "dk.cego.collie.desktop",
        channel: "stable",
        version: "0.34.0",
        hash: "new34",
        platform: "linux",
        arch: "x64",
        retained_tar_path: tar,
        artifact_file: ARTIFACT,
      });
      expect(yield* fs.readFile(tar)).toEqual(TAR);
    }),
  );
});

test("a running Desktop is never replaced underneath it: the update applies on restart", () => {
  const key = pair();
  return run((data) =>
    Effect.gen(function* () {
      const release = yield* serveRelease(signRelease(TAR, key.privateKey));
      yield* install(data, release.base, "0.33.0");

      const step = yield* updateDesktop("0.34.0", {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: (app) => Effect.succeed(app === `${data}/${ROOT}/app`),
      });

      expect(step?.detail).toBe("Desktop 0.33.0 → 0.34.0 applies when you restart Desktop");
      expect(yield* staged(data)).toMatchObject({ version: "0.34.0" });
    }),
  );
});

test("a tampered or unsigned Desktop update is never staged, and says why", () => {
  const key = pair();
  return run((data) =>
    Effect.gen(function* () {
      const tampered = yield* serveRelease(
        signRelease(TAR, key.privateKey),
        new TextEncoder().encode("something else"),
      );
      yield* install(data, tampered.base, "0.33.0");
      const refused = yield* updateDesktop("0.34.0", {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: () => Effect.succeed(false),
      });
      expect(refused).toMatchObject({ step: "desktop", state: "failed" });
      expect(refused?.detail).toContain("does not match");
      expect(yield* staged(data)).toBeNull();

      const unsigned = yield* serveRelease(null);
      yield* install(data, unsigned.base, "0.33.0");
      const said = yield* updateDesktop("0.34.0", {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: () => Effect.succeed(false),
      });
      expect(said?.detail).toContain("unsigned");
      expect(yield* staged(data)).toBeNull();
    }),
  );
});

test("Desktop already at the version, as when it upgrades Local to its own, is left alone without a download", () => {
  const key = pair();
  return run((data) =>
    Effect.gen(function* () {
      const release = yield* serveRelease(signRelease(TAR, key.privateKey));
      yield* install(data, release.base, "0.34.0");

      const step = yield* updateDesktop("0.34.0", {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: () => Effect.succeed(true),
      });

      expect(step).toEqual({
        step: "desktop",
        state: "already in place",
        detail: "Desktop is at 0.34.0",
      });
      expect(release.asked).toEqual([]);
      expect(yield* staged(data)).toBeNull();
    }),
  );
});

test("no released Desktop, a development Desktop or a platform with no Desktop release is skipped quietly", () => {
  const key = pair();
  return run((data) =>
    Effect.gen(function* () {
      const release = yield* serveRelease(signRelease(TAR, key.privateKey));
      const options = {
        dataHome: data,
        key: key.publicKey,
        platform: "linux-x64",
        running: () => Effect.succeed(false),
      };
      expect(yield* updateDesktop("0.34.0", options)).toBeNull();

      yield* install(data, release.base, "0.33.0", "dev");
      expect(yield* updateDesktop("0.34.0", options)).toBeNull();

      yield* install(data, release.base, "0.33.0");
      expect(yield* updateDesktop("0.34.0", { ...options, platform: "darwin-arm64" })).toBeNull();
      expect(release.asked).toEqual([]);
    }),
  );
});

test("collie upgrade shows the Desktop step in its text and steps, and stages nothing Collie's own release key does not verify", () => {
  const other = pair();
  return runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      const bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* bin.add("git", `exit 1`);
      yield* bin.add("sh", `echo "prepare: runner: done"`);
      const release = yield* serveRelease(signRelease(TAR, other.privateKey));
      const data = `${rig.root}/.local/share`;
      yield* install(data, release.base, "0.33.0");

      // A plain install, whose manifest names the version it was moved to.
      yield* Effect.promise(() =>
        Bun.write(`${rig.projectDir}/herdr-plugin.toml`, 'version = "0.34.0"\n'),
      );

      const upgraded = yield* upgrade({ ...rig.pluginEnv(), pluginRoot: rig.projectDir });

      expect(upgraded.ok && upgraded.data.steps.at(-1)).toMatchObject({
        step: "desktop",
        state: "failed",
      });
      expect(upgraded.ok && upgraded.human).toMatch(
        /desktop\s+failed — Desktop 0.34.0 was not staged: .*does not match/,
      );
      expect(yield* staged(data)).toBeNull();
      yield* bin.restore();
      yield* rig.close();
    }).pipe(Effect.scoped),
  );
});
