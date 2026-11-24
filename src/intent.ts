import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

import * as Option from "effect/Option";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { RunRecords, runOfDir } from "./run-records";
import type { Voice } from "./proposals";
import type { IntentSeedSchema, RuleSpecSchema } from "./intent-model";
import { AuthoritySchema, ConstraintSchema, DefaultsSchema } from "./intent-model";
import { VerifySpecSchema } from "./verify-spec";
import type { VerifySpec } from "./verify-spec";
import { stringifyJson } from "./json";

export { VerifySpecSchema, type VerifySpec };

export type RuleSpec = Schema.Schema.Type<typeof RuleSpecSchema>;
export type Constraint = Schema.Schema.Type<typeof ConstraintSchema>;
export type Authority = Schema.Schema.Type<typeof AuthoritySchema>;

export const DEFAULT_AUTHORITY: Authority = {
  auto_correct: true,
  max_corrections_per_constraint: 2,
  now_allowed: false,
  interrupt_allowed: false,
  stop_allowed: false,
  exclusive_steering: false,
  run_verification: [],
};

export const IntentSchema = Schema.Struct({
  version: Schema.Int,
  run: Schema.String,
  goal: Schema.NullOr(Schema.String),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  constraints: Schema.Array(ConstraintSchema),
  authority: AuthoritySchema,
  parent: Schema.NullOr(
    Schema.Struct({ run: Schema.String, version: Schema.Int, applied: Schema.Int }),
  ),
  history: Schema.Array(
    Schema.Struct({
      version: Schema.Int,
      at: Schema.String,
      by: Schema.String,
      conversation: Schema.optionalKey(Schema.String),
      said: Schema.optionalKey(Schema.String),
      attachments: Schema.optionalKey(Schema.Array(Schema.String)),
      change: Schema.String,
    }),
  ),
});
export type Intent = Schema.Schema.Type<typeof IntentSchema>;

export type Defaults = Schema.Schema.Type<typeof DefaultsSchema>;
export const DefaultsJson = Schema.fromJsonString(DefaultsSchema);

export type IntentSeed = typeof IntentSeedSchema.Type;

const IntentJson = Schema.fromJsonString(IntentSchema);
const encodeIntent = flow(Schema.encodeResult(IntentJson), Result.getOrThrow);

// WARNING: Never replaced by a default: an unreadable Intent stops rather than being guessed.
export class IntentUnreadable extends Data.TaggedError("IntentUnreadable")<{
  dir: string;
  cause: string;
}> {}

export const INTENT_FILE = "intent.json";

const decodeIntent = (dir: string) => (raw: string) =>
  Schema.decodeEffect(IntentJson)(raw).pipe(
    Effect.mapError((cause) => new IntentUnreadable({ dir, cause: String(cause) })),
  );

export const readIntent = Effect.fn("Intent.read")(function* (dir: string) {
  const raw = yield* RunRecords.use((records) => records.fact(runOfDir(dir), INTENT_FILE));
  return raw === null ? null : yield* decodeIntent(dir)(raw);
});

// WARNING: Read, decision and write are one transaction, so two amendments cannot erase each other.
export const updateIntent = <E, R>(
  dir: string,
  change: (intent: Intent | null) => Effect.Effect<Intent | null, E, R>,
) =>
  RunRecords.use((records) =>
    records.update(runOfDir(dir), INTENT_FILE, (raw) =>
      Effect.gen(function* () {
        const next = yield* change(raw === null ? null : yield* decodeIntent(dir)(raw));
        return next === null ? raw : `${encodeIntent(next)}\n`;
      }),
    ),
  ).pipe(Effect.flatMap((raw) => (raw === null ? Effect.succeed(null) : decodeIntent(dir)(raw))));

export const writeIntent = Effect.fn("Intent.write")(function* (dir: string, intent: Intent) {
  yield* RunRecords.use((records) =>
    records.put(runOfDir(dir), INTENT_FILE, `${encodeIntent(intent)}\n`),
  );
});

export function constraintId(text: string) {
  return pipe(Bun.hash(text).toString(16), Str.slice(0, 8));
}

export type Change =
  | { readonly kind: "set-goal"; readonly goal: string | null }
  | { readonly kind: "set-outcome"; readonly outcome: string | null }
  | { readonly kind: "add-constraint"; readonly constraint: Omit<Constraint, "since"> }
  | { readonly kind: "remove-constraint"; readonly id: string }
  | { readonly kind: "authority"; readonly patch: Partial<Authority> };

export function outcomeChange(word: string) {
  const returned: Change = { kind: "set-outcome", outcome: word === "unspecified" ? null : word };
  return returned;
}

export function verificationGrant(
  intent: Intent,
  name: string,
  command: Omit<VerifySpec, "name"> | null,
) {
  const kept = Arr.filter(intent.authority.run_verification, (spec) => spec.name !== name);
  const returned: Change = {
    kind: "authority",
    patch: { run_verification: command === null ? kept : [...kept, { name, ...command }] },
  };
  return returned;
}

function describe(change: Change) {
  switch (change.kind) {
    case "set-goal":
      return `goal set to ${change.goal === null ? "nothing" : stringifyJson(change.goal)}`;
    case "set-outcome":
      return change.outcome === null ? "outcome cleared" : `outcome set to ${change.outcome}`;
    case "add-constraint":
      return `constraint ${change.constraint.id} added (${change.constraint.severity})`;
    case "remove-constraint":
      return `constraint ${change.id} removed`;
    case "authority":
      return `authority ${Arr.join(
        Arr.map(
          Arr.map(Struct.keys(change.patch), (key) => [key, change.patch[key]] as const),
          ([k, v]) => `${k}=${stringifyJson(v)}`,
        ),
        ", ",
      )}`;
  }
}

function applied(intent: Intent, change: Change, version: number) {
  switch (change.kind) {
    case "set-goal":
      return intent.goal === change.goal ? null : { ...intent, goal: change.goal };
    case "set-outcome":
      return intent.outcome === change.outcome ? null : { ...intent, outcome: change.outcome };
    case "add-constraint": {
      const constraint = { ...change.constraint, since: version };
      const without = Arr.filter(intent.constraints, (c) => c.id !== constraint.id);
      return { ...intent, constraints: [...without, constraint] };
    }
    case "remove-constraint": {
      const kept = Arr.filter(intent.constraints, (c) => c.id !== change.id);
      return kept.length === intent.constraints.length ? null : { ...intent, constraints: kept };
    }
    case "authority":
      return { ...intent, authority: { ...intent.authority, ...change.patch } };
  }
}

// WARNING: A no-op returns the same version: a bump that changed nothing would be a history entry nobody can act on.
export function amend(intent: Intent, change: Change, by: string, at: string, voice: Voice = {}) {
  const version = intent.version + 1;
  const next = applied(intent, change, version);
  if (!next) {
    return intent;
  }
  return {
    ...next,
    version,
    history: [...intent.history, { version, at, by, ...voice, change: describe(change) }],
  };
}

export function withOutcome(options: Readonly<Record<string, string>>, intent: Intent | null) {
  if (intent?.outcome === undefined) {
    return options;
  }
  const { outcome: _admitted, ...rest } = options;
  return intent.outcome === null ? rest : { ...rest, outcome: intent.outcome };
}

export const PLAN_AUTHOR = "plan:plan/SPEC.md";

// WARNING: A constraint anyone else removed is never put back by the plan.
export function followPlan(
  intent: Intent,
  found: ReadonlyArray<Omit<Constraint, "since">>,
  at: string,
) {
  const removedByOthers = new Set(
    Arr.map(
      Arr.filter(intent.history, (entry) => entry.by !== PLAN_AUTHOR),
      (entry) => entry.change,
    ),
  );
  const held = new Set(Arr.map(intent.constraints, (c) => c.id));
  const wanted = new Set(Arr.map(found, (c) => c.id));
  const added = Arr.reduce(
    Arr.filter(found, (c) => !held.has(c.id) && !removedByOthers.has(`constraint ${c.id} removed`)),
    intent,
    (next, constraint) =>
      Arr.some(next.constraints, (c) => c.id === constraint.id)
        ? next
        : amend(next, { kind: "add-constraint", constraint }, PLAN_AUTHOR, at),
  );
  return Arr.reduce(
    Arr.filter(
      intent.constraints,
      (c) => c.source === "plan" && c.provenance?.file === "plan/SPEC.md" && !wanted.has(c.id),
    ),
    added,
    (next, c) => amend(next, { kind: "remove-constraint", id: c.id }, PLAN_AUTHOR, at),
  );
}

export interface SeedOptions {
  readonly defaults?: Defaults | null;
  readonly goal?: string | null;
  readonly constraints?: ReadonlyArray<Omit<Constraint, "since"> & { since?: number }>;
  readonly runVerification?: ReadonlyArray<VerifySpec>;
}

// WARNING: Named entries replace a default with the same id, so a stricter one is one constraint, not two.
export function seedIntent(run: string, options: SeedOptions) {
  const byId = new Map<string, Constraint>();
  for (const constraint of options.defaults?.constraints ?? []) {
    byId.set(constraint.id, constraint);
  }
  for (const constraint of options.constraints ?? []) {
    byId.set(constraint.id, { ...constraint, since: 1 });
  }
  return {
    version: 1,
    run,
    goal: options.goal ?? null,
    constraints: [...byId.values()],
    authority: {
      ...(options.defaults?.authority ?? DEFAULT_AUTHORITY),
      run_verification: [
        ...(options.runVerification ?? options.defaults?.authority.run_verification ?? []),
      ],
    },
    parent: null,
    history: [],
  };
}

export function propagate(parent: Intent, child: Intent) {
  const own = Arr.filter(child.constraints, (c) => c.source !== "parent");
  const ownIds = new Set(Arr.map(own, (c) => c.id));
  const inherited = Arr.map(
    Arr.filter(parent.constraints, (c) => !ownIds.has(c.id)),
    (c) => ({ ...c, source: "parent" as const }),
  );
  const conflicts: Array<string> = [];
  for (const c of parent.constraints) {
    if (ownIds.has(c.id)) {
      conflicts.push(`constraint ${c.id}: the child's own entry is kept`);
    }
  }
  const goal = child.goal ?? parent.goal;
  if (child.goal !== null && parent.goal !== null && child.goal !== parent.goal) {
    conflicts.push(
      `goal: parent ${stringifyJson(parent.goal)} differs from the child's ${stringifyJson(child.goal)}`,
    );
  }
  return {
    intent: {
      ...child,
      goal,
      constraints: [...own, ...inherited],
      parent: { run: parent.run, version: parent.version, applied: parent.version },
    },
    conflicts,
  };
}

const NUMBER = String.raw`(?:\d+(?:\.\d+)*[.)]?\s+)?`;
const REQUIREMENT_HEADING = new RegExp(
  String.raw`^#+\s*${NUMBER}(Requirements|Success criteria|Boundaries|Constraints|Out of scope|Done when)\b`,
  "i",
);
const OBJECTIVE_HEADING = new RegExp(String.raw`^#+\s*${NUMBER}Objective\b`, "i");
const SOLUTION_HEADING = new RegExp(String.raw`^#+\s*${NUMBER}Solution\b`, "i");
const HEADING = /^#+\s/;
const BULLET = /^(\s*)[-*]\s+(.*\S)\s*$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*\S)\s*$/;

// WARNING: Heading match only, with no model: a plan may not grant authority.
export function extractRequirements(text: string, file: string) {
  const lines = Str.split(text, "\n");
  const constraints: Array<Omit<Constraint, "since">> = [];
  let heading: string | null = null;
  let bullet: { indent: number; parts: Array<string>; line: number } | null = null;
  const flush = () => {
    if (bullet === null || heading === null) {
      return;
    }
    const body = Arr.join(bullet.parts, " ");
    const text = /^out of scope$/i.test(heading) ? `Out of scope: ${body}` : body;
    constraints.push({
      id: constraintId(text),
      kind: "semantic",
      text,
      severity: "warn",
      source: "plan",
      provenance: { file, heading, line: bullet.line },
    });
    bullet = null;
  };
  for (const [index, line] of lines.entries()) {
    if (HEADING.test(line) || Str.trim(line) === "") {
      flush();
    }
    if (HEADING.test(line)) {
      const match = REQUIREMENT_HEADING.exec(line);
      heading = match ? match[1]! : null;
      continue;
    }
    if (heading === null || Str.trim(line) === "") {
      continue;
    }
    const item = BULLET.exec(line);
    const numbered = item === null ? NUMBERED.exec(line) : null;
    const listed = item ?? numbered;
    if (listed === null) {
      bullet?.parts.push(Str.trim(line));
      continue;
    }
    const indent = listed[1]!.length;
    if (bullet !== null && indent > bullet.indent) {
      bullet.parts.push(listed[2]!);
      continue;
    }
    flush();
    // WARNING: A numbered item ends a bullet but is not one.
    if (item !== null) {
      bullet = { indent, parts: [item[2]!], line: index + 1 };
    }
  }
  flush();
  const goal =
    firstParagraphUnder(lines, OBJECTIVE_HEADING) ?? firstParagraphUnder(lines, SOLUTION_HEADING);
  return { goal, constraints };
}

function firstParagraphUnder(lines: ReadonlyArray<string>, heading: RegExp) {
  const start = Option.getOrElse(
    Arr.findFirstIndex(lines, (line) => heading.test(line)),
    () => -1,
  );
  if (start < 0) {
    return null;
  }
  const paragraph: Array<string> = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line) || (Str.trim(line) === "" && paragraph.length > 0)) {
      break;
    }
    if (Str.trim(line) !== "") {
      paragraph.push(Str.trim(line));
    }
  }
  return paragraph.length > 0 ? Arr.join(paragraph, " ") : null;
}

export const defaultsPath = Effect.fn("Intent.defaultsPath")(function* (
  stateDir: string,
  key: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, "steering", key, "defaults.json");
});

export const readDefaults = Effect.fn("Intent.readDefaults")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
    return null;
  }
  const raw = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((cause) => new IntentUnreadable({ dir: file, cause: String(cause) })));
  return yield* Schema.decodeEffect(DefaultsJson)(raw).pipe(
    Effect.mapError((cause) => new IntentUnreadable({ dir: file, cause: String(cause) })),
  );
});

export const writeDefaults = Effect.fn("Intent.writeDefaults")(function* (
  file: string,
  defaults: Defaults,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    tmp,
    `${yield* Schema.encodeEffect(DefaultsJson)(defaults).pipe(Effect.orDie)}\n`,
  );
  yield* fs.rename(tmp, file);
});

export const EMPTY_DEFAULTS: Defaults = { constraints: [], authority: DEFAULT_AUTHORITY };

export function describeDefaults(defaults: Defaults) {
  return Arr.join(
    [
      ...Arr.map(defaults.constraints, (c) => `${c.id}\t${c.severity}\t${c.kind}\t${c.text}`),
      ...Arr.map(
        Arr.map(Struct.keys(defaults.authority), (key) => [key, defaults.authority[key]] as const),
        ([k, v]) => `authority ${k}=${stringifyJson(v)}`,
      ),
    ],
    "\n",
  );
}

export const fromWorkSource = Effect.fn("Intent.fromWorkSource")(function* (
  kind: string | null,
  value: string,
) {
  const none: ReadonlyArray<Omit<Constraint, "since">> = [];
  if (kind !== "plan-dir") {
    return { goal: value === "" ? null : value, constraints: none };
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spec = path.join(value, "SPEC.md");
  if (!(yield* fs.exists(spec).pipe(Effect.orElseSucceed(() => false)))) {
    return { goal: null, constraints: none };
  }
  const text = yield* fs.readFileString(spec).pipe(Effect.orElseSucceed(() => ""));
  return extractRequirements(text, "SPEC.md");
});

export function parseConstraint(text: string, severity: "block" | "warn") {
  const base = {
    id: constraintId(text),
    text,
    severity,
    source: "human" as const,
  };
  if (!pipe(text, Str.startsWith("rule:"))) {
    return { ...base, kind: "semantic" as const };
  }
  const [, kind, ...rest] = Str.split(text, ":");
  const rule = parseRule(kind ?? "", rest);
  return "error" in rule ? rule : { ...base, kind: "rule" as const, rule };
}

function parseRule(kind: string, args: Array<string>) {
  const wrong = (spelling: string) => ({
    error: `rule:${kind} is spelled rule:${kind}:${spelling}`,
  });
  switch (kind) {
    case "protected_paths":
      return args[0]
        ? { kind, globs: Arr.filter(Str.split(args[0], ","), (g) => g !== "") }
        : wrong("<glob>[,<glob>…]");
    case "branch_is":
      return args[0] ? { kind, name: args[0] } : wrong("<branch>");
    case "mr_target":
      return args[0]
        ? args[1]
          ? { kind, project: args[0], iid: args[1] }
          : { kind, project: args[0] }
        : wrong("<project>[:<iid>]");
    case "output_field":
      return args.length === 4 && (args[2] === "eq" || args[2] === "ne")
        ? { kind, step: args[0]!, path: args[1]!, op: args[2], value: args[3]! }
        : wrong("<step>:<path>:eq|ne:<value>");
    case "command_exit": {
      const expect = Number(args[1]);
      return args[0] && Number.isInteger(expect)
        ? { kind, name: args[0], expect }
        : wrong("<verification name>:<exit code>");
    }
    default:
      return { error: `unknown rule "${kind}"` };
  }
}

const BOOLEAN_AUTHORITIES = new Set<string>([
  "auto_correct",
  "now_allowed",
  "interrupt_allowed",
  "stop_allowed",
  "exclusive_steering",
]);
const COUNT_AUTHORITIES = new Set<string>(["max_corrections_per_constraint"]);

// WARNING: Every grant is named here: an unvalidated key would be a grant nobody made.
export function authorityPatch(pairs: ReadonlyArray<string>) {
  const patch: {
    -readonly [K in keyof Authority]?: Authority[K];
  } = {};
  for (const pair of pairs) {
    const at = Option.getOrElse(pipe(pair, Str.indexOf("=")), () => -1);
    if (at <= 0) {
      return { error: `"${pair}" is not k=v.` };
    }
    const key = pipe(pair, Str.slice(0, at));
    const value = pipe(pair, Str.slice(at + 1));
    if (BOOLEAN_AUTHORITIES.has(key)) {
      if (value !== "true" && value !== "false") {
        return { error: `"${key}" is true or false.` };
      }
      // WARNING: `key` is in BOOLEAN_AUTHORITIES, so it names one of the boolean grants; they all take the same value type, and the literal picks one of them to say so.
      patch[key as "auto_correct"] = value === "true";
      continue;
    }
    if (COUNT_AUTHORITIES.has(key)) {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) {
        return { error: `"${key}" is a whole number.` };
      }
      // WARNING: `key` is in COUNT_AUTHORITIES, so it names one of the numeric grants.
      patch[key as "max_corrections_per_constraint"] = count;
      continue;
    }
    return { error: `"${key}" is not an authority.` };
  }
  return patch;
}
