// Effect's own workflow engine, proven from the compiled binary.
//
// A workflow lives in a TypeScript file outside this checkout. This module is what lets
// the packaged executable load one, give it the binary's own Effect rather than a second
// copy, and run it on ClusterWorkflowEngine over real SQLite — so a host that dies leaves
// completed work completed and a pending decision pending. Nothing here interprets a
// workflow: the module is code, and Effect executes it.
//
// `docs/adr/0014-native-workflows-run-on-effects-own-engine.md` records why each of the
// pieces below is upstream's rather than Collie's.

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ConfigError } from "effect/Config";
import type { PlatformError } from "effect/PlatformError";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as WorkflowModules from "effect/unstable/workflow";
import * as EffectRoot from "effect";
import * as Sdk from "./sdk";
import {
  NativeHost,
  checkEntry,
  describeMetadata,
  type Registration,
  type WorkflowEntry,
} from "./sdk";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

/** A module that cannot be loaded, named by its own file. Schema-backed, so the local
 *  host can fail a client with the same value rather than a copy of it. */
export class NativeEntryError extends Schema.TaggedError<NativeEntryError>()("NativeEntryError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** Anything else a host will not do, said in one sentence a caller can show. */
export class HostRefused extends Schema.TaggedError<HostRefused>()("HostRefused", {
  reason: Schema.String,
}) {}

export class ToolchainError extends Data.TaggedError("ToolchainError")<{
  readonly code: "toolchain_unavailable";
  readonly message: string;
}> {}

/**
 * The SDK the binary serves to a module it loads. Without this an external file resolves
 * `effect` from its own directory — a second copy whose `Effect.succeed` builds values
 * this process's runtime does not recognise, and whose service keys are not the host's.
 * The directory does hold one, because that is where an author's declarations come from,
 * which is exactly why serving the bundled namespaces has to win.
 *
 * Each index module is expanded into its members, so `effect/Effect` and
 * `effect/unstable/workflow/Workflow` are the binary's objects as surely as `effect` is.
 */
const NAMESPACES = [
  ["effect", EffectRoot],
  ["effect/unstable/workflow", WorkflowModules],
] as const;

export const sdkModules = (): ReadonlyArray<readonly [string, object]> => {
  const served: Array<readonly [string, object]> = [["collie/native", Sdk]];
  for (const [prefix, namespace] of NAMESPACES) {
    served.push([prefix, namespace]);
    for (const [name, member] of Object.entries(namespace))
      served.push([`${prefix}/${name}`, member]);
  }
  return served;
};

/** Kept in step with package.json, which `native.test.ts` checks: the host and an
 *  author's declarations have to be the same Effect, or the types are about another one. */
export const TOOLCHAIN = {
  effect: "4.0.0-rc.117",
  typescript: "^7.0.2",
} as const;

/**
 * The declarations an author typechecks `collie/native` against, kept in step with
 * `src/sdk.ts` by `native-sdk.test.ts` — which typechecks a module using the whole
 * surface, so a declaration that has drifted fails a test rather than an author's build.
 */
export const SDK_DECLARATIONS = `declare module "collie/native" {
  import type { Context, Effect, Layer, Schema } from "effect";
  import type { DurableDeferred } from "effect/unstable/workflow/DurableDeferred";
  import type { Workflow } from "effect/unstable/workflow/Workflow";
  import type { WorkflowEngine } from "effect/unstable/workflow/WorkflowEngine";

  /** What the host lends a workflow. Hold and stop are read fresh on every replay. */
  export interface NativeHostApi {
    readonly dir: string;
    readonly held: (runId: string) => Effect.Effect<boolean>;
    readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
    readonly record: (runId: string, event: string) => Effect.Effect<void>;
  }
  export const NativeHost: Context.Service<NativeHostApi, NativeHostApi>;
  export type NativeHost = NativeHostApi;

  /** How every native workflow reports a failure. */
  export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
    "WorkflowError",
    { reason: Schema.String },
  ) {}

  /** A workflow under Collie's envelope: the host supplies runId, you supply input. */
  export function defineWorkflow<
    Input extends Schema.Struct.Fields,
    Success extends Schema.Top,
  >(options: {
    readonly name: string;
    readonly input: Input;
    readonly success: Success;
  }): Workflow<
    string,
    Schema.Struct<{ runId: typeof Schema.String; input: Schema.Struct<Input> }>,
    Success,
    typeof WorkflowError
  >;

  /** A decision a run waits on, answered with the text an operator types. */
  export function decision(name: string): DurableDeferred<typeof Schema.String>;
  export type NativeDecision = DurableDeferred<typeof Schema.String>;

  export interface Registration {
    readonly workflow: Workflow<string, any, any, typeof WorkflowError>;
    readonly layer: Layer.Layer<never, never, WorkflowEngine | NativeHost>;
    readonly decisions: Readonly<Record<string, NativeDecision>>;
  }

  export type Outcome =
    | "unspecified" | "feature" | "bug" | "refactor" | "investigation"
    | "docs" | "migration" | "review" | "plan";

  export type OutcomeContract =
    | { readonly fixed: Outcome; readonly selectable?: undefined }
    | { readonly fixed?: undefined; readonly selectable: ReadonlyArray<Outcome> };

  export interface FollowUp {
    readonly id: string;
    readonly title: string;
    readonly workflow: string;
    readonly when: "succeeded" | "failed" | "always";
  }

  /** What an action decides eligibility from: facts, never a workflow's name. */
  export interface ActionFacts {
    readonly outcome: Outcome;
    readonly succeeded: boolean;
    readonly branch: string | null;
    readonly mrUrl: string | null;
    readonly planIssues: number;
    readonly disposed: boolean;
  }

  export interface ActionProvider {
    readonly id: string;
    readonly title: string;
    readonly workflow: string;
    readonly arguments: Schema.Struct.Fields;
    readonly eligible: (facts: ActionFacts) => boolean;
  }

  /** Data a card and a launch read; never anything a workflow body consults. */
  export interface WorkflowMetadata {
    readonly hints?: Readonly<Record<string, string>>;
    readonly outcome?: OutcomeContract;
    readonly followUps?: ReadonlyArray<FollowUp>;
    readonly actions?: ReadonlyArray<ActionProvider>;
  }

  /** Names the host supplies at launch; an input of one of these is refused. */
  export const RESERVED_INPUTS: Readonly<Record<string, string>>;
  export const EXCLUSIVE_STRATEGIES: ReadonlyArray<string>;

  /** The shapes the shipped steps write, shared so a step declares one contract. */
  export const FindingSchema: Schema.Top;
  export const FixedSchema: Schema.Top;
  export const CheckSchema: Schema.Top;
  export const ReviewOutputSchema: Schema.Top;
  export const SynthesisSchema: Schema.Top;
  export const FixOutputSchema: Schema.Top;
  export const MrOutputSchema: Schema.Top;
  export const PlanOutputSchema: Schema.Top;

  /** The JSON Schema for a prompt, and what the drawing does not say. */
  export interface Projection {
    readonly document: unknown;
    readonly limits: ReadonlyArray<string>;
  }
  export function jsonSchemaFor(schema: Schema.Top): Projection;
}

declare module "*.md" {
  const text: string;
  export default text;
}
`;

let sdkInstalled = false;

/**
 * Registers the SDK with Bun's module resolver, once per process. A virtual module per
 * specifier, so `import "effect"` from anywhere in the author's imports lands here.
 */
export function installSdk(): void {
  if (sdkInstalled) return;
  sdkInstalled = true;
  Bun.plugin({
    name: "collie-native-sdk",
    setup(build) {
      for (const [specifier, namespace] of sdkModules()) {
        // Spread rather than passed on: Bun's object loader takes a plain object, and
        // the values in it stay the very functions and keys the binary is running on.
        build.module(specifier, () => ({ exports: { ...namespace }, loader: "object" }));
      }
    },
  });
}

const EntryContract = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.optionalKey(Schema.Unknown),
});

/**
 * Imports a workflow entry file and holds it to the published contract. A module that
 * does not compile, does not exist, does not export the contract or contradicts itself
 * fails naming its own file — so one bad entry says which one it is and leaves every
 * other entry loadable.
 *
 * Importing runs the module's top level, which is the author's code — and deliberately
 * so, since `make` is a function it exports. It does not run a workflow body, acquire an
 * agent or open a worktree; nothing here is a sandbox. The metadata is checked here, at
 * load, which is why a contradiction never reaches a Run.
 */
export const loadEntry: (file: string) => Effect.Effect<WorkflowEntry, NativeEntryError> =
  Effect.fn("Native.loadEntry")(function* (file: string) {
    installSdk();
    const loaded = yield* Effect.tryPromise({
      try: () => import(file),
      catch: (cause) => new NativeEntryError({ file, message: String(cause) }),
    });
    const described = yield* Schema.decodeUnknownEffect(EntryContract)(loaded).pipe(
      Effect.mapError(
        () =>
          new NativeEntryError({
            file,
            message: "a workflow entry exports id, title, description and input",
          }),
      ),
    );
    if (!Predicate.isFunction(loaded.make)) {
      return yield* new NativeEntryError({
        file,
        message: "a workflow entry exports make(registrationName)",
      });
    }
    // SAFETY: the contract above decoded and `make` is a function. What the author's
    // schemas and metadata hold is checked next, and what `make` returns is checked when
    // the host builds its Layer.
    const entry = { ...described, make: loaded.make } as WorkflowEntry;
    const problems = checkEntry(entry);
    if (problems.length > 0) {
      return yield* new NativeEntryError({ file, message: problems.join("; ") });
    }
    return entry;
  });

/**
 * A generation's own copy of the directory the entry lives in, so an edited helper reaches
 * new work without restarting the host. Bun's module registry has no invalidation:
 * re-importing the entry under a new query re-reads the entry, but its `./helper.ts`
 * resolves to the path already cached. A copy gives every file a path nothing has
 * imported yet. It is a cache — a host wipes it on start and stages from the module as it
 * is now, so this is never the code a past run is recovered onto.
 */
export const stageGeneration: (options: {
  readonly dir: string;
  readonly name: string;
  readonly entry: string;
}) => Effect.Effect<string, NativeEntryError, FileSystem.FileSystem> = Effect.fn(
  "Native.stageGeneration",
)(function* (options: { readonly dir: string; readonly name: string; readonly entry: string }) {
  const fs = yield* FileSystem.FileSystem;
  const slash = options.entry.lastIndexOf("/");
  const from = options.entry.slice(0, slash);
  const staged = `${options.dir}/generations/${options.name}`;
  yield* fs
    .copy(from, staged, { overwrite: true })
    .pipe(
      Effect.mapError(
        (cause) => new NativeEntryError({ file: options.entry, message: String(cause) }),
      ),
    );
  return `${staged}${options.entry.slice(slash)}`;
});

/** Every generation a host staged, gone: a new host stages from the sources again. */
export const clearGenerations = (dir: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(`${dir}/generations`, { recursive: true })),
    Effect.ignore,
  );

/**
 * The host's own stack: Bun's SQLite under Effect's single-node cluster under its
 * workflow engine. Two settings are not the defaults, and both would otherwise turn
 * recoverable work terminal — the reason each is here is in ADR-0014.
 */
export function hostLayer(options: {
  readonly dir: string;
  readonly registrationTimeout?: Duration.Input;
}): Layer.Layer<WorkflowEngine.WorkflowEngine, ConfigError> {
  const sql = SqliteClient.layer({ filename: `${options.dir}/native.db` }).pipe(
    Layer.provide(Reactivity.layer),
  );
  const cluster = SingleRunner.layer({
    shardingConfig: {
      // A host told to stop must not take a running workflow down with it: the work
      // finishes its step, and what is left is picked up by the next host.
      preemptiveShutdown: false,
      // A workflow whose module is missing has no entity to receive its messages. The
      // default marks them failed after a minute, which turns "the file is not there
      // yet" into a terminal result; waiting is what lets a repair recover the work.
      entityRegistrationTimeout: options.registrationTimeout ?? Duration.infinity,
    },
  }).pipe(Layer.provide([sql, BunCrypto.layer]));
  return ClusterWorkflowEngine.layer.pipe(Layer.provide(cluster));
}

/** Files are the hold and stop flags because an operator sets them between runs. */
export const nativeHostLayer = (
  dir: string,
): Layer.Layer<NativeHost, never, FileSystem.FileSystem> =>
  Layer.effect(NativeHost)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const flag = (name: string, runId: string) =>
        fs.exists(`${dir}/${name}.${runId}`).pipe(Effect.orElseSucceed(() => false));
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
      return NativeHost.of({
        dir,
        held: (runId) => flag("hold", runId),
        stopRequested: (runId) => flag("stop", runId),
        record: (runId, event) =>
          fs
            .writeFileString(`${dir}/events.${runId}.log`, `${event}\n`, { flag: "a" })
            .pipe(Effect.orDie),
      });
    }),
  );

/**
 * What the fixture host takes and what it says back, one JSON line each way. It lives
 * here rather than in the command so a test drives the host through the same contract the
 * host answers on, instead of a copy of it that can drift.
 */
export const HostRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("ping") }),
  Schema.Struct({ op: Schema.Literal("load"), entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("registrations") }),
  // The author's own input, undecoded here: the workflow's schema is what settles it,
  // and it does so before a run exists rather than after one has started.
  Schema.Struct({
    op: Schema.Literal("start"),
    id: Schema.String,
    runId: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({ op: Schema.Literal("poll"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("answer"),
    id: Schema.String,
    runId: Schema.String,
    decision: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("hold"), runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("release"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("stop"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("resume"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("provision"), dir: Schema.String }),
  Schema.Struct({ op: Schema.Literal("check"), dir: Schema.String, entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("metadata"), id: Schema.String }),
]);

export const HostReply = Schema.Struct({
  ok: Schema.Boolean,
  op: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  registration: Schema.optionalKey(Schema.String),
  registrations: Schema.optionalKey(Schema.Array(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What a module declares about itself, as a card and a launch would read it. */
  metadata: Schema.optionalKey(Schema.Json),
});

/**
 * A host's routing, which is what lets a restart find work again. A workflow's native
 * registration name is the tag its executions are stored under, so a run recovers only if
 * the next host registers the module under the name that run started on. Loading the same
 * file again mints the next name rather than replacing the old one: new work goes to the
 * new generation, and what is already running keeps the one it has.
 *
 * The public workflow id, this registration name and a run id stay three different
 * things; only the first is what an operator types.
 */
const Routing = Schema.Struct({
  registrations: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, entry: Schema.String }),
  ),
  // A run's registration and the execution it was admitted as. The execution id is
  // recorded rather than recomputed: it is derived from the payload, and a later op has
  // the run id and nothing else.
  runs: Schema.Record(
    Schema.String,
    Schema.Struct({ registration: Schema.String, execution: Schema.String }),
  ),
});
export type Routing = typeof Routing.Type;

const routingFile = (dir: string) => `${dir}/routing.json`;
const decodeRouting = Schema.decodeUnknownEffect(Schema.fromJsonString(Routing));
const encodeRouting = Schema.encodeSync(Schema.fromJsonString(Routing));

export const readRouting: (dir: string) => Effect.Effect<Routing, never, FileSystem.FileSystem> =
  Effect.fn("Native.readRouting")(function* (dir: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(routingFile(dir)).pipe(Effect.orElseSucceed(() => ""));
    return yield* decodeRouting(raw).pipe(
      Effect.orElseSucceed(() => ({ registrations: [], runs: {} })),
    );
  });

export const writeRouting: (
  dir: string,
  routing: Routing,
) => Effect.Effect<void, never, FileSystem.FileSystem> = Effect.fn("Native.writeRouting")(
  function* (dir: string, routing: Routing) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(routingFile(dir), encodeRouting(routing)).pipe(Effect.orDie);
  },
);

/** The next generation of an entry: opaque, distinct, and never a name already used. */
export const nextRegistrationName = (routing: Routing, id: string): string =>
  `${id}@${routing.registrations.filter((entry) => entry.id === id).length + 1}`;

/** The exit a decision is answered with, encoded by the decision's own schema. */
export const answerDecision = (
  registration: Registration,
  options: { readonly name: string; readonly executionId: string; readonly value: string },
): Effect.Effect<void, NativeEntryError, WorkflowEngine.WorkflowEngine> => {
  const decision = registration.decisions[options.name];
  if (!decision) {
    return new NativeEntryError({
      file: registration.workflow._tag,
      message: `no decision called "${options.name}"`,
    });
  }
  const token = DurableDeferred.tokenFromExecutionId(decision, {
    workflow: registration.workflow,
    executionId: options.executionId,
  });
  return DurableDeferred.done(decision, { token, exit: Exit.succeed(options.value) });
};

/**
 * What a poll says about a run. A failure carries the module it happened in, because a
 * service the author never provided is invisible until the body asks for it, and the
 * sentence a human needs names the file to open.
 */
export const RunStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "suspended"]) }),
  Schema.Struct({ status: Schema.Literal("complete"), value: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String, entry: Schema.String }),
]);

export const pollStatus = (
  result: Option.Option<Workflow.Result<unknown, unknown>>,
  entry: string,
): typeof RunStatus.Type => {
  if (Option.isNone(result)) return { status: "pending" };
  const value = result.value;
  if (value._tag === "Suspended") return { status: "suspended" };
  if (Exit.isSuccess(value.exit)) return { status: "complete", value: String(value.exit.value) };
  // The reason, not the stack under it: a service a module never provided reads as
  // "Service not found: <its key>", which is the sentence somebody can act on.
  const [reason = ""] = Cause.pretty(value.exit.cause).split("\n");
  return { status: "failed", reason, entry };
};

/** What a host is holding, as a caller may see it: live names and unloadable ones. */
export const Registrations = Schema.Struct({
  live: Schema.Array(Schema.String),
  unavailable: Schema.Array(Schema.String),
});

/**
 * One loaded generation of a module: the id an operator types, the opaque name Effect
 * stores its executions under, and the live registration itself.
 */
export interface Generation {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly entry: string;
  readonly metadata: Schema.Json;
  readonly registration: Registration;
}

/** What the registry's own work takes, which is what a host holds already. */
export type HostServices = WorkflowEngine.WorkflowEngine | NativeHost | FileSystem.FileSystem;

/**
 * Which modules a host holds and what it does with them, in front of one state directory.
 * Both hosts run on this, so the rule that a run stays on the generation it started on is
 * decided once rather than twice.
 *
 * Registrations are built in the scope the registry is built in — the host's — so they
 * outlive whichever client asked for one and are finalized when the host goes.
 */
export interface RegistryApi {
  readonly load: (entry: string) => Effect.Effect<Generation, NativeEntryError, HostServices>;
  readonly registrations: Effect.Effect<typeof Registrations.Type>;
  readonly newest: (id: string) => Effect.Effect<Generation, HostRefused>;
  readonly start: (options: {
    readonly id: string;
    readonly runId: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
  }) => Effect.Effect<
    { readonly registration: string; readonly execution: string },
    HostRefused,
    HostServices
  >;
  readonly status: (
    runId: string,
  ) => Effect.Effect<typeof RunStatus.Type, HostRefused, HostServices>;
  readonly answer: (options: {
    readonly runId: string;
    readonly decision: string;
    readonly value: string;
  }) => Effect.Effect<void, HostRefused, HostServices>;
  /** The generation a run is on and the execution it was admitted as. */
  readonly routed: (
    runId: string,
  ) => Effect.Effect<{ readonly generation: Generation; readonly execution: string }, HostRefused>;
}

/** The registry a host holds, as a service its handlers ask for. */
export class Registry extends Context.Service<Registry, RegistryApi>()("collie/native/Registry") {}

export const registryLayer = (dir: string): Layer.Layer<Registry, never, HostServices> =>
  Layer.effect(Registry)(makeRegistry(dir));

const makeRegistry: (dir: string) => Effect.Effect<RegistryApi, never, HostServices | Scope.Scope> =
  Effect.fn("Native.makeRegistry")(function* (dir: string) {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const hostScope = yield* Effect.scope;
    /** Every generation this host is holding, by its native registration name. */
    const live = new Map<string, Generation>();
    /** Why a recorded generation is not holdable, so a caller hears the file, not a timeout. */
    const unavailable = new Map<string, string>();
    /** Which generation of an id new work goes to. */
    const newestOf = new Map<string, string>();
    let routing = yield* readRouting(dir);
    // Staged copies last only as long as this host: every generation below is staged from
    // the module as it is now, never restored.
    yield* clearGenerations(dir);

    const register = Effect.fn("Native.register")(function* (route: {
      readonly id: string;
      readonly name: string;
      readonly entry: string;
    }) {
      const entry = yield* stageGeneration({ dir, name: route.name, entry: route.entry }).pipe(
        Effect.flatMap(loadEntry),
      );
      const registration = entry.make(route.name);
      yield* Layer.buildWithScope(registration.layer, hostScope);
      const generation: Generation = {
        id: route.id,
        name: route.name,
        title: entry.title,
        entry: route.entry,
        metadata: describeMetadata(entry.metadata),
        registration,
      };
      live.set(route.name, generation);
      unavailable.delete(route.name);
      newestOf.set(route.id, route.name);
      return generation;
    });

    // What was registered before this host existed, rebuilt from the modules as they are
    // now. A file that has gone leaves its generation unavailable and every other one
    // registered, which is what keeps one broken module from stopping the rest.
    for (const route of routing.registrations) {
      yield* register(route).pipe(
        Effect.catchTag("NativeEntryError", (failure) =>
          Effect.sync(() => unavailable.set(route.name, `${failure.file}: ${failure.message}`)),
        ),
      );
    }

    const newest = Effect.fn("Native.newest")(function* (id: string) {
      const generation = live.get(newestOf.get(id) ?? "");
      if (!generation) {
        return yield* new HostRefused({ reason: `no workflow "${id}" is loaded here` });
      }
      return generation;
    });

    const routed = Effect.fn("Native.routed")(function* (runId: string) {
      const route = routing.runs[runId];
      if (!route) {
        return yield* new HostRefused({ reason: `no run "${runId}" was started here` });
      }
      const generation = live.get(route.registration);
      if (!generation) {
        return yield* new HostRefused({
          reason:
            unavailable.get(route.registration) ??
            `${route.registration} is not registered in this host`,
        });
      }
      return { generation, execution: route.execution };
    });

    return {
      load: Effect.fn("Native.Registry.load")(function* (file: string) {
        // Read once to learn the id this file claims, then register the next generation
        // of that id.
        const described = yield* loadEntry(file);
        const route = {
          id: described.id,
          name: nextRegistrationName(routing, described.id),
          entry: file,
        };
        const generation = yield* register(route);
        routing = { ...routing, registrations: [...routing.registrations, route] };
        yield* writeRouting(dir, routing);
        return generation;
      }),

      registrations: Effect.sync(() => ({
        live: [...live.keys()].sort(),
        unavailable: [...unavailable.entries()].map(([name, why]) => `${name}: ${why}`).sort(),
      })),

      newest,
      routed,

      start: Effect.fn("Native.Registry.start")(function* (options: {
        readonly id: string;
        readonly runId: string;
        readonly input: Readonly<Record<string, Schema.Json>>;
      }) {
        const generation = yield* newest(options.id);
        // Settled before anything exists to clean up: an input the workflow's own schema
        // rejects names its field here, and no run, routing row or execution is created.
        const payload = yield* Schema.decodeUnknownEffect(
          generation.registration.workflow.payloadSchema,
        )({ runId: options.runId, input: options.input }).pipe(
          Effect.mapError(
            (cause) => new HostRefused({ reason: `invalid_input: ${String(cause)}` }),
          ),
        );
        const execution = yield* generation.registration.workflow.executionId(payload);
        routing = {
          ...routing,
          runs: { ...routing.runs, [options.runId]: { registration: generation.name, execution } },
        };
        yield* writeRouting(dir, routing);
        yield* engine
          .execute(generation.registration.workflow, {
            executionId: execution,
            payload,
            discard: true,
          })
          .pipe(Effect.orDie);
        return { registration: generation.name, execution };
      }),

      status: Effect.fn("Native.Registry.status")(function* (runId: string) {
        const found = yield* routed(runId);
        const result = yield* engine.poll(found.generation.registration.workflow, found.execution);
        return pollStatus(result, found.generation.entry);
      }),

      answer: Effect.fn("Native.Registry.answer")(function* (options: {
        readonly runId: string;
        readonly decision: string;
        readonly value: string;
      }) {
        const found = yield* routed(options.runId);
        yield* answerDecision(found.generation.registration, {
          name: options.decision,
          executionId: found.execution,
          value: options.value,
        }).pipe(Effect.mapError((failure) => new HostRefused({ reason: failure.message })));
      }),
    } satisfies RegistryApi;
  });

const encodeCheckProject = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ extends: Schema.String, files: Schema.Array(Schema.String) }),
  ),
);

/**
 * The authoring setup, written as the files an author opens and edits rather than encoded
 * from a value: `paths` is what makes `collie/native` resolve to the declarations beside
 * it, and `effect` is pinned to the host's so the types are about the Effect that runs.
 */
const TOOLCHAIN_FILES = {
  "package.json": `{
  "name": "collie-workflows",
  "private": true,
  "type": "module",
  "dependencies": { "effect": "${TOOLCHAIN.effect}" },
  "devDependencies": { "typescript": "${TOOLCHAIN.typescript}" }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": [],
    "paths": { "collie/native": ["./collie-native.d.ts"] }
  }
}
`,
  "collie-native.d.ts": SDK_DECLARATIONS,
} as const;

/**
 * Writes the authoring setup beside a workflow directory and installs its toolchain with
 * the embedded Bun, so a machine with neither Bun nor Node on it can still typecheck a
 * module. An existing package.json or tsconfig.json is left alone: it is the author's,
 * and this is not the only thing they may be using that directory for.
 */
export const provisionToolchain: (
  dir: string,
) => Effect.Effect<
  void,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Native.provisionToolchain")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  for (const [name, content] of Object.entries(TOOLCHAIN_FILES)) {
    const path = `${dir}/${name}`;
    if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) continue;
    yield* fs.writeFileString(path, content).pipe(Effect.orDie);
  }
  yield* runBun(dir, ["install"]).pipe(
    Effect.mapError(
      (message) =>
        new ToolchainError({
          code: "toolchain_unavailable",
          message: `cannot install the workflow toolchain in ${dir}: ${message}`,
        }),
    ),
  );
});

/**
 * Typechecks one entry file against the provisioned toolchain and reports every
 * diagnostic with the source it is in. Errors in one file say nothing about another, so
 * a host checking several reports each on its own.
 */
export const typecheckEntry: (options: {
  readonly dir: string;
  readonly file: string;
}) => Effect.Effect<
  ReadonlyArray<string>,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Native.typecheckEntry")(function* (options: {
  readonly dir: string;
  readonly file: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const compiler = `${options.dir}/node_modules/typescript/lib/tsc.js`;
  if (!(yield* fs.exists(compiler).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new ToolchainError({
      code: "toolchain_unavailable",
      message: `no typechecker in ${options.dir}; provision it while you have a network`,
    });
  }
  // One file at a time, through a project that extends the author's settings. Naming a
  // file on tsc's command line makes it ignore the tsconfig beside it, which would check
  // the module against defaults nobody wrote and report nothing useful.
  const project = `${options.dir}/.collie-check.json`;
  yield* fs
    .writeFileString(
      project,
      encodeCheckProject({ extends: "./tsconfig.json", files: [options.file] }),
    )
    .pipe(Effect.orDie);
  const output = yield* runBun(options.dir, [
    "run",
    compiler,
    "--pretty",
    "false",
    "-p",
    project,
  ]).pipe(Effect.catch((printed) => Effect.succeed(printed)));
  const diagnostics = output.split("\n").filter((line) => /\(\d+,\d+\): error /.test(line));
  // tsc exits non-zero for the diagnostics it printed; anything else it refused to do is
  // the toolchain's problem, not the module's, and must not read as a clean module.
  if (diagnostics.length === 0 && output.includes("error TS")) {
    return yield* new ToolchainError({
      code: "toolchain_unavailable",
      message: `the typechecker refused to run: ${output.trim()}`,
    });
  }
  return diagnostics;
});

/**
 * The embedded Bun. A compiled executable with `BUN_BE_BUN` set is the `bun` CLI, so
 * installing a package and running a compiler need neither Bun nor Node on the machine;
 * running from source, `execPath` is already Bun and the variable changes nothing.
 */
const runBun = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, string, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        cwd,
        env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const output = yield* collect(child.stdout).pipe(
      Effect.zipWith(collect(child.stderr), (out, err) => out + err),
    );
    const code = yield* child.exitCode;
    return code === 0 ? output : yield* Effect.fail(output);
  }).pipe(
    Effect.scoped,
    Effect.catch((cause) => Effect.fail(String(cause))),
  );

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      (): string => "",
      (all, chunk) => all + chunk,
    ),
  );
