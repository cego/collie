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
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

/**
 * What the host lends a workflow module. Hold and stop are files because an operator sets
 * them while the workflow is not running, and plain Effects because a workflow must read
 * the current one on every replay — an Activity would hand back the first attempt's.
 */
export interface NativeHostApi {
  /** Where this host keeps its state, and the only directory a module may write in. */
  readonly dir: string;
  readonly held: (runId: string) => Effect.Effect<boolean>;
  readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
  /** Appends one line to the run's effect log: what actually happened, once per real run. */
  readonly record: (runId: string, event: string) => Effect.Effect<void>;
}

export class NativeHost extends Context.Service<NativeHost, NativeHostApi>()("collie/NativeHost") {}

/**
 * A decision a run waits on. Every one this proof carries is answered with text, which
 * is what an operator types; typed decision payloads are a later slice's.
 */
export type NativeDecision = DurableDeferred.DurableDeferred<typeof Schema.String>;

/**
 * A workflow as the host sees one: any payload and any result, but nothing the host has
 * to supply to encode them, and no error of its own — `Workflow.make`'s own default. A
 * schema needing a service to encode reaches the host through the module's Layer, and a
 * workflow declaring a typed error is a later slice's, not this proof's.
 */
type HostCodec = Schema.Codec<unknown, unknown, never, never>;
interface HostPayload extends Schema.Struct<Schema.Struct.Fields> {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
}
export type HostWorkflow = Workflow.Workflow<string, HostPayload, HostCodec, typeof Schema.Never>;

/** A workflow module's entry file, as `make` hands its registration back. */
export interface NativeRegistration {
  readonly workflow: HostWorkflow;
  readonly layer: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | NativeHost>;
  readonly decisions: Readonly<Record<string, NativeDecision>>;
}

export interface NativeEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly make: (registrationName: string) => NativeRegistration;
}

export class NativeEntryError extends Data.TaggedError("NativeEntryError")<{
  readonly file: string;
  readonly message: string;
}> {}

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
  const served: Array<readonly [string, object]> = [["collie/native", { NativeHost }]];
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

/** The declarations an author typechecks `collie/native` against. */
export const SDK_DECLARATIONS = `declare module "collie/native" {
  import type { Context, Effect } from "effect";
  export interface NativeHostApi {
    readonly dir: string;
    readonly held: (runId: string) => Effect.Effect<boolean>;
    readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
    readonly record: (runId: string, event: string) => Effect.Effect<void>;
  }
  export const NativeHost: Context.Service<NativeHostApi, NativeHostApi>;
  export type NativeHost = NativeHostApi;
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
});

/**
 * Imports a workflow entry file. A module that does not compile, does not exist or does
 * not export the contract fails naming its own file, so one broken entry says which one
 * it is and leaves every other entry loadable.
 *
 * Importing runs the module's top level, which is the author's code — and deliberately
 * so, since `make` is a function it exports. It does not run a workflow body, acquire an
 * agent or open a worktree; nothing here is a sandbox.
 */
export const loadEntry: (file: string) => Effect.Effect<NativeEntry, NativeEntryError> = Effect.fn(
  "Native.loadEntry",
)(function* (file: string) {
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
          message: "a workflow entry exports id, title and description",
        }),
    ),
  );
  if (!Predicate.isFunction(loaded.make)) {
    return yield* new NativeEntryError({
      file,
      message: "a workflow entry exports make(registrationName)",
    });
  }
  // SAFETY: the shape above decoded, and `make` is a function; what it returns is the
  // author's, and a registration that is not one fails when the host builds its Layer.
  return { ...described, make: loaded.make } as NativeEntry;
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
  Schema.Struct({
    op: Schema.Literal("start"),
    id: Schema.String,
    runId: Schema.String,
    note: Schema.String,
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
  runs: Schema.Record(Schema.String, Schema.String),
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
  registration: NativeRegistration,
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

/** What a poll says about a run, flattened to what an operator needs to see. */
export const pollStatus = (result: Option.Option<Workflow.Result<unknown, unknown>>) => {
  if (Option.isNone(result)) return { status: "pending" };
  const value = result.value;
  if (value._tag === "Suspended") return { status: "suspended" };
  return Exit.isSuccess(value.exit)
    ? { status: "complete", value: String(value.exit.value) }
    : { status: "failed", value: Cause.pretty(value.exit.cause) };
};

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
export const checkEntry: (options: {
  readonly dir: string;
  readonly file: string;
}) => Effect.Effect<
  ReadonlyArray<string>,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Native.checkEntry")(function* (options: {
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
