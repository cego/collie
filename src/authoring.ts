// What a module says about itself, and the file an author starts from.
//
// One reading answers every front door — the listing, the detail, the definitions tool
// and the refusal that asks for an input nobody gave — so what an operator is told an id
// takes is what a launch holds them to. Checking is that reading plus the compiler, and
// creating or forking writes the file the reading would find.
//
// Nothing here runs a workflow body, takes an agent or opens a worktree. Constructing a
// module is the author's own top level and their `make`, which is how a schema on either
// end can be read at all; a Run is started somewhere else entirely.

import { Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  Declared,
  ENTRY_SUFFIX,
  LAYERS,
  declaredBy,
  stem,
  type EntryLayer,
  type Found,
} from "./discovery";
import { reason } from "./naming";
import { loadEntry, provisionToolchain, typecheckEntry } from "./engine";
import {
  RESERVED_INPUTS,
  describeMetadata,
  jsonSchemaFor,
  type HostWorkflow,
  type WorkflowEntry,
} from "./sdk";

/** A schema as a front door draws it, and each place the drawing says less than it does. */
export const Drawn = Schema.Struct({
  schema: Schema.NullOr(Schema.Json),
  limits: Schema.Array(Schema.String),
});

/** Where a module is, as both a reading and a writing name it. */
export interface Where {
  readonly layer: EntryLayer;
  readonly path: string;
}

/** One module, in the shape every front door reads it in. */
export const Described = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  layer: Schema.Literals(LAYERS),
  path: Schema.String,
  inputs: Schema.Array(Declared),
  /** What the host settles beside the payload; a module may not declare one of these. */
  options: Schema.Array(Schema.Struct({ name: Schema.String, meaning: Schema.String })),
  success: Drawn,
  error: Drawn,
  /** Hints, outcome and offers as data: the author's closures stay in the module. */
  metadata: Schema.Json,
  /** Why the module would not construct, or null. Constructing it starts no Run. */
  broken: Schema.NullOr(Schema.String),
});
export type Described = typeof Described.Type;

const NOT_DRAWN = { schema: null, limits: [] } as const;

const HOST_OPTIONS = Object.entries(RESERVED_INPUTS).map(([name, meaning]) => ({
  name,
  meaning,
}));

/**
 * What a module declares, on both ends. The workflow is constructed to read its result
 * and failure schemas, which is what `make` is for — a Layer is described by it, never
 * built, and nothing of the author's body runs.
 */
export function describeModule(entry: WorkflowEntry, where: Where): Described {
  const built = construct(entry);
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    layer: where.layer,
    path: where.path,
    inputs: declaredBy(entry),
    options: HOST_OPTIONS,
    success: built.workflow === null ? NOT_DRAWN : drawn(built.workflow.successSchema),
    error: built.workflow === null ? NOT_DRAWN : drawn(built.workflow.errorSchema),
    metadata: describeMetadata(entry.metadata),
    broken: built.broken,
  };
}

/**
 * The module an id was found at, read again for both its ends. It loaded once to be
 * found, so it loads again from the same revision; a file that has gone in between is
 * described as far as the listing knew it, and says why it can no longer be read.
 */
export const readModule: (found: Found) => Effect.Effect<Described, never, FileSystem.FileSystem> =
  Effect.fn("Authoring.readModule")(function* (found: Found) {
    const loaded = yield* loadEntry(found.path).pipe(Effect.result);
    return loaded._tag === "Success"
      ? describeModule(loaded.success, found)
      : {
          id: found.id,
          title: found.title,
          description: found.description,
          layer: found.layer,
          path: found.path,
          inputs: found.inputs,
          options: HOST_OPTIONS,
          success: NOT_DRAWN,
          error: NOT_DRAWN,
          metadata: {},
          broken: loaded.failure.message,
        };
  });

/** What `make` gave back, or the sentence it threw instead. One of the two is always null. */
type Constructed =
  | { readonly workflow: HostWorkflow; readonly broken: null }
  | { readonly workflow: null; readonly broken: string };

const construct = (entry: WorkflowEntry): Constructed => {
  try {
    // Typed for the author, not for us: an untyped module's `make` can return anything.
    const workflow: HostWorkflow | undefined = entry.make(entry.id).workflow;
    return workflow === undefined
      ? { workflow: null, broken: `make("${entry.id}") returned no workflow` }
      : { workflow, broken: null };
  } catch (cause) {
    return { workflow: null, broken: reason(cause) };
  }
};

const drawn = (schema: Schema.Constraint) => {
  const projected = jsonSchemaFor(schema);
  return { schema: projected.document, limits: projected.limits };
};

/** One module as `check` reports it: what stops it, what is merely undrawn, and what was read. */
export type Checked = {
  readonly id: string;
  readonly layer: EntryLayer;
  readonly path: string;
  /** What stops it running: it would not load, would not construct, or would not compile. */
  readonly problems: ReadonlyArray<string>;
  /** Where a drawing constrains nothing. Not a problem: the schema itself still holds. */
  readonly limits: ReadonlyArray<string>;
  /** Why nothing was typechecked, where nothing was. Silence would read as a pass. */
  readonly toolchain: string | null;
};

/**
 * Everything wrong with one module, without starting anything. A file that will not load
 * is known by the id its name claims, because the id inside it is what failed to be read.
 */
export const checkModule: (
  where: Where,
) => Effect.Effect<
  Checked,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Authoring.checkModule")(function* (where: Where) {
  const dir = directoryOf(where.path);
  const loaded = yield* loadEntry(where.path).pipe(Effect.result);
  if (loaded._tag === "Failure") {
    return {
      id: stem(where.path),
      layer: where.layer,
      path: where.path,
      problems: [loaded.failure.message],
      limits: [],
      toolchain: null,
    };
  }
  const described = describeModule(loaded.success, where);
  const typed = yield* typecheckEntry({ dir, file: where.path }).pipe(Effect.result);
  const unavailable = typed._tag === "Failure" ? typed.failure.message : null;
  return {
    id: described.id,
    layer: where.layer,
    path: where.path,
    problems: [
      ...(described.broken === null ? [] : [described.broken]),
      ...(typed._tag === "Success" ? typed.success : []),
    ],
    limits: limitsOf(described),
    toolchain: unavailable,
  };
});

/** Each place a drawing of this module says less than the module does, named by where. */
const limitsOf = (described: Described): ReadonlyArray<string> => [
  ...described.inputs.flatMap((input) =>
    input.limits.map((limit) => `input "${input.name}": ${limit}`),
  ),
  ...described.success.limits.map((limit) => `success: ${limit}`),
  ...described.error.limits.map((limit) => `error: ${limit}`),
];

/** What writing a module came to: the file, and the sentence a human reads either way. */
export interface Written {
  readonly ok: boolean;
  readonly path: string;
  readonly message: string;
  /** Why an author cannot typecheck what was written yet, or null. The module still runs. */
  readonly toolchain: string | null;
}

/**
 * A module of one's own, and the setup to typecheck it beside it. The toolchain is
 * installed with the executable's embedded Bun, so neither Bun nor Node has to be on the
 * machine; a first use with no network says so and leaves a module that still runs.
 */
export const createEntry: (options: {
  readonly dir: string;
  readonly id: string;
}) => Effect.Effect<
  Written,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Authoring.createEntry")(function* (options: {
  readonly dir: string;
  readonly id: string;
}) {
  return yield* write(options.dir, options.id, entryText(options.id));
});

/** The parent a fork keeps, read where it was found. */
export interface Forking {
  readonly path: string;
  readonly entry: WorkflowEntry;
}

/** A fork as a file that re-exports its parent and hands `make` on; nothing is copied. */
export const forkEntry: (options: {
  readonly dir: string;
  readonly id: string;
  readonly from: Forking;
}) => Effect.Effect<
  Written,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Authoring.forkEntry")(function* (options: {
  readonly dir: string;
  readonly id: string;
  readonly from: Forking;
}) {
  const path = yield* Path.Path;
  return yield* write(
    options.dir,
    options.id,
    forkText(options.id, options.from.entry, importOf(path, options.dir, options.from.path)),
  );
});

/**
 * How the fork names its parent. Relative where the two sit near each other, absolute
 * where they do not: a fork in a project of a module in the installation is otherwise a
 * climb to the root and back down, which resolves but tells the reader nothing.
 */
const importOf = (path: Path.Path, dir: string, parent: string): string => {
  const relative = path.relative(dir, parent);
  const near = relative.startsWith(".") ? relative : `./${relative}`;
  return near.length <= parent.length ? near : parent;
};

const write = Effect.fn("Authoring.write")(function* (dir: string, id: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = `${dir}/${id}${ENTRY_SUFFIX}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  const taken = yield* fs.writeFileString(path, text, { flag: "wx" }).pipe(
    Effect.as(false),
    Effect.catch((cause: PlatformError.PlatformError) =>
      cause.reason._tag === "AlreadyExists" ? Effect.succeed(true) : Effect.fail(cause),
    ),
  );
  if (taken) {
    return {
      ok: false,
      path,
      message: `${path} already exists — edit it instead`,
      toolchain: null,
    };
  }
  // After the entry, and never fatally: what is installed here is for typechecking, and
  // the module Collie runs resolves `collie` from the executable either way.
  const provisioned = yield* provisionToolchain(dir).pipe(Effect.result);
  return {
    ok: true,
    path,
    message: `wrote ${path}`,
    toolchain: provisioned._tag === "Failure" ? provisioned.failure.message : null,
  };
});

const directoryOf = (file: string) => file.slice(0, file.lastIndexOf("/"));

/** The smallest module that runs: typed input, one recorded step, a typed result. */
const entryText = (id: string) => `import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "${id}",
  title: "What ${id} is for",
  description: "One sentence an operator reads before starting it.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      yield* Activity.make({
        name: "note",
        success: Schema.String,
        execute: host.record(run.id, input.note).pipe(Effect.as("noted")),
      });
      return input.note;
    }),
});
`;

const forkText = (id: string, parent: WorkflowEntry, from: string) =>
  `// A fork of "${parent.id}": what this file does not name is still the original's.

import { defineWorkflow } from "collie";
import original from "${from}";

export default defineWorkflow({
  ...original,
  id: "${id}",
});
`;
