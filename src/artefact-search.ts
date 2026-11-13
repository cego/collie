// The Flock's search over its Machines' catalogues: each host searches its own, and this
// merges their pages by installation, so two routes to one Machine are searched once and a
// Machine that could not be searched is named rather than read as having nothing.

import { Cause, Data, Effect, Option, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Artefact, ArtefactKey, type ArtefactMatches, type ArtefactSearch } from "./artefact-model";
import { HostRefused } from "./board-model";

export class Away extends Data.TaggedError("Away")<{
  readonly state: "unreachable" | "unsupported";
  readonly reason: string;
}> {}

export class AmbiguousRun extends Data.TaggedError("AmbiguousRun")<{
  readonly run: string;
  readonly candidates: ReadonlyArray<{ readonly installation: string; readonly machine: string }>;
}> {
  get message() {
    return `Run ${this.run} is on ${Arr.join(
      Arr.map(this.candidates, (one) => `${one.machine} (${one.installation})`),
      " and ",
    )}; name it as <installation>:${this.run} or <machine>:${this.run}`;
  }
}

/** A Machine's host as the search reaches it. */
export interface SearchDoor {
  readonly installation: string;
  readonly search: (asked: ArtefactSearch) => Effect.Effect<ArtefactMatches, Away>;
  readonly has: (run: string) => Effect.Effect<boolean, Away>;
}

/** A route to a Machine, by the label it is known by here. */
export interface SearchSource<R> {
  readonly machine: string;
  readonly reach: Effect.Effect<SearchDoor, Away, R>;
}

export const FlockSearch = Schema.Struct({
  query: Schema.optional(Schema.String),
  /** A Run id, alone or as `<installation>:<run>` or `<machine>:<run>`. */
  run: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  unseen: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});
export type FlockSearch = typeof FlockSearch.Type;

export const MachineSearched = Schema.Struct({
  installation: Schema.NullOr(Schema.String),
  machine: Schema.String,
  state: Schema.Literals(["searched", "unreachable", "unsupported"]),
  reason: Schema.NullOr(Schema.String),
  runs: Schema.Int,
  indexed: Schema.Int,
}).annotate({ identifier: "MachineSearched" });
export type MachineSearched = typeof MachineSearched.Type;

/** An artefact as the Flock found it: on which installation, under the label it has here. */
export const FoundArtefact = Schema.Struct({
  installation: Schema.String,
  machine: Schema.String,
  item: Artefact,
}).annotate({ identifier: "FoundArtefact" });

export const FlockArtefacts = Schema.Struct({
  items: Schema.Array(FoundArtefact),
  /** The next page's cursor; null once every searched Machine is read to its end. */
  next: Schema.NullOr(Schema.String),
  machines: Schema.Array(MachineSearched),
  /** Every Machine was searched and has reached all of its retained Runs. */
  complete: Schema.Boolean,
});
export type FlockArtefacts = typeof FlockArtefacts.Type;

export const artefactOwner = (page: FlockArtefacts, named: string) => {
  const owner = Arr.findFirst(page.machines, (one) => one.state === "searched" && one.runs > 0);
  if (Option.isNone(owner))
    return Effect.fail(
      new HostRefused({
        reason: `Run ${named} was not found; ${Arr.join(
          Arr.flatMap(page.machines, (one) =>
            one.reason === null ? [] : [`${one.machine}: ${one.reason}`],
          ),
          "; ",
        )}`,
      }),
    );
  if (
    !Str.includes(":")(named) &&
    !page.complete &&
    Arr.some(page.machines, (one) => one.state !== "searched")
  )
    return Effect.fail(
      new HostRefused({
        reason: `Other Machines could not be checked; name the Run as ${owner.value.installation}:${named}`,
      }),
    );
  return Effect.succeed({
    machine: owner.value.machine,
    run: Str.slice(Option.getOrElse(Str.indexOf(":")(named), () => -1) + 1)(named),
  });
};

/** Each installation's place: where its last page ended, or that it has no more. */
const Cursor = Schema.Record(Schema.String, Schema.Union([ArtefactKey, Schema.Literal("done")]));
const CursorText = Schema.fromJsonString(Cursor);
const readCursor = (cursor: string | undefined) =>
  Schema.decodeEffect(CursorText)(
    cursor === undefined ? "{}" : Buffer.from(cursor, "base64url").toString(),
  ).pipe(
    Effect.mapError(() => new HostRefused({ reason: "That search cursor is not one Collie gave" })),
  );

/** Pages compare newest detected first, then by installation, Run and id. */
const before = (
  a: { readonly installation: string; readonly item: Artefact },
  b: { readonly installation: string; readonly item: Artefact },
) =>
  Str.localeCompare(a.item.detectedAt)(b.item.detectedAt) ||
  Str.localeCompare(b.installation)(a.installation) ||
  Str.localeCompare(b.item.run)(a.item.run) ||
  Str.localeCompare(b.item.id)(a.item.id);

const bounded = <A, R>(effect: Effect.Effect<A, Away, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(new Away({ state: "unreachable", reason: "its host did not answer in time" })),
    }),
  );

export const searchFlock = Effect.fn("ArtefactSearch.flock")(function* <R>(
  sources: ReadonlyArray<SearchSource<R>>,
  asked: FlockSearch,
) {
  const cursor = { ...(yield* readCursor(asked.cursor)) };
  const limit = Math.min(Math.max(asked.limit ?? 50, 1), 200);
  const reached = yield* Effect.forEach(
    sources,
    (source) =>
      source.reach.pipe(
        bounded,
        Effect.result,
        Effect.map((result) => ({ machine: source.machine, result })),
      ),
    { concurrency: 4 },
  );
  const machines: Array<MachineSearched> = [];
  const doors: Array<{ readonly machine: string; readonly door: SearchDoor }> = [];
  for (const { machine, result } of reached) {
    if (result._tag === "Failure") {
      machines.push({
        installation: null,
        machine,
        state: result.failure.state,
        reason: result.failure.reason,
        runs: 0,
        indexed: 0,
      });
      continue;
    }
    if (Arr.some(doors, (one) => one.door.installation === result.success.installation)) continue;
    doors.push({ machine, door: result.success });
  }
  const separator =
    asked.run === undefined ? -1 : Option.getOrElse(Str.indexOf(":")(asked.run), () => -1);
  const qualifier = separator < 0 ? undefined : Str.slice(0, separator)(asked.run!);
  const run = separator < 0 ? asked.run : Str.slice(separator + 1)(asked.run!);
  let searched = doors;
  if (qualifier !== undefined)
    searched = Arr.filter(
      doors,
      (one) => one.door.installation === qualifier || one.machine === qualifier,
    );
  else if (run !== undefined) {
    const located = yield* Effect.forEach(
      doors,
      (one) =>
        bounded(one.door.has(run)).pipe(
          Effect.result,
          Effect.map((result) => ({ ...one, result })),
        ),
      { concurrency: 4 },
    );
    for (const one of located)
      if (one.result._tag === "Failure")
        machines.push({
          installation: one.door.installation,
          machine: one.machine,
          state: one.result.failure.state,
          reason: one.result.failure.reason,
          runs: 0,
          indexed: 0,
        });
    const holding = Arr.filter(
      located,
      (one) => one.result._tag === "Success" && one.result.success,
    );
    if (holding.length > 1)
      return yield* new AmbiguousRun({
        run,
        candidates: Arr.map(holding, (one) => ({
          installation: one.door.installation,
          machine: one.machine,
        })),
      });
    searched = holding;
  }
  const query = Str.trim(asked.query ?? "");
  const pages = yield* Effect.forEach(
    searched,
    (one) => {
      const after = cursor[one.door.installation];
      return one.door
        .search({
          query: query === "" ? undefined : query,
          run,
          kind: asked.kind,
          role: asked.role,
          unseen: asked.unseen === true ? true : undefined,
          after: after === "done" ? undefined : after,
          limit,
        })
        .pipe(
          bounded,
          Effect.result,
          Effect.map((result) => ({ ...one, result })),
        );
    },
    { concurrency: 4 },
  );
  const merged: Array<{ installation: string; machine: string; item: Artefact }> = [];
  for (const page of pages) {
    const { installation } = page.door;
    if (page.result._tag === "Failure") {
      machines.push({
        installation,
        machine: page.machine,
        state: page.result.failure.state,
        reason: page.result.failure.reason,
        runs: 0,
        indexed: 0,
      });
      continue;
    }
    machines.push({
      installation,
      machine: page.machine,
      state: "searched",
      reason: null,
      ...page.result.success.coverage,
    });
    if (cursor[installation] !== "done")
      merged.push(
        ...Arr.map(page.result.success.items, (item) => ({
          installation,
          machine: page.machine,
          item,
        })),
      );
  }
  const taken = Arr.take(merged.sort(before), limit);
  for (const page of pages) {
    if (page.result._tag === "Failure" || cursor[page.door.installation] === "done") continue;
    const { installation } = page.door;
    const mine = Arr.filter(taken, (one) => one.installation === installation);
    const last = Option.getOrUndefined(Arr.last(mine));
    if (!page.result.success.more && mine.length === page.result.success.items.length)
      cursor[installation] = "done";
    else if (last !== undefined)
      cursor[installation] = {
        detectedAt: last.item.detectedAt,
        run: last.item.run,
        id: last.item.id,
      };
  }
  const order = new Map(Arr.map(sources, (source, index) => [source.machine, index]));
  machines.sort((a, b) => (order.get(a.machine) ?? 0) - (order.get(b.machine) ?? 0));
  const finished = Arr.every(searched, (one) => cursor[one.door.installation] === "done");
  return {
    items: taken,
    next: finished
      ? null
      : Buffer.from(yield* Schema.encodeEffect(CursorText)(cursor).pipe(Effect.orDie)).toString(
          "base64url",
        ),
    machines,
    complete: Arr.every(machines, (one) => one.state === "searched" && one.indexed === one.runs),
  } satisfies FlockArtefacts;
});

const UPGRADE = "Upgrade this Machine's Collie host to search Artefacts";

/** Why a Machine's host could not be searched: too old for the call, or not answering. */
export const awayFrom = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const said = Cause.pretty(cause);
      return Effect.fail(
        Str.includes("Unknown request tag")(said)
          ? new Away({ state: "unsupported", reason: UPGRADE })
          : new Away({ state: "unreachable", reason: Str.split(Str.trim(said), "\n")[0]! }),
      );
    }),
  );

/** The calls the search makes of one host, as any front door's client offers them. */
export const searchDoorOf = <E1, E2, E3>(client: {
  readonly identity: () => Effect.Effect<{ readonly installation?: string }, E1>;
  readonly artefactSearch: (asked: ArtefactSearch) => Effect.Effect<ArtefactMatches, E2>;
  readonly run: (asked: { readonly runId: string }) => Effect.Effect<unknown, E3>;
}): Effect.Effect<SearchDoor, Away> =>
  awayFrom(client.identity()).pipe(
    Effect.flatMap(({ installation }) =>
      installation === undefined
        ? Effect.fail(new Away({ state: "unsupported", reason: UPGRADE }))
        : Effect.succeed({
            installation,
            search: (asked: ArtefactSearch) => awayFrom(client.artefactSearch(asked)),
            has: (run: string) =>
              awayFrom(client.run({ runId: run })).pipe(Effect.map((view) => view !== null)),
          }),
    ),
  );
