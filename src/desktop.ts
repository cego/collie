// Collie Desktop on this computer, brought to the version `collie upgrade` moved to. The
// update is staged as Electrobun's own download leaves one — its tar and the prepared record
// beside it — and only once the tar verifies against the release key. Desktop installs it
// as it installs its own: on Restart Desktop, or as it next starts. Nothing here replaces a
// Desktop, running or not.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { RELEASE_TAG } from "./release";
import { appliedSignatureOf, RELEASE_PUBLIC_KEY, verifyRelease } from "./signing";

const IDENTIFIER = "dk.cego.collie.desktop";
/** The one platform Desktop is released for. */
const RELEASED_FOR = "linux-x64";
const PREFIX = `stable-${RELEASED_FOR}`;

// ponytail: Electrobun's own files, as electrobun 2.0.2 writes and reads them; recheck on an upgrade.
const Installed = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
  }),
);
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    identifier: Schema.Literal(IDENTIFIER),
    channel: Schema.Literal("stable"),
    platform: Schema.Literal("linux"),
    arch: Schema.Literal("x64"),
    version: Schema.String,
    hash: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,13}$/)),
    artifact: Schema.Struct({
      file: Schema.String.check(Schema.isPattern(new RegExp(`^${PREFIX}-[\\w.-]+\\.tar\\.zst$`))),
    }),
  }),
);
/** Where Electrobun records an update it has downloaded and unpacked, waiting to install. */
export const preparedRecordOf = (channelRoot: string) =>
  `${channelRoot}/self-extraction/.electrobun-prepared-update.json`;
export const PreparedRecord = Schema.fromJsonString(
  Schema.Struct({
    schema_version: Schema.Literal(1),
    identifier: Schema.String,
    channel: Schema.String,
    version: Schema.String,
    hash: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    retained_tar_path: Schema.String,
    artifact_file: Schema.String,
  }),
);

/** `version`'s own release, where `baseUrl` is the newest one's `latest/download`. */
export const releaseOf = (baseUrl: string, version: string) =>
  baseUrl.replace(/\/+$/, "").replace(/\/latest\/download$/, `/download/${version}`);

/** Where Electrobun installs per user: `$XDG_DATA_HOME` where it is absolute, else `~/.local/share`. */
export const dataHomeOf = (home: string, xdgDataHome: string | undefined) =>
  xdgDataHome !== undefined && xdgDataHome.startsWith("/") && xdgDataHome !== "/"
    ? xdgDataHome
    : `${home}/.local/share`;

export interface DesktopStep {
  readonly step: "desktop";
  readonly state: "done" | "already in place" | "failed";
  readonly detail: string;
}

export interface DesktopUpdateOptions {
  readonly dataHome: string;
  readonly key?: string;
  /** `<platform>-<arch>`, as Node names them. */
  readonly platform?: string;
  /** Whether a Desktop installed at `app` is running. */
  readonly running?: (app: string) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
}

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.mapError((failed) => `could not fetch ${url}: ${failed.message}`),
  );

const bodyOf = (url: string) =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.arrayBuffer.pipe(
            Effect.map((bytes) => new Uint8Array(bytes)),
            Effect.mapError((failed) => failed.message),
          )
        : Effect.fail(`${url} answered HTTP ${response.status}`),
    ),
  );

/** A signature that is not published is null, which verifying refuses as unsigned. */
const signatureAt = (url: string) =>
  fetched(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.text.pipe(Effect.mapError((failed) => failed.message))
        : Effect.succeed(null),
    ),
  );

/** Whether a process on this computer runs from under `app`, as `/proc` shows them. */
export const runningFrom = (app: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pids = yield* fs.readDirectory("/proc");
    for (const pid of pids.filter((name) => /^\d+$/.test(name))) {
      const exe = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.orElseSucceed(() => ""));
      if (exe.startsWith(`${app}/`)) return true;
    }
    return false;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Stages Desktop `to` where a released Desktop older than it is installed for this user, and
 * says so as one of `collie upgrade`'s steps; null where there is no such Desktop to update.
 */
export const updateDesktop = Effect.fn("desktop.update")(function* (
  to: string,
  {
    dataHome,
    key = RELEASE_PUBLIC_KEY,
    platform = `${process.platform}-${process.arch}`,
    running = runningFrom,
  }: DesktopUpdateOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (platform !== RELEASED_FOR || !RELEASE_TAG.test(to)) return null;
  const root = path.resolve(dataHome, IDENTIFIER, "stable");
  const app = path.join(root, "app");
  const installed = yield* fs
    .readFileString(path.join(app, "Resources", "version.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Installed)), Effect.option);
  if (
    Option.isNone(installed) ||
    installed.value.channel !== "stable" ||
    installed.value.identifier !== IDENTIFIER ||
    !RELEASE_TAG.test(installed.value.version)
  )
    return null;
  const from = installed.value.version;
  if (Bun.semver.order(from, to) >= 0) {
    return {
      step: "desktop",
      state: "already in place",
      detail: `Desktop is at ${from}`,
    } satisfies DesktopStep;
  }

  const staged = yield* fs
    .readFileString(preparedRecordOf(root))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreparedRecord)), Effect.option);
  // One already staged, by this or by Desktop's own download, is never replaced by an older one.
  const target = Option.match(staged, {
    onNone: () => to,
    onSome: ({ version }) => (Bun.semver.order(version, to) >= 0 ? version : to),
  });

  const staging = Effect.gen(function* () {
    const release = releaseOf(installed.value.baseUrl, to);
    const manifest = yield* bodyOf(`${release}/${PREFIX}-update.json`).pipe(
      Effect.flatMap((bytes) =>
        Schema.decodeUnknownEffect(Manifest)(new TextDecoder().decode(bytes)).pipe(
          Effect.mapError(() => `release ${to} has no Desktop update for ${RELEASED_FOR}`),
        ),
      ),
    );
    if (manifest.version !== to) {
      return yield* Effect.fail(`release ${to} offers Desktop ${manifest.version}`);
    }
    const archive = yield* bodyOf(`${release}/${manifest.artifact.file}`);
    const tar = yield* Effect.tryPromise({
      try: () => Bun.zstdDecompress(archive),
      catch: () => `${manifest.artifact.file} is not a zstd archive`,
    });
    const signature = yield* signatureAt(
      `${release}/${appliedSignatureOf(manifest.artifact.file)}`,
    );
    const verified = verifyRelease(tar, signature, key);
    if (!verified.ok) return yield* Effect.fail(verified.reason);

    const extraction = path.join(root, "self-extraction");
    const retained = path.join(extraction, `${manifest.hash}.tar`);
    yield* fs.makeDirectory(extraction, { recursive: true });
    yield* fs.writeFile(`${retained}.partial`, tar);
    yield* fs.rename(`${retained}.partial`, retained);
    const record = preparedRecordOf(root);
    yield* fs.writeFileString(
      `${record}.partial`,
      yield* Schema.encodeEffect(PreparedRecord)({
        schema_version: 1,
        identifier: IDENTIFIER,
        channel: "stable",
        version: manifest.version,
        hash: manifest.hash,
        platform: "linux",
        arch: "x64",
        retained_tar_path: retained,
        artifact_file: manifest.artifact.file,
      }),
    );
    yield* fs.rename(`${record}.partial`, record);
    if (Option.isSome(staged) && staged.value.retained_tar_path !== retained)
      yield* fs.remove(staged.value.retained_tar_path, { force: true });
  });

  return yield* (target === to ? staging : Effect.void).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError(String),
    Effect.andThen(running(app)),
    Effect.match({
      onFailure: (reason): DesktopStep => ({
        step: "desktop",
        state: "failed",
        detail: `Desktop ${to} was not staged: ${reason}`,
      }),
      onSuccess: (live): DesktopStep => ({
        step: "desktop",
        state: "done",
        detail: `Desktop ${from} → ${target} ${live ? "applies when you restart Desktop" : "installs when Desktop next starts"}`,
      }),
    }),
  );
});
