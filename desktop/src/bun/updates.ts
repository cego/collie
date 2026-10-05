// Desktop's own updates. Electrobun's updater finds, downloads and installs them; nothing
// it prepared is installed until the tar it would install verifies against Collie's release
// key, because its bundle hash is not authentication. A Desktop run from a checkout is on
// a channel other than stable and never updates itself.

import { Effect, FileSystem, Schedule, Stream } from "effect";
import { appliedSignatureOf, RELEASE_PUBLIC_KEY, verifyRelease } from "../../../src/signing";
import type { UpdateNews } from "../shared/flock";

/** An update downloaded and unpacked, waiting to be installed. */
export interface Prepared {
  readonly version: string;
  readonly hash: string;
  /** The tar it installs. */
  readonly tar: string;
  /** The update archive it came from, which names its signature. */
  readonly artifact: string;
}

/** What Desktop needs of Electrobun's updater. */
export interface UpdaterPort {
  readonly channel: Effect.Effect<string>;
  /** The hash of the bundle running now. */
  readonly hash: Effect.Effect<string>;
  readonly check: Effect.Effect<{ readonly available: boolean; readonly version: string }, string>;
  readonly download: Effect.Effect<void, string>;
  readonly prepared: Effect.Effect<Prepared | null>;
  readonly discard: Effect.Effect<void>;
  /**
   * The signature `name` is published under in `version`'s release, which is the one the
   * update came from, or null where it has none.
   */
  readonly signatureOf: (name: string, version: string) => Effect.Effect<string | null>;
  /** Installs what is prepared, quitting Desktop and starting the new one; or says why not. */
  readonly apply: Effect.Effect<void, string>;
}

const CHECKOUT = "this Desktop runs from a checkout, which never updates itself";

/** Whether this Desktop updates itself: a release build does, and one from a checkout never. */
const released = (port: UpdaterPort) => Effect.map(port.channel, (channel) => channel === "stable");

/** Why the prepared update may not be installed, or null where its tar verifies. */
const refusalOf = (port: UpdaterPort, prepared: Prepared, key: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const name = appliedSignatureOf(prepared.artifact);
    const signature = name === null ? null : yield* port.signatureOf(name, prepared.version);
    const bytes = yield* fs.readFile(prepared.tar).pipe(Effect.orElseSucceed(() => null));
    if (bytes === null) return "its download is gone";
    const verified = verifyRelease(bytes, signature, key);
    return verified.ok ? null : verified.reason;
  });

/** The prepared update once it verifies; one that does not is thrown away and said. */
const verified = (port: UpdaterPort, key: string) =>
  Effect.gen(function* () {
    const prepared = yield* port.prepared;
    if (prepared === null || prepared.hash === (yield* port.hash)) return null;
    const refused = yield* refusalOf(port, prepared, key);
    if (refused === null) return { _tag: "Ready", version: prepared.version } satisfies UpdateNews;
    yield* port.discard;
    return { _tag: "Refused", version: prepared.version, reason: refused } satisfies UpdateNews;
  });

/**
 * Checks for an update now and every `every` after, downloading one it finds in the
 * background, and says each update once: ready to install, or refused.
 */
export const watchForUpdates = (
  port: UpdaterPort,
  key: string = RELEASE_PUBLIC_KEY,
  every: Schedule.Schedule<unknown> = Schedule.spaced("6 hours"),
): Stream.Stream<UpdateNews, never, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (!(yield* released(port))) return Stream.empty;
      const said = new Set<string>();
      const once = Effect.gen(function* () {
        const found = yield* port.check;
        if (!found.available) return [];
        yield* port.download;
        const news = yield* verified(port, key);
        if (news === null) return [];
        const id = `${news._tag} ${news.version}`;
        if (said.has(id)) return [];
        said.add(id);
        return [news];
      }).pipe(
        // A check or download that failed is tried again at the next one.
        Effect.catch((failed) =>
          Effect.logWarning(`Desktop update: ${failed}`).pipe(Effect.as([])),
        ),
      );
      return Stream.fromEffect(once).pipe(
        Stream.concat(Stream.fromSchedule(every).pipe(Stream.mapEffect(() => once))),
        Stream.flatMap((news) => Stream.fromIterable(news)),
      );
    }),
  );

/** Installs the prepared update once it verifies again, which restarts Desktop. */
export const restartToUpdate = (port: UpdaterPort, key: string = RELEASE_PUBLIC_KEY) =>
  Effect.gen(function* () {
    if (!(yield* released(port))) return yield* Effect.fail(CHECKOUT);
    const news = yield* verified(port, key);
    if (news === null) return yield* Effect.fail("there is no update ready");
    if (news._tag === "Refused") return yield* Effect.fail(news.reason);
    yield* port.apply;
  });

/**
 * At launch, installs an update readied before Desktop last quit, so it applies on the
 * next start without Desktop ever restarting itself. One that does not verify is thrown away.
 */
export const applyAtLaunch = (port: UpdaterPort, key: string = RELEASE_PUBLIC_KEY) =>
  Effect.gen(function* () {
    if (!(yield* released(port))) return;
    if ((yield* verified(port, key))?._tag === "Ready") yield* port.apply;
  });
