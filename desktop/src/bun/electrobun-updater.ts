// Electrobun's updater, as `updates.ts` asks it: the one place Desktop's own updates touch it.

import { Effect, FileSystem, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { PreparedRecord, preparedRecordOf, releaseOf } from "../../../src/desktop";
import type { UpdaterPort } from "./updates";

const promised = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => String(cause) });

const LocalInfo = Schema.Struct({
  channel: Schema.String,
  hash: Schema.String,
  baseUrl: Schema.String,
});
type LocalInfo = typeof LocalInfo.Type;
const Checked = Schema.Struct({
  error: Schema.String,
  updateAvailable: Schema.Boolean,
  version: Schema.String,
});
type Checked = typeof Checked.Type;
const Downloaded = Schema.Struct({ error: Schema.String });
type Downloaded = typeof Downloaded.Type;
const Status = Schema.Struct({ message: Schema.String });
type Status = typeof Status.Type;

/** The upstream operations used here; their JavaScript results are checked before use. */
export interface ElectrobunUpdaterApi {
  readonly getLocalInfo: () => Promise<LocalInfo>;
  readonly appDataFolder: () => Promise<string>;
  readonly checkForUpdate: () => Promise<Checked>;
  readonly downloadUpdate: () => Promise<void>;
  readonly updateInfo: () => Downloaded;
  readonly applyUpdate: () => Promise<void>;
  readonly getStatusHistory: () => ReadonlyArray<Status>;
}

export const electrobunUpdater = (updater: ElectrobunUpdaterApi) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* promised(() => updater.getLocalInfo()).pipe(
      Effect.flatMap(Schema.decodeEffect(LocalInfo)),
      Effect.mapError(String),
      Effect.orDie,
    );
    const folder = yield* promised(() => updater.appDataFolder()).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.String)),
      Effect.mapError(String),
      Effect.orDie,
    );
    const readPrepared = fs
      .readFileString(preparedRecordOf(folder))
      .pipe(Effect.flatMap(Schema.decodeEffect(PreparedRecord)), Effect.option);
    const port: UpdaterPort = {
      channel: Effect.succeed(info.channel),
      hash: Effect.succeed(info.hash),
      check: promised(() => updater.checkForUpdate()).pipe(
        Effect.flatMap(Schema.decodeEffect(Checked)),
        Effect.flatMap((found) =>
          found.error === ""
            ? Effect.succeed({ available: found.updateAvailable, version: found.version })
            : Effect.fail(found.error),
        ),
        Effect.mapError(String),
      ),
      download: promised(() => updater.downloadUpdate()).pipe(
        Effect.flatMap(() => Schema.decodeEffect(Downloaded)(updater.updateInfo())),
        Effect.flatMap(({ error }) => (error === "" ? Effect.void : Effect.fail(error))),
        Effect.mapError(String),
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
        if (Option.isSome(record))
          yield* fs.remove(record.value.retained_tar_path, { force: true });
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
      apply: promised(() => updater.applyUpdate()).pipe(
        Effect.flatMap(() => Schema.decodeEffect(Schema.Array(Status))(updater.getStatusHistory())),
        Effect.flatMap((history) =>
          Effect.fail(history.at(-1)?.message ?? "Electrobun did not install it"),
        ),
        Effect.mapError(String),
      ),
    };
    return port;
  });
