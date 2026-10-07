// Electrobun's updater, as `updates.ts` asks it: the one place Desktop's own updates touch it.

import { Effect, FileSystem, Option, Schema } from "effect";
import { Updater } from "electrobun/bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { releaseOf } from "../../../src/desktop";
import type { UpdaterPort } from "./updates";

/** What Electrobun records once it has downloaded and unpacked an update. */
// ponytail: Electrobun's own file, read as electrobun 2.0.2 writes it; recheck on an upgrade.
const PreparedRecord = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    hash: Schema.String,
    retained_tar_path: Schema.String,
    artifact_file: Schema.String,
  }),
);

const preparedRecordOf = (folder: string) =>
  `${folder}/self-extraction/.electrobun-prepared-update.json`;

const promised = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => String(cause) });

export const electrobunUpdater = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* promised(() => Updater.getLocalInfo()).pipe(Effect.orDie);
  const folder = yield* promised(() => Updater.appDataFolder()).pipe(Effect.orDie);
  const readPrepared = fs
    .readFileString(preparedRecordOf(folder))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PreparedRecord)), Effect.option);
  const port: UpdaterPort = {
    channel: Effect.succeed(info.channel),
    hash: Effect.succeed(info.hash),
    check: promised(() => Updater.checkForUpdate()).pipe(
      Effect.flatMap((found) =>
        found.error === ""
          ? Effect.succeed({ available: found.updateAvailable, version: found.version })
          : Effect.fail(found.error),
      ),
    ),
    download: promised(() => Updater.downloadUpdate()).pipe(
      Effect.flatMap(() => {
        const { error } = Updater.updateInfo();
        return error === "" ? Effect.void : Effect.fail(error);
      }),
    ),
    prepared: Effect.map(readPrepared, (record) =>
      Option.match(record, {
        onNone: () => null,
        onSome: ({ version, hash, retained_tar_path, artifact_file }) => ({
          version,
          hash,
          tar: retained_tar_path,
          artifact: artifact_file,
        }),
      }),
    ),
    discard: Effect.gen(function* () {
      const record = yield* readPrepared;
      if (Option.isSome(record)) yield* fs.remove(record.value.retained_tar_path, { force: true });
      yield* fs.remove(preparedRecordOf(folder), { force: true });
    }).pipe(Effect.ignore),
    signatureOf: (name, version) =>
      HttpClient.get(`${releaseOf(info.baseUrl, version)}/${encodeURIComponent(name)}`).pipe(
        Effect.flatMap((response) =>
          response.status === 200 ? response.text : Effect.succeed(null),
        ),
        Effect.orElseSucceed(() => null),
        Effect.provide(FetchHttpClient.layer),
      ),
    // On success Electrobun quits Desktop, so returning at all means it did not install.
    apply: promised(() => Updater.applyUpdate()).pipe(
      Effect.flatMap(() =>
        Effect.fail(Updater.getStatusHistory().at(-1)?.message ?? "Electrobun did not install it"),
      ),
    ),
  };
  return port;
});
