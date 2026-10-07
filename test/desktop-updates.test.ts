// Desktop's own updates, through a stand-in for Electrobun's updater: checked at launch,
// every hour and when asked, downloaded in the background, and applied only once the tar it
// would install verifies against Collie's release key.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Deferred, Effect, Fiber, FileSystem, Schedule, Stream } from "effect";
import { BunServices } from "@effect/platform-bun";
import { signRelease } from "../src/signing";
import {
  type Prepared,
  type UpdaterPort,
  applyAtLaunch,
  restartToUpdate,
  updatesOf,
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
    /** Whether a check finds 0.33.0. */
    readonly available?: boolean;
    /** Why a check could not look. */
    readonly failing?: string;
    /** Held open until it is done, so a second check can arrive while it runs. */
    readonly downloading?: Deferred.Deferred<void>;
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
      check: Effect.suspend(() => {
        calls.push("check");
        return options.failing === undefined
          ? Effect.succeed({ available: options.available ?? true, version: "0.33.0" })
          : Effect.fail(options.failing);
      }),
      download: Effect.gen(function* () {
        calls.push("download");
        if (options.downloading !== undefined) yield* Deferred.await(options.downloading);
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

/** Every news `updates` gives while `during` runs. */
const told = <A, E, R>(
  updates: { readonly news: Stream.Stream<UpdateNews> },
  during: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const said: UpdateNews[] = [];
    yield* updates.news.pipe(
      Stream.runForEach((news) => Effect.sync(() => said.push(news))),
      Effect.forkScoped,
    );
    yield* during;
    return said;
  });

test("a signed update is checked for at launch, said to be downloading, then to be ready, without being applied", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
      });
      const updates = yield* updatesOf(port, "0.32.0", key.publicKey);
      const said = yield* told(updates, updates.check);
      expect(said.at(-1)).toEqual({ _tag: "Ready", version: "0.33.0" });
      expect(said).toContainEqual({ _tag: "Downloading", version: "0.33.0" });
      expect(calls).toEqual([
        "check",
        "download",
        "signature stable-linux-x64-collie-desktop.tar.sig from 0.33.0",
      ]);
    }).pipe(Effect.scoped),
  );
});

test("a check with nothing newer says this Desktop is up to date, and one that could not look says why", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const current = yield* fakeUpdater(dir, { signature: null, available: false });
      const latest = yield* updatesOf(current.port, "0.32.0", key.publicKey);
      expect(yield* latest.check).toEqual({ _tag: "UpToDate", version: "0.32.0" });
      expect(current.calls).not.toContain("download");

      const offline = yield* fakeUpdater(dir, { signature: null, failing: "HTTP 503" });
      const failed = yield* updatesOf(offline.port, "0.32.0", key.publicKey);
      expect(yield* failed.check).toEqual({ _tag: "Failed", reason: "HTTP 503" });
    }).pipe(Effect.scoped),
  );
});

test("a check asked for while one runs joins it rather than downloading twice", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const downloading = yield* Deferred.make<void>();
      const { port, calls } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        downloading,
      });
      const updates = yield* updatesOf(port, "0.32.0", key.publicKey);
      const asked = yield* Effect.all([updates.check, updates.check], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      yield* Effect.suspend(() =>
        calls.includes("download") ? Effect.void : Effect.fail("not yet"),
      ).pipe(Effect.retry(Schedule.spaced("5 millis")));
      yield* Deferred.succeed(downloading, undefined);
      const [first, second] = yield* Fiber.join(asked);
      expect(first).toEqual({ _tag: "Ready", version: "0.33.0" });
      expect(second).toEqual(first);
      expect(calls.filter((call) => call === "download")).toHaveLength(1);
      expect(calls.filter((call) => call === "check")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});

test("an update collie upgrade staged is said to be ready within a minute, without waiting for the next check", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        available: false,
        preparedAtStart: true,
      });
      const updates = yield* updatesOf(port, "0.32.0", key.publicKey);
      const said = yield* told(updates, Effect.sleep("2 minutes"));
      expect(said.at(-1)).toEqual({ _tag: "Ready", version: "0.33.0" });
    }).pipe(Effect.scoped, (effect) => fastForward(effect, 10_000)),
  );
});

test("a ready update stays ready through a later check, even one that could not look", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port } = yield* fakeUpdater(dir, {
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
        failing: "HTTP 503",
      });
      const updates = yield* updatesOf(port, "0.32.0", key.publicKey);
      expect(yield* updates.check).toEqual({ _tag: "Ready", version: "0.33.0" });
      const said = yield* told(updates, updates.check);
      expect(said).not.toContainEqual({ _tag: "Checking" });
      expect(said.at(-1)).toEqual({ _tag: "Ready", version: "0.33.0" });
    }).pipe(Effect.scoped),
  );
});

test("Desktop checks again every hour", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, { signature: null, available: false });
      yield* updatesOf(port, "0.32.0", key.publicKey);
      yield* Effect.sleep("50 minutes");
      expect(calls.filter((call) => call === "check")).toHaveLength(1);
      yield* Effect.sleep("20 minutes");
      expect(calls.filter((call) => call === "check")).toHaveLength(2);
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
      const refused = yield* (yield* updatesOf(tampered.port, "0.32.0", key.publicKey)).check;
      expect(refused).toMatchObject({ _tag: "Refused", version: "0.33.0" });
      expect(refused?._tag === "Refused" && refused.reason).toContain("does not match");
      expect(tampered.calls).toContain("discard");

      const unsigned = yield* fakeUpdater(dir, { signature: null });
      const said = yield* (yield* updatesOf(unsigned.port, "0.32.0", key.publicKey)).check;
      expect(said?._tag === "Refused" && said.reason).toContain("unsigned");
      expect(unsigned.calls).not.toContain("apply");
    }).pipe(Effect.scoped),
  );
});

test("a Desktop run from a checkout never checks for an update, says so, and never applies one", () => {
  const key = pair();
  return run((dir) =>
    Effect.gen(function* () {
      const { port, calls } = yield* fakeUpdater(dir, {
        channel: "dev",
        signature: signRelease(TAR, key.privateKey),
        preparedAtStart: true,
      });
      const updates = yield* updatesOf(port, "0.32.0", key.publicKey);
      const checked = yield* updates.check;
      expect(checked._tag).toBe("Never");
      expect(checked._tag === "Never" && checked.reason).toContain("checkout");
      yield* applyAtLaunch(port, key.publicKey);
      expect(yield* restartToUpdate(port, key.publicKey).pipe(Effect.flip)).toContain("checkout");
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
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
