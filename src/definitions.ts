import * as Cause from "effect/Cause";
// Persona definitions across the three Layers: baseline (this repo), the user's plugin
// config dir, and the project's .collie/. Later wins by name.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expressionsIn, malformedIn } from "./template";
import { parseDocument, YamlError, type YamlValue } from "./yaml";
import { Effect, FileSystem, Path, Result, type PlatformError } from "effect";
import * as Digest from "effect/crypto/Digest";
import { isString } from "./schema";
import type { PersonaView } from "./definitions-model";

export type LayerName = PersonaView["layer"];

export interface Layer {
  name: LayerName;
  dir: string;
}

export const INPUT_STRATEGIES = [
  "goal",
  "plan-dir",
  "work-source",
  "diff-target",
  "flag",
  "optional",
  "repository",
  // What `repository` was called; still read, as `repository` (ADR-0050 D9).
  "gitlab-repository",
] as const;

/**
 * Which inference settles an Input. Open rather than a closed union: an author may
 * declare one Collie does not know, and what a Workflow calls its work source is its
 * own business — `strategies.ts` is what decides what each one means.
 */
export type InputStrategy = string;

export interface Provenance {
  path: string;
  layer: LayerName;
  /** The definition this one changes only part of, resolved through the layers below. */
  extends?: string;
  /** For a full copy: the parent's content hash when the copy was taken. */
  forkedFromHash?: string;
  /** The parent's content hash now, so a stale full copy can be spotted. */
  parentHash?: string;
}

/**
 * What a Workflow needs of the repository, and so which checkout a Run of it gets.
 * Declared as its definition's `checkout` rather than inferred from its name, so a fork
 * is whatever it says it is and inherits this like everything else it does not restate.
 *
 * - `none` reads a diff or the caller's own tree, and works where it was started.
 * - `branch` owns the checkout of the branch it builds, so two Runs never share an
 *   index or a stash stack.
 * - `roaming` is detached at the default branch and moves across the branches it
 *   merges, binding none of them to itself.
 */
export type CheckoutKind = "none" | "branch" | "roaming";

export interface PersonaDef extends Provenance {
  name: string;
  description: string;
  body: string;
}

export function personaData(persona: PersonaDef): PersonaView {
  return {
    name: persona.name,
    description: persona.description,
    body: persona.body,
    layer: persona.layer,
    path: persona.path,
    extends: persona.extends ?? null,
  };
}

/** A full copy whose parent has changed since: what it copied is no longer what it forked. */
export function isStale(def: Provenance): boolean {
  return Boolean(def.forkedFromHash && def.parentHash && def.forkedFromHash !== def.parentHash);
}

export const contentHash = Effect.fn("Definitions.contentHash")(function* (text: string) {
  const digest = yield* Digest.Digest;
  return pipe_(
    yield* digest.digestHex(Digest.sha1, new TextEncoder().encode(text)),
    Str.slice(0, 12),
  );
});

/** What the layers hold. Workflows are modules now, and are found by `discovery`. */
export interface Definitions {
  personas: Map<string, PersonaDef>;
  errors: string[];
}

/**
 * Where the skills themselves live. They are shared across harnesses and installed
 * by skills.sh, so a missing one is a missing prerequisite — like the harness binary
 * — not a definition error to work around.
 */
export const skillDirs = Effect.fn("Definitions.skillDirs")(function* (env: {
  home: string;
  cwd: string;
}) {
  const path = yield* Path.Path;
  return [path.join(env.cwd, ".agents", "skills"), path.join(env.home, ".agents", "skills")];
});

export const layers = Effect.fn("Definitions.layers")(function* (env: {
  pluginRoot: string;
  userDir: string;
  cwd: string;
}) {
  const path = yield* Path.Path;
  const baseline: Layer = { name: "baseline", dir: env.pluginRoot };
  const user: Layer = { name: "user", dir: env.userDir };
  const project: Layer = { name: "project", dir: path.join(env.cwd, ".collie") };
  return { baseline, user, project, all: [baseline, user, project] };
});

const markdownFiles = Effect.fn("Definitions.markdownFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(dir))) return [];
  return Arr.map(
    Arr.filter(yield* fs.readDirectory(dir), (f) => pipe_(f, Str.endsWith(".md"))).sort(),
    (f) => path.join(dir, f),
  );
});

function str(value: YamlValue | undefined, fallback = ""): string {
  return value !== undefined && isString(value) ? value : fallback;
}

/** One persona file, refused when its body names anything but a skill. */
const parsePersona = Effect.fn("Definitions.parsePersona")(function* (
  file: string,
  layer: LayerName,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(file);
  const { data, body } = yield* Effect.try({
    try: () => parseDocument(text),
    catch: (cause) =>
      cause instanceof YamlError ? cause : new Cause.UnknownError(cause, String(cause)),
  });
  const unfilled = personaHoles(body);
  if (unfilled.length > 0) {
    return yield* new Cause.IllegalArgumentError(
      `it names ${Arr.join(unfilled, ", ")}; a persona is told nothing but {{skill:name}}`,
    );
  }
  const persona: PersonaDef = {
    name: str(data.name, path.basename(file, ".md")),
    description: str(data.description),
    body,
    path: file,
    layer,
  };
  if (isString(data.extends)) persona.extends = data.extends;
  if (isString(data.forked_from_hash)) persona.forkedFromHash = data.forked_from_hash;
  return persona;
});

/** Every expression in a persona that nothing fills: all of them but a skill. */
export const personaHoles = (body: string): string[] => [
  ...Arr.map(expressionsIn(body), (name) => `{{${name}}}`),
  ...malformedIn(body),
];

export const loadDefinitions = Effect.fn("Definitions.loadDefinitions")(function* (
  layers: Layer[] | { readonly all: Layer[] },
) {
  const personas = new Map<string, PersonaDef>();
  const errors: string[] = [];

  for (const layer of Arr.isArray(layers) ? layers : layers.all) {
    yield* loadLayer(personas, layer, "personas", parsePersona, mergePersona, errors);
  }

  return { personas, errors };
});

/**
 * One layer of one kind. A file that names no parent replaces what the layers below
 * had; a file with `extends:` changes only what it names, and is resolved in
 * dependency order so a parent in the same layer is merged before its child.
 */
const loadLayer = Effect.fn("Definitions.loadLayer")(function* <
  T extends Provenance & { name: string },
>(
  into: Map<string, T>,
  layer: Layer,
  kind: "personas",
  parse: (
    path: string,
    layer: LayerName,
  ) => Effect.Effect<
    T,
    YamlError | Error | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >,
  merge: (parent: T, child: T) => T,
  errors: string[],
) {
  const pathSvc = yield* Path.Path;
  const parsed = new Map<string, T>();
  for (const path of yield* markdownFiles(pathSvc.join(layer.dir, kind))) {
    const result = yield* Effect.result(parse(path, layer.name));
    if (Result.isSuccess(result)) parsed.set(result.success.name, result.success);
    else
      errors.push(
        `${path}: ${result.failure instanceof Error ? result.failure.message : String(result.failure)}`,
      );
  }

  const settled = new Set<string>();
  const resolve = (
    name: string,
    chain: string[],
  ): Effect.Effect<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | Digest.Digest
  > =>
    Effect.gen(function* () {
      if (settled.has(name)) return;
      const def = parsed.get(name);
      if (!def) return;
      settled.add(name);

      // What this file is built on, before it goes in: the same name from a lower
      // layer is the usual case, and another name in this layer is resolved first.
      const parentName = def.extends;
      if (!parentName) {
        into.set(name, yield* withParentHash(def, into));
        return;
      }
      if (chain.includes(parentName)) {
        errors.push(`${def.path}: extends cycle (${Arr.join([...chain, parentName], " → ")})`);
        return;
      }
      if (parsed.has(parentName) && parentName !== name)
        yield* resolve(parentName, [...chain, name]);

      const parent = into.get(parentName);
      if (!parent) {
        errors.push(`${def.path}: extends "${parentName}", which no layer below this one defines`);
        return;
      }
      into.set(name, yield* withParentHash(merge(parent, def), into));
    });
  for (const name of parsed.keys()) yield* resolve(name, []);
});

/**
 * The hash of the file this definition shadows, so a full copy whose original has
 * moved on can be spotted. Only a full copy carries a hash to compare against.
 */
const withParentHash = Effect.fn("Definitions.withParentHash")(function* <
  T extends Provenance & { name: string },
>(def: T, into: Map<string, T>) {
  if (!def.forkedFromHash) return def;
  const shadowed = into.get(def.name);
  const parentHash = shadowed ? yield* readHash(shadowed.path) : undefined;
  return parentHash ? { ...def, parentHash } : def;
});

const readHash = Effect.fn("Definitions.readHash")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.void));
  return text === undefined ? undefined : yield* contentHash(text);
});

/** The parent with the child's frontmatter and sections laid over it. */
function mergePersona(parent: PersonaDef, child: PersonaDef): PersonaDef {
  return {
    ...parent,
    ...pick(child, ["name", "path", "layer", "extends", "forkedFromHash"]),
    description: child.description || parent.description,
    body: mergeBody(parent.body, child.body),
  };
}

function pick<T, K extends keyof T>(from: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

/**
 * Section by section: a child's `## <name>` replaces the parent's of the same name,
 * new ones are appended, and the preamble is replaced only when the child has one.
 * The result is rebuilt rather than spliced, so the merged body is normalised —
 * which is what every reader of it already assumes.
 */
function mergeBody(parent: string, child: string): string {
  const a = bodySections(parent);
  const b = bodySections(child);
  const sections = new Map(a.sections);
  for (const [name, text] of b.sections) sections.set(name, text);

  const preamble = Str.trim(b.preamble) === "" ? a.preamble : b.preamble;
  const parts = [Str.trim(preamble)];
  for (const [name, text] of sections) parts.push(`## ${name}\n\n${text}`);
  return `${Arr.join(
    Arr.filter(parts, (p) => p !== ""),
    "\n\n",
  )}\n`;
}

/** Body split into a shared preamble plus one section per `## <step-id>` heading. */
export interface BodySections {
  preamble: string;
  sections: Map<string, string>;
}

export function bodySections(body: string): BodySections {
  const sections = new Map<string, string>();
  const lines = Str.split(body, "\n");
  const preamble: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, Str.trim(Arr.join(buf, "\n")));
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1]!;
      continue;
    }
    if (current === null) preamble.push(line);
    else buf.push(line);
  }
  flush();
  return { preamble: Str.trim(Arr.join(preamble, "\n")), sections };
}

export const skillFile = Effect.fn("Definitions.skillFile")(function* (
  dirs: ReadonlyArray<string>,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of dirs) {
    const file = path.join(dir, name, "SKILL.md");
    if (yield* fs.exists(file)) return file;
  }
  return null;
});
