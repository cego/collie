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
