// WARNING: nothing here runs a workflow body, takes an agent or opens a worktree; constructing a module runs only its top level and make.
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import type { Schema } from "effect";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { ENTRY_SUFFIX, declaredBy, discover, searchPath, stem } from "./discovery";
import type { EntryLayer, Found } from "./discovery";
import { loadDefinitions, personaData } from "./definitions";
import type { Described, HostDefinitions } from "./definitions-model";
import { reason } from "./naming";
import { HOST_CONNECTION_USES } from "./connection-model";

export { Described, Drawn } from "./definitions-model";
import { loadEntry, provisionToolchain, refreshToolchain, typecheckEntries } from "./engine";
import { RESERVED_INPUTS, describeMetadata, jsonSchemaFor } from "./sdk";
import type { HostWorkflow, WorkflowEntry } from "./sdk";

export interface Where {
  readonly layer: EntryLayer;
  readonly path: string;
}

const NOT_DRAWN = { schema: null, limits: [] } as const;

const HOST_OPTIONS = Arr.map(Rec.toEntries(RESERVED_INPUTS), ([name, meaning]) => ({
  name,
  meaning,
}));

export function describeModule(entry: WorkflowEntry, where: Where) {
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

export const readDefinitions = Effect.fn("Authoring.readDefinitions")(function* (where: {
  readonly pluginRoot: string;
  readonly userDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { entries, problems } = yield* discover(
    Arr.filter(searchPath({ ...where, project: "" }), (root) => root.layer !== "project"),
  );
  const workflows = yield* Effect.forEach(entries, (found) =>
    Effect.gen(function* () {
      const dir = directoryOf(found.path);
      const own = (name: string) =>
        name === `${stem(found.path)}${ENTRY_SUFFIX}` ||
        (pipe_(name, Str.startsWith(`${stem(found.path)}.`)) && pipe_(name, Str.endsWith(".md")));
      const names = Arr.filter(yield* fs.readDirectory(dir), own).sort();
      const files = yield* Effect.forEach(names, (name) =>
        fs
          .readFileString(`${dir}/${name}`)
          .pipe(Effect.map((text) => ({ path: `${dir}/${name}`, text }))),
      );
      return { ...(yield* readModule(found)), files };
    }),
  );
  const { personas, errors } = yield* loadDefinitions([
    { name: "baseline", dir: where.pluginRoot },
    { name: "user", dir: where.userDir },
  ]);
  return {
    workflows,
    connectionUses: HOST_CONNECTION_USES,
    problems,
    personas: Arr.map(
      [...personas.values()].sort((a, b) => pipe_(a.name, Str.localeCompare(b.name))),
      personaData,
    ),
    errors,
  } satisfies HostDefinitions;
});

const construct = (entry: WorkflowEntry) => {
  try {
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

export type Checked = {
  readonly id: string;
  readonly layer: EntryLayer;
  readonly path: string;
  readonly problems: ReadonlyArray<string>;
  readonly limits: ReadonlyArray<string>;
  readonly toolchain: string | null;
};

export const checkModules: (
  wheres: ReadonlyArray<Where>,
) => Effect.Effect<
  ReadonlyArray<Checked>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Authoring.checkModules")(function* (wheres: ReadonlyArray<Where>) {
  const loaded = yield* Effect.forEach(
    wheres,
    (where) => Effect.map(Effect.result(loadEntry(where.path)), (result) => ({ where, result })),
    { concurrency: 4 },
  );
  const byDir = Arr.groupBy(
    Arr.filter(loaded, (one) => one.result._tag === "Success"),
    (one) => directoryOf(one.where.path),
  );
  const typed = yield* Effect.forEach(
    Rec.toEntries(byDir),
    ([dir, group]) =>
      refreshToolchain(dir).pipe(
        Effect.andThen(typecheckEntries({ dir, files: Arr.map(group, (one) => one.where.path) })),
        Effect.result,
        Effect.map((result) => [dir, result] as const),
      ),
    { concurrency: 4 },
  );
  const typedIn = new Map(typed);
  return Arr.map(loaded, ({ where, result }) => {
    if (result._tag === "Failure") {
      const failed: Checked = {
        id: stem(where.path),
        layer: where.layer,
        path: where.path,
        problems: [result.failure.message],
        limits: [],
        toolchain: null,
      };
      return failed;
    }
    const described = describeModule(result.success, where);
    const checked = typedIn.get(directoryOf(where.path))!;
    const done: Checked = {
      id: described.id,
      layer: where.layer,
      path: where.path,
      problems: [
        ...(described.broken === null ? [] : [described.broken]),
        ...(checked._tag === "Success" ? (checked.success.get(where.path) ?? []) : []),
      ],
      limits: limitsOf(described),
      toolchain: checked._tag === "Failure" ? checked.failure.message : null,
    };
    return done;
  });
});

export const checkModule = (where: Where) =>
  Effect.map(checkModules([where]), (checked) => checked[0]!);

const limitsOf = (described: Described) => [
  ...Arr.flatMap(described.inputs, (input) =>
    Arr.map(input.limits, (limit) => `input "${input.name}": ${limit}`),
  ),
  ...Arr.map(described.success.limits, (limit) => `success: ${limit}`),
  ...Arr.map(described.error.limits, (limit) => `error: ${limit}`),
];

export interface Written {
  readonly ok: boolean;
  readonly path: string;
  readonly message: string;
  readonly toolchain: string | null;
}

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

export interface Forking {
  readonly path: string;
  readonly entry: WorkflowEntry;
}

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

const importOf = (path: Path.Path, dir: string, parent: string) => {
  const relative = path.relative(dir, parent);
  const near = pipe_(relative, Str.startsWith(".")) ? relative : `./${relative}`;
  return near.length <= parent.length ? near : parent;
};

const write = Effect.fn("Authoring.write")(function* (dir: string, id: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = `${dir}/${id}${ENTRY_SUFFIX}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  const taken = yield* fs.writeFileString(path, text, { flag: "wx" }).pipe(
    Effect.as(false),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(true)),
  );
  if (taken) {
    return {
      ok: false,
      path,
      message: `${path} already exists — edit it instead`,
      toolchain: null,
    };
  }
  // WARNING: a failed provisioning must not fail the read; the toolchain only serves typechecking.
  const provisioned = yield* provisionToolchain(dir).pipe(Effect.result);
  return {
    ok: true,
    path,
    message: `wrote ${path}`,
    toolchain: provisioned._tag === "Failure" ? provisioned.failure.message : null,
  };
});

const directoryOf = (file: string) =>
  pipe_(
    file,
    Str.slice(
      0,
      Option.getOrElse(pipe_(file, Str.lastIndexOf("/")), () => -1),
    ),
  );

const entryText = (id: string) => `import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "${id}",
  title: "What ${id} is for",
  description: "One sentence an operator reads before starting it.",
  input: Schema.Struct({ note: Schema.String }),
  // The one Input a human's words fill when they start it.
  hints: { note: "goal" },
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
