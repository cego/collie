// A Run's Intent: what the human wants, what bounds it, and what Collie may do about
// it. Everything downstream — drift, corrections, cards — compares work against this,
// so it is versioned, seeded once at the start, and amended by a human or by the Run's own
// plan as its constraints change.
//
// Authority is never read from text. Plan bullets and repository files are evidence:
// `extractRequirements` returns constraints and a goal and has no way to return a grant.

import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { withDirLock } from "./lock";
import type { Voice } from "./proposals";
import {
  AuthoritySchema,
  ConstraintSchema,
  DefaultsSchema,
  IntentSeedSchema,
  RuleSpecSchema,
} from "./intent-model";
import { VerifySpecSchema, type VerifySpec } from "./verify-spec";

export { VerifySpecSchema, type VerifySpec };

export type RuleSpec = Schema.Schema.Type<typeof RuleSpecSchema>;
export type Constraint = Schema.Schema.Type<typeof ConstraintSchema>;
export type Authority = Schema.Schema.Type<typeof AuthoritySchema>;

/**
 * The one grant on by default is correcting drift at a work boundary, within the bound.
 * Every other grant is off.
 */
export const DEFAULT_AUTHORITY: Authority = {
  auto_correct: true,
  max_corrections_per_constraint: 2,
  now_allowed: false,
  interrupt_allowed: false,
  stop_allowed: false,
  exclusive_steering: false,
  run_verification: [],
};

const IntentSchema = Schema.Struct({
  version: Schema.Int,
  run: Schema.String,
  goal: Schema.NullOr(Schema.String),
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
      change: Schema.String,
    }),
  ),
});
export type Intent = Schema.Schema.Type<typeof IntentSchema>;

export type Defaults = Schema.Schema.Type<typeof DefaultsSchema>;
export const DefaultsJson = Schema.fromJsonString(DefaultsSchema);

export type IntentSeed = typeof IntentSeedSchema.Type;

const IntentJson = Schema.fromJsonString(IntentSchema);
const encodeIntent = Schema.encodeSync(IntentJson);

/** An `intent.json` that exists but is not an Intent. Never a default: see §7.1. */
export class IntentUnreadable extends Data.TaggedError("IntentUnreadable")<{
  dir: string;
  cause: string;
}> {}

export const INTENT_FILE = "intent.json";

export const readIntent = Effect.fn("Intent.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, INTENT_FILE);
  if (!(yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false))))) return null;
  const raw = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((cause) => new IntentUnreadable({ dir, cause: String(cause) })));
  return yield* Schema.decodeUnknownEffect(IntentJson)(raw).pipe(
    Effect.mapError((cause) => new IntentUnreadable({ dir, cause: String(cause) })),
  );
});

/**
 * The write itself, for a caller already inside `withDirLock`. An amendment is a read,
 * a decision and a write, and only all three under one lock stop two of them reading the
 * same version and the later rename erasing the earlier.
 */
export const writeIntentHeld = Effect.fn("Intent.writeHeld")(function* (
  dir: string,
  intent: Intent,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const file = path.join(dir, INTENT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${encodeIntent(intent)}\n`);
  yield* fs.rename(tmp, file);
});

export const writeIntent = Effect.fn("Intent.write")(function* (dir: string, intent: Intent) {
  yield* withDirLock(dir, writeIntentHeld(dir, intent));
});

/** A constraint is identified by what it says, so the same text is the same entry. */
export function constraintId(text: string): string {
  return Bun.hash(text).toString(16).slice(0, 8);
}

export type Change =
  | { readonly kind: "set-goal"; readonly goal: string | null }
  | { readonly kind: "add-constraint"; readonly constraint: Omit<Constraint, "since"> }
  | { readonly kind: "remove-constraint"; readonly id: string }
  | { readonly kind: "authority"; readonly patch: Partial<Authority> };

/** The authority change granting `name` this command, or withdrawing it where there is none. */
export function verificationGrant(
  intent: Intent,
  name: string,
  command: Omit<VerifySpec, "name"> | null,
): Change {
  const kept = intent.authority.run_verification.filter((spec) => spec.name !== name);
  return {
    kind: "authority",
    patch: { run_verification: command === null ? kept : [...kept, { name, ...command }] },
  };
}

function describe(change: Change): string {
  switch (change.kind) {
    case "set-goal":
      return `goal set to ${change.goal === null ? "nothing" : JSON.stringify(change.goal)}`;
    case "add-constraint":
      return `constraint ${change.constraint.id} added (${change.constraint.severity})`;
    case "remove-constraint":
      return `constraint ${change.id} removed`;
    case "authority":
      return `authority ${Object.entries(change.patch)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")}`;
  }
}

function applied(intent: Intent, change: Change, version: number): Intent | null {
  switch (change.kind) {
    case "set-goal":
      return intent.goal === change.goal ? null : { ...intent, goal: change.goal };
    case "add-constraint": {
      const constraint = { ...change.constraint, since: version };
      const without = intent.constraints.filter((c) => c.id !== constraint.id);
      return { ...intent, constraints: [...without, constraint] };
    }
    case "remove-constraint": {
      const kept = intent.constraints.filter((c) => c.id !== change.id);
      return kept.length === intent.constraints.length ? null : { ...intent, constraints: kept };
    }
    case "authority":
      return { ...intent, authority: { ...intent.authority, ...change.patch } };
  }
}

/**
 * The amended Intent, one version on, or the same one where the change is a no-op — a
 * version bump that changed nothing is a history entry nobody can act on, and every
 * later comparison keys off the version.
 */
export function amend(
  intent: Intent,
  change: Change,
  by: string,
  at: string,
  voice: Voice = {},
): Intent {
  const version = intent.version + 1;
  const next = applied(intent, change, version);
  if (!next) return intent;
  return {
    ...next,
    version,
    history: [...intent.history, { version, at, by, ...voice, change: describe(change) }],
  };
}

/** Who an amendment from the Run's own plan is by; every other author's removal stands. */
export const PLAN_AUTHOR = "plan:plan/SPEC.md";

/**
 * The Intent with the Run's own plan's constraints as the plan now says them: new ones
 * added, ones the plan dropped removed. A constraint anyone else removed is never put back,
 * and nothing from anyone else is touched.
 */
export function followPlan(
  intent: Intent,
  found: ReadonlyArray<Omit<Constraint, "since">>,
  at: string,
): Intent {
  const removedByOthers = new Set(
    intent.history.filter((entry) => entry.by !== PLAN_AUTHOR).map((entry) => entry.change),
  );
  const held = new Set(intent.constraints.map((c) => c.id));
  const wanted = new Set(found.map((c) => c.id));
  const added = found
    .filter((c) => !held.has(c.id) && !removedByOthers.has(`constraint ${c.id} removed`))
    .reduce(
      (next, constraint) =>
        next.constraints.some((c) => c.id === constraint.id)
          ? next
          : amend(next, { kind: "add-constraint", constraint }, PLAN_AUTHOR, at),
      intent,
    );
  return intent.constraints
    .filter(
      (c) => c.source === "plan" && c.provenance?.file === "plan/SPEC.md" && !wanted.has(c.id),
    )
    .reduce(
      (next, c) => amend(next, { kind: "remove-constraint", id: c.id }, PLAN_AUTHOR, at),
      added,
    );
}

export interface SeedOptions {
  readonly defaults?: Defaults | null;
  readonly goal?: string | null;
  /** What the human typed, and what the work source's own text asked for. */
  readonly constraints?: ReadonlyArray<Omit<Constraint, "since"> & { since?: number }>;
  /**
   * The approved set the Run was started with — `.collie/verify.json` as read at start.
   * Written into `run_verification` so the Intent *is* the set from version 1, and `run
   * intent verification` amends one list rather than a list that shadows another.
   */
  readonly runVerification?: ReadonlyArray<VerifySpec>;
}

/**
 * Version 1: workspace defaults, then what was named at launch. Named entries replace
 * a default with the same id, so a human who typed a stricter version of a default
 * gets one constraint and not two that disagree.
 */
export function seedIntent(run: string, options: SeedOptions): Intent {
  const byId = new Map<string, Constraint>();
  for (const constraint of options.defaults?.constraints ?? []) byId.set(constraint.id, constraint);
  for (const constraint of options.constraints ?? [])
    byId.set(constraint.id, { ...constraint, since: 1 });
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

/**
 * The child's Intent after its parent's current one is applied to it: parent-sourced
 * entries are replaced wholesale, the child's own are kept, and anything the two
 * disagree about is returned rather than resolved. Pure, so that the caller can see what
 * it decided without having to run it again to find out.
 */
export function propagate(parent: Intent, child: Intent) {
  const own = child.constraints.filter((c) => c.source !== "parent");
  const ownIds = new Set(own.map((c) => c.id));
  const inherited = parent.constraints
    .filter((c) => !ownIds.has(c.id))
    .map((c) => ({ ...c, source: "parent" as const }));
  const conflicts: string[] = [];
  for (const c of parent.constraints)
    if (ownIds.has(c.id)) conflicts.push(`constraint ${c.id}: the child's own entry is kept`);
  const goal = child.goal ?? parent.goal;
  if (child.goal !== null && parent.goal !== null && child.goal !== parent.goal)
    conflicts.push(
      `goal: parent ${JSON.stringify(parent.goal)} differs from the child's ${JSON.stringify(child.goal)}`,
    );
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

// `## 1. Objective` is a heading: a numbered plan is not one with no goal.
const NUMBER = String.raw`(?:\d+(?:\.\d+)*[.)]?\s+)?`;
// `Out of scope` and `Done when` are what Collie's own planners write.
const REQUIREMENT_HEADING = new RegExp(
  String.raw`^#+\s*${NUMBER}(Requirements|Success criteria|Boundaries|Constraints|Out of scope|Done when)\b`,
  "i",
);
const OBJECTIVE_HEADING = new RegExp(String.raw`^#+\s*${NUMBER}Objective\b`, "i");
const HEADING = /^#+\s/;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;

/**
 * What a plan asks for, read deterministically: bullets under a heading whose text
 * matches, and the first paragraph under `## Objective` as the goal. Heading match
 * only — no model, no inference — because this is evidence a human can check against
 * the file, and because a plan may not grant authority (SPEC §5). The return type is
 * how that is enforced: there is nowhere here to put a grant.
 */
export function extractRequirements(text: string, file: string) {
  const lines = text.split("\n");
  const constraints: Array<Omit<Constraint, "since">> = [];
  let goal: string | null = null;
  let heading: string | null = null;
  let objective: string[] | null = null;
  for (const [index, line] of lines.entries()) {
    if (HEADING.test(line)) {
      if (objective !== null && objective.length > 0) goal = objective.join(" ");
      objective = OBJECTIVE_HEADING.test(line) ? [] : null;
      const match = REQUIREMENT_HEADING.exec(line);
      heading = match ? match[1]! : null;
      continue;
    }
    if (objective !== null && goal === null) {
      if (line.trim() === "") {
        if (objective.length > 0) goal = objective.join(" ");
      } else objective.push(line.trim());
      continue;
    }
    if (heading === null) continue;
    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    const body = bullet[1]!;
    const text = /^out of scope$/i.test(heading) ? `Out of scope: ${body}` : body;
    constraints.push({
      id: constraintId(text),
      kind: "semantic",
      text,
      severity: "warn",
      source: "plan",
      provenance: { file, heading, line: index + 1 },
    });
  }
  if (goal === null && objective !== null && objective.length > 0) goal = objective.join(" ");
  return { goal, constraints };
}

/** Where a workspace keeps what every Run it starts begins with. */
export const defaultsPath = Effect.fn("Intent.defaultsPath")(function* (
  stateDir: string,
  key: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, "steering", key, "defaults.json");
});

export const readDefaults = Effect.fn("Intent.readDefaults")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false))))) return null;
  const raw = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((cause) => new IntentUnreadable({ dir: file, cause: String(cause) })));
  return yield* Schema.decodeUnknownEffect(DefaultsJson)(raw).pipe(
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
  yield* fs.writeFileString(tmp, `${Schema.encodeSync(DefaultsJson)(defaults)}\n`);
  yield* fs.rename(tmp, file);
});

export const EMPTY_DEFAULTS: Defaults = { constraints: [], authority: DEFAULT_AUTHORITY };

/** The defaults as a human reads them: what every Run started here begins with. */
export function describeDefaults(defaults: Defaults): string {
  return [
    ...defaults.constraints.map((c) => `${c.id}\t${c.severity}\t${c.kind}\t${c.text}`),
    ...Object.entries(defaults.authority).map(([k, v]) => `authority ${k}=${JSON.stringify(v)}`),
  ].join("\n");
}

/**
 * What the work source itself asks for. A `plan-dir` is read: its `SPEC.md` headings
 * are matched literally by `extractRequirements`, so the constraints are evidence a
 * human can check line by line. Every other kind names one thing to do, and that text
 * is the goal — never a grant, and never a constraint inferred from prose.
 */
export const fromWorkSource = Effect.fn("Intent.fromWorkSource")(function* (
  kind: string | null,
  value: string,
) {
  const none: ReadonlyArray<Omit<Constraint, "since">> = [];
  if (kind !== "plan-dir") return { goal: value === "" ? null : value, constraints: none };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spec = path.join(value, "SPEC.md");
  if (!(yield* fs.exists(spec).pipe(Effect.catch(() => Effect.succeed(false)))))
    return { goal: null, constraints: none };
  const text = yield* fs.readFileString(spec).pipe(Effect.catch(() => Effect.succeed("")));
  return extractRequirements(text, "SPEC.md");
});

/**
 * A constraint as the CLI spells it. `rule:<kind>:<args>` is a rule the Driver can
 * check itself; anything else is semantic and is judged. The spelling is exact and
 * positional on purpose — a constraint the human cannot predict the meaning of is
 * worse than one they have to look up.
 */
export function parseConstraint(
  text: string,
  severity: "block" | "warn",
): Omit<Constraint, "since"> | { readonly error: string } {
  const base = {
    id: constraintId(text),
    text,
    severity,
    source: "human" as const,
  };
  if (!text.startsWith("rule:")) return { ...base, kind: "semantic" as const };
  const [, kind, ...rest] = text.split(":");
  const rule = parseRule(kind ?? "", rest);
  return "error" in rule ? rule : { ...base, kind: "rule" as const, rule };
}

function parseRule(kind: string, args: string[]): RuleSpec | { readonly error: string } {
  const wrong = (spelling: string) => ({
    error: `rule:${kind} is spelled rule:${kind}:${spelling}`,
  });
  switch (kind) {
    case "protected_paths":
      return args[0]
        ? { kind, globs: args[0].split(",").filter((g) => g !== "") }
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

/** The grants that are a yes or a no, and the ones that are a count. */
const BOOLEAN_AUTHORITIES = new Set<string>([
  "auto_correct",
  "now_allowed",
  "interrupt_allowed",
  "stop_allowed",
  "exclusive_steering",
]);
const COUNT_AUTHORITIES = new Set<string>(["max_corrections_per_constraint"]);

/**
 * `k=v` pairs as an authority patch. Every grant is named here rather than merged from
 * whatever the caller wrote: authority decides what Collie may do without asking, so a
 * key nobody validated would be a grant nobody made. `run_verification` is deliberately
 * absent — a bound command is not a command-line word (SPEC §7.7).
 */
export function authorityPatch(pairs: ReadonlyArray<string>) {
  const patch: {
    -readonly [K in keyof Authority]?: Authority[K];
  } = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) return { error: `"${pair}" is not k=v.` };
    const key = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (BOOLEAN_AUTHORITIES.has(key)) {
      if (value !== "true" && value !== "false") return { error: `"${key}" is true or false.` };
      // SAFETY: `key` is in BOOLEAN_AUTHORITIES, so it names one of the boolean grants;
      // they all take the same value type, and the literal picks one of them to say so.
      patch[key as "auto_correct"] = value === "true";
      continue;
    }
    if (COUNT_AUTHORITIES.has(key)) {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) return { error: `"${key}" is a whole number.` };
      // SAFETY: `key` is in COUNT_AUTHORITIES, so it names one of the numeric grants.
      patch[key as "max_corrections_per_constraint"] = count;
      continue;
    }
    return { error: `"${key}" is not an authority.` };
  }
  return patch;
}
