// Collie's own records, in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database):
// one service per kind, over whichever connection to `host.db` a layer is given.

import { Context, Layer } from "effect";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { launchesLayer, type Launches } from "./launches";
import { deliveriesLayer, type Deliveries } from "./steering";
import { storeLayer } from "./store";
import { proposalsLayer, type Proposals } from "./proposals";
import { registeredLayer, type Registered } from "./registry";
import { tasksLayer, type Tasks } from "./task";
import { artefactsLayer, type Artefacts } from "./artefacts";
import { runRecordsLayer, type RunRecords } from "./run-records";

export type Records =
  | Deliveries
  | Launches
  | Proposals
  | Registered
  | Tasks
  | Artefacts
  | RunRecords;

/**
 * Over the host's own connection, which the Store has migrated. Fresh, or a layer provided
 * inside another would reuse the outer one's connection.
 */
export const recordsLayer = Layer.fresh(
  Layer.mergeAll(
    deliveriesLayer,
    launchesLayer,
    proposalsLayer,
    registeredLayer,
    tasksLayer,
    artefactsLayer,
    runRecordsLayer,
  ),
);

/**
 * A connection to `stateDir`'s `host.db` that reads it through a memory map rather than
 * copying each page it reads into SQLite's own small page cache.
 */
export const hostDatabase = (stateDir: string, options?: { readonly readonly?: boolean }) =>
  SqliteClient.layer({ filename: `${stateDir}/host.db`, ...options }).pipe(
    Layer.tap((context) =>
      Context.get(context, SqlClient.SqlClient).unsafe(`PRAGMA mmap_size = ${2 ** 30}`),
    ),
  );

/**
 * `stateDir`'s own `host.db`, migrated and its record files imported as a host's first start
 * does, for a process no host shares `stateDir` with: a probe's scratch directory, a test's.
 */
export const recordsAt = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provideMerge(storeLayer(stateDir)),
    Layer.provideMerge(Layer.orDie(hostDatabase(stateDir))),
    Layer.provideMerge(Reactivity.layer),
  );

/** The door's: the same records over a read-only connection of its own. */
export const recordsReadLayer = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provide(Layer.orDie(hostDatabase(stateDir, { readonly: true }))),
    Layer.provide(Reactivity.layer),
  );
