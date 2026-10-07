// Desktop's own updates. Electrobun's updater finds, downloads and installs them; nothing
// it prepared is installed until the tar it would install verifies against Collie's release
// key, because its bundle hash is not authentication. A Desktop run from a checkout is on
// a channel other than stable and never updates itself.

import { Deferred, Effect, FileSystem, Schedule, Stream, SubscriptionRef } from "effect";
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

export interface Updates {
  /** What the latest check found, from the one running now. */
  readonly news: Stream.Stream<UpdateNews>;
  /** Checks now, or joins the check already running, and says what it found. */
  readonly check: Effect.Effect<UpdateNews>;
}

/**
 * Checks for an update now and every `every` after, downloading one it finds in the
 * background. `version` is this Desktop's own.
 */
export const updatesOf = (
  port: UpdaterPort,
  version: string,
  key: string = RELEASE_PUBLIC_KEY,
  every: Schedule.Schedule<unknown> = Schedule.spaced("1 hour"),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scope = yield* Effect.scope;
    if (!(yield* released(port))) {
      const never: UpdateNews = { _tag: "Never", reason: CHECKOUT };
      return { news: Stream.make(never), check: Effect.succeed(never) } satisfies Updates;
    }
    const latest = yield* SubscriptionRef.make<UpdateNews>({ _tag: "Checking" });
    let running: Deferred.Deferred<UpdateNews> | undefined;
    const say = (news: UpdateNews) => SubscriptionRef.set(latest, news).pipe(Effect.as(news));
    const once = Effect.gen(function* () {
      // A ready update stays ready while Desktop looks for a newer one.
      if ((yield* SubscriptionRef.get(latest))._tag !== "Ready") yield* say({ _tag: "Checking" });
      const found = yield* port.check;
      if (!found.available) return yield* say({ _tag: "UpToDate", version });
      const ready = yield* verified(port, key);
      if (ready?.version !== found.version) {
        yield* say({ _tag: "Downloading", version: found.version });
        yield* port.download;
      }
      const news = yield* verified(port, key);
      return yield* say(news ?? { _tag: "UpToDate", version });
    }).pipe(
      // Tried again at the next check.
      Effect.catch((reason) =>
        Effect.flatMap(verified(port, key), (news) =>
          say(news?._tag === "Ready" ? news : { _tag: "Failed", reason }),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    // What `collie upgrade` staged, said without waiting for the next check.
    const staged = Effect.gen(function* () {
      const prepared = yield* port.prepared;
      const now = yield* SubscriptionRef.get(latest);
      const said = (now._tag === "Ready" || now._tag === "Refused") && now.version;
      if (prepared === null || running !== undefined || said === prepared.version) return;
      const news = yield* verified(port, key);
      if (news !== null) yield* say(news);
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    const check = Effect.suspend(() => {
      if (running !== undefined) return Deferred.await(running);
      const done = Deferred.makeUnsafe<UpdateNews>();
      running = done;
      return once.pipe(
        Effect.tap(() => Effect.sync(() => void (running = undefined))),
        Effect.flatMap((news) => Deferred.succeed(done, news)),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(done)),
      );
    });
    yield* check.pipe(Effect.repeat(every), Effect.forkIn(scope));
    yield* staged.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkIn(scope));
    return { news: SubscriptionRef.changes(latest), check } satisfies Updates;
  });

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
