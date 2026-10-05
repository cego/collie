// Desktop's own updates, through a stand-in for Electrobun's updater: checked at launch
// and every 6 hours, downloaded in the background, and applied only once the tar it would
// install verifies against Collie's release key.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import { signRelease } from "../src/signing";
import {
  type Prepared,
  type UpdaterPort,
  applyAtLaunch,
  restartToUpdate,
  watchForUpdates,
} from "../desktop/src/bun/updates";
import type { UpdateNews } from "../desktop/src/shared/flock";
import { fastForward } from "./support/effect";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

const TAR = new TextEncoder().encode("the 0.33.0 bundle");

interface Fake {
  readonly port: UpdaterPort;
  readonly calls: string[];
}

/** An updater that finds 0.33.0, whose tar is `bytes` once downloaded and signed `signature`. */
const fakeUpdater = (
  dir: string,
  options: {
    readonly channel?: string;
    readonly bytes?: Uint8Array;
    readonly signature: string | null;
    readonly preparedAtStart?: boolean;
    readonly applyRefused?: string;
  },
): Effect.Effect<Fake, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls: string[] = [];
    const tar = `${dir}/abc.tar`;
    let prepared = options.preparedAtStart === true;
    if (prepared) yield* fs.writeFile(tar, options.bytes ?? TAR).pipe(Effect.orDie);
    const ready: Prepared = {
      version: "0.33.0",
      hash: "abc",
      tar,
      artifact: "stable-linux-x64-collie-desktop.tar.zst",
    };
    const port: UpdaterPort = {
      channel: Effect.succeed(options.channel ?? "stable"),
      hash: Effect.succeed("old"),
      check: Effect.sync(() => {
        calls.push("check");
        return { available: true, version: "0.33.0" };
      }),
      download: Effect.gen(function* () {
        calls.push("download");
        yield* fs.writeFile(tar, options.bytes ?? TAR).pipe(Effect.orDie);
        prepared = true;
      }),
      prepared: Effect.sync(() => (prepared ? ready : null)),
      discard: Effect.gen(function* () {
        calls.push("discard");
        prepared = false;
        yield* fs.remove(tar, { force: true }).pipe(Effect.orDie);
      }),
      signatureOf: (name, version) =>
        Effect.sync(() => {
          calls.push(`signature ${name} from ${version}`);
          return options.signature;
        }),
      apply: Effect.sync(() => void calls.push("apply")).pipe(
        Effect.andThen(
          options.applyRefused === undefined ? Effect.void : Effect.fail(options.applyRefused),
        ),
      ),
    };
    return { port, calls };
  });

/** Runs `effect` with a scratch directory of its own for the updater's tar. */
const run = <A, E>(effect: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* effect(yield* fs.makeTempDirectoryScoped());
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

test("a signed update is checked for at launch, downloaded in the background and said to be ready, without being applied", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
      });
      const news = yield* watchForUpdates(port, key.publicKey).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(news).toEqual([{ _tag: "Ready", version: "0.33.0" }]);
      expect(calls).toEqual([
        "check",
        "download",
        "signature stable-linux-x64-collie-desktop.tar.sig from 0.33.0",
      ]);
    }),
  );
});

test("Desktop checks again every 6 hours, and says an update it already announced only once", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
      });
      const told: UpdateNews[] = [];
      yield* watchForUpdates(port, key.publicKey).pipe(
        Stream.runForEach((news) => Effect.sync(() => told.push(news))),
        Effect.forkScoped,
      );
      yield* Effect.sleep("5 hours");
      expect(calls.filter((call) => call === "check")).toHaveLength(1);
      yield* Effect.sleep("2 hours");
      expect(calls.filter((call) => call === "check")).toHaveLength(2);
      expect(told).toEqual([{ _tag: "Ready", version: "0.33.0" }]);
    }).pipe(Effect.scoped, (effect) => fastForward(effect, 60_000)),
  );
});

test("a tampered or unsigned update is refused, said so, and thrown away", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const tampered = yield* fakeUpdater(dir, {
        bytes: new TextEncoder().encode("something else"),
        signature: signRelease(TAR, key.privateKey),
      });
      const [refused] = yield* watchForUpdates(tampered.port, key.publicKey).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(refused).toMatchObject({ _tag: "Refused", version: "0.33.0" });
      expect(refused?._tag === "Refused" && refused.reason).toContain("does not match");
      expect(tampered.calls).toContain("discard");

      const unsigned = yield* fakeUpdater(dir, { signature: null });
      const [said] = yield* watchForUpdates(unsigned.port, key.publicKey).pipe(
        Stream.take(1),
        Stream.runCollect,
      );
      expect(said?._tag === "Refused" && said.reason).toContain("unsigned");
      expect(unsigned.calls).not.toContain("apply");
    }),
  );
});

test("a Desktop run from a checkout never checks for an update, and never applies one", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, {
        channel: "dev",
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
      });
      const news = yield* watchForUpdates(port, key.publicKey).pipe(Stream.runCollect);
      expect(news).toEqual([]);
      yield* applyAtLaunch(port, key.publicKey);
      expect(yield* restartToUpdate(port, key.publicKey).pipe(Effect.flip)).toContain("checkout");
      expect(calls).toEqual([]);
    }),
  );
});

test("Restart Desktop applies the update once its tar verifies again, and says why when Electrobun would not", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const good = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
      });
      yield* restartToUpdate(good.port, key.publicKey);
      expect(good.calls.at(-1)).toBe("apply");

      const vetoed = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
        applyRefused: "Update restart was cancelled by a before-quit handler",
      });
      expect(yield* restartToUpdate(vetoed.port, key.publicKey).pipe(Effect.flip)).toBe(
        "Update restart was cancelled by a before-quit handler",
      );
    }),
  );
});

test("an update readied before Desktop quit is applied as it launches, and only if it verifies", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const ready = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
      });
      yield* applyAtLaunch(ready.port, key.publicKey);
      expect(ready.calls.at(-1)).toBe("apply");

      const tampered = yield* fakeUpdater(dir, {
        bytes: new TextEncoder().encode("something else"),
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
      });
      yield* applyAtLaunch(tampered.port, key.publicKey);
      expect(tampered.calls).toContain("discard");
      expect(tampered.calls).not.toContain("apply");
    }),
  );
});
