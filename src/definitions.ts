import * as Cause from "effect/Cause";

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
  "reach",
  "internal",
  "repository",
  // WARNING: a legacy key, still read as repository.
  "gitlab-repository",
] as const;

export type InputStrategy = string;

export interface Provenance {
  path: string;
  layer: LayerName;
  extends?: string;
  forkedFromHash?: string;
  parentHash?: string;
}

// WARNING: a branch checkout is its own, so two Runs never share an index or a stash stack.
export type CheckoutKind = "none" | "branch" | "roaming";

export interface PersonaDef extends Provenance {
  name: string;
  description: string;
  body: string;
}

export function personaData(persona: PersonaDef) {
  return {
    name: persona.name,
    description: persona.description,
    body: persona.body,
    layer: persona.layer,
    path: persona.path,
    extends: persona.extends ?? null,
  };
}

export function isStale(def: Provenance) {
  return Boolean(def.forkedFromHash && def.parentHash && def.forkedFromHash !== def.parentHash);
}

export const contentHash = Effect.fn("Definitions.contentHash")(function* (text: string) {
  const digest = yield* Digest.Digest;
  return pipe_(
    yield* digest.digestHex(Digest.sha1, new TextEncoder().encode(text)),
    Str.slice(0, 12),
  );
});

export interface Definitions {
  personas: Map<string, PersonaDef>;
  errors: string[];
}

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

function str(value: YamlValue | undefined, fallback = "") {
  return value !== undefined && isString(value) ? value : fallback;
}

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

export const personaHoles = (body: string) => [
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
  const resolve: (
    name: string,
    chain: string[],
  ) => Effect.Effect<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | Digest.Digest
  > = (name, chain) =>
    Effect.gen(function* () {
      if (settled.has(name)) return;
      const def = parsed.get(name);
      if (!def) return;
      settled.add(name);

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

function mergePersona(parent: PersonaDef, child: PersonaDef) {
  return {
    ...parent,
    ...pick(child, ["name", "path", "layer", "extends", "forkedFromHash"]),
    description: child.description || parent.description,
    body: mergeBody(parent.body, child.body),
  };
}

function pick<T, K extends keyof T>(from: T, keys: K[]) {
  const out: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

function mergeBody(parent: string, child: string) {
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

export interface BodySections {
  preamble: string;
  sections: Map<string, string>;
}

export function bodySections(body: string) {
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
