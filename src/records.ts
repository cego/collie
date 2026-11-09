// Collie's own records, in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database):
// one service per kind, over whichever connection to `host.db` a layer is given.

import { Layer } from "effect";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import { deliveriesLayer, type Deliveries } from "./steering";
import { storeLayer } from "./store";
import { registeredLayer, type Registered } from "./registry";
import { tasksLayer, type Tasks } from "./task";

export type Records = Deliveries | Registered | Tasks;

/**
 * Over the host's own connection, which the Store has migrated. Fresh, or a layer provided
 * inside another would reuse the outer one's connection.
 */
export const recordsLayer = Layer.fresh(
  Layer.mergeAll(deliveriesLayer, registeredLayer, tasksLayer),
);

/**
 * `stateDir`'s own `host.db`, migrated and its record files imported as a host's first start
 * does, for a process no host shares `stateDir` with: a probe's scratch directory, a test's.
 */
export const recordsAt = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provideMerge(storeLayer(stateDir)),
    Layer.provideMerge(Layer.orDie(SqliteClient.layer({ filename: `${stateDir}/host.db` }))),
    Layer.provideMerge(Reactivity.layer),
  );

/** The door's: the same records over a read-only connection of its own. */
export const recordsReadLayer = (stateDir: string) =>
  recordsLayer.pipe(
    Layer.provide(
      Layer.orDie(SqliteClient.layer({ filename: `${stateDir}/host.db`, readonly: true })),
    ),
    Layer.provide(Reactivity.layer),
  );
