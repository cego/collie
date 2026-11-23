import { Context, Layer } from "effect";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { launchesLayer } from "./launches";
import type { Launches } from "./launches";
import { deliveriesLayer } from "./steering";
import type { Deliveries } from "./steering";
import { storeLayer } from "./store";
import { proposalsLayer } from "./proposals";
import type { Proposals } from "./proposals";
import { registeredLayer } from "./registry";
import type { Registered } from "./registry";
import { tasksLayer } from "./task";
import type { Tasks } from "./task";
import { artefactsLayer } from "./artefacts";
import type { Artefacts } from "./artefacts";
import { runRecordsLayer } from "./run-records";
import type { RunRecords } from "./run-records";

export type Records =
  | Deliveries
  | Launches
  | Proposals
  | Registered
  | Tasks
  | Artefacts
  | RunRecords;

// WARNING: fresh, or a nested provide would reuse the outer connection.
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

export const hostDatabase = (stateDir: string, options?: { readonly readonly?: boolean }) =>
  SqliteClient.layer({ filename: `${stateDir}/host.db`, ...options }).pipe(
    Layer.tap((context) =>
      Context.get(context, SqlClient.SqlClient).unsafe(`PRAGMA mmap_size = ${2 ** 30}`),
    ),
  );

export const recordsAt = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provideMerge(storeLayer(stateDir)),
    Layer.provideMerge(Layer.orDie(hostDatabase(stateDir))),
    Layer.provideMerge(Reactivity.layer),
  );

export const recordsReadLayer = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provide(Layer.orDie(hostDatabase(stateDir, { readonly: true }))),
    Layer.provide(Reactivity.layer),
  );
