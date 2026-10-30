// Where the work and the Intent disagree, and the evidence for saying so.
//
// Two kinds, deliberately apart. A `rule` constraint is something Collie can check by
// itself — which paths changed, which branch, which exit code — and it is checked with no
// model involved at all. A `semantic` one is a judgement, and judgement costs money and
// can be wrong, so it is made against **bounded actual evidence**: a capped diff of the
// files the constraint names, never a summary of one.
//
// A report is a claim about a moment. It carries the Intent version and the evidence it
// was made from, and the journal is append-only, so a resolution is a new line rather
// than an edit — the account of what Collie thought and when survives being wrong.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import type { PlatformServices } from "./platform";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import type { Constraint, Intent, RuleSpec } from "./intent";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import { isRecord, isString } from "./schema";
import { nowIso } from "./time";
import {
  DriftReportSchema,
  evaluate,
  flagsPresent,
  type DriftReport,
  type EvaluatorDeps,
  type Ref,
} from "./evaluator";
import { insideKnown } from "./conversation";
import { reserve, settle as settleBudget, type CallLimits } from "./steering";

/** How much of a diff a judgement is allowed to see. Enough to judge, not a transcript. */
export const MAX_LINES_PER_FILE = 200;
export const MAX_FILES = 20;

/** Files whose *contents* are never quoted, however relevant they look. */
const SECRET_FILES = [/(^|\/)\.env($|\.)/, /\.pem$/, /\.key$/, /token/i, /secret/i, /credential/i];

export function looksSecret(path: string): boolean {
  return Arr.some(SECRET_FILES, (looksLike) => looksLike.test(path));
}

const SkippedSchema = Schema.Struct({
  kind: Schema.Literal("skipped"),
  at: Schema.String,
  run: Schema.String,
  reason: Schema.String,
  /** A rule check's skip, which no judgement answers. */
  check: Schema.optionalKey(Schema.Literal("rule")),
});

export const DriftLineSchema = Schema.Union([SkippedSchema, DriftReportSchema]);
export type DriftLine = Schema.Schema.Type<typeof DriftLineSchema>;
const LineJson = Schema.fromJsonString(DriftLineSchema);

export const driftPath = Effect.fn("Drift.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "steering", "drift.jsonl");
});

export const readDrift = Effect.fn("Drift.read")(function* (runDir: string) {
  return yield* readJournal(yield* driftPath(runDir), LineJson);
});

export const appendDrift = Effect.fn("Drift.append")(function* (runDir: string, line: DriftLine) {
  yield* appendJournal(yield* driftPath(runDir), LineJson, line);
});

/** Only reports, newest state per id: the journal is append-only, so the last line wins. */
export function currentReports(lines: ReadonlyArray<DriftLine>): DriftReport[] {
  const newest = new Map<string, DriftReport>();
  for (const line of lines) if (line.kind !== "skipped") newest.set(line.id, line);
  return [...newest.values()];
}

export function openReports(lines: ReadonlyArray<DriftLine>): DriftReport[] {
  return Arr.filter(
    currentReports(lines),
    (report) => report.resolution === "open" || report.resolution === "correction_submitted",
  );
}

/**
 * What makes two reports the same finding: the constraint, and the evidence it was found
 * in. Re-checking the same diff must not add a second report of the same thing — a human
 * looking at a list of eight identical findings learns nothing they did not learn from
 * the first.
 */
export function findingKey(constraint: string, evidence: ReadonlyArray<Ref>): string {
  return Bun.hash(
    `${constraint}\n${Arr.join(
      Arr.map(evidence, (ref) => `${ref.kind}:${ref.path ?? ""}:${ref.line ?? ""}`),
      "\n",
    )}`,
  ).toString(16);
}

export interface RuleFacts {
  readonly changedFiles: ReadonlyArray<string>;
  readonly branch: string | null;
  readonly mrTarget: { readonly project: string; readonly iid: string | null } | null;
  /**
   * Each step's Output, already flattened to dotted keys and rendered as text by whoever
   * read the file. Parsed at that boundary rather than here: a rule check is a comparison
   * of two strings, and walking an arbitrary JSON tree inside one is how a check comes to
   * depend on the shape of something nobody validated.
   */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The latest verification per name, and how it came out. */
  readonly verifications: Readonly<Record<string, { readonly exit: number; readonly ref: string }>>;
}

/** `src/**` against `src/a/b.ts`, without pulling in a matcher for it. */
export function matchesGlob(glob: string, path: string): boolean {
  const pattern = Arr.join(
    Arr.map(Str.split(glob, "**"), (part) =>
      Arr.join(
        Arr.map(Str.split(part, "*"), (piece) =>
          pipe(piece, Str.replace(/[.+?^${}()|[\]\\]/g, "\\$&")),
        ),
        "[^/]*",
      ),
    ),
    ".*",
  );
  return new RegExp(`^${pattern}$`).test(path);
}

/**
 * An Output's fields as dotted keys against their text, from the JSON as it was written.
 * Parsed here, at the one boundary that reads it, so a rule check downstream is a
 * comparison of two strings — what a human put in a constraint against what a step wrote.
 *
 * Walked with a stack rather than recursion so that nothing unparsed is ever a parameter:
 * the only place a shapeless value exists is inside this function.
 */
export function flattenOutput(json: string) {
  const flat: Record<string, string> = {};
  const decoded = decodeUnknown(json);
  if (decoded._tag === "None") return flat;
  const stack: Array<{ prefix: string; node: unknown }> = [{ prefix: "", node: decoded.value }];
  while (stack.length > 0) {
    const { prefix, node } = stack.pop()!;
    if (isRecord(node)) {
      if (prefix !== "") flat[prefix] = encodeUnknown(node);
      for (const [key, child] of Rec.toEntries(node))
        stack.push({ prefix: prefix === "" ? key : `${prefix}.${key}`, node: child });
      continue;
    }
    if (prefix === "") continue;
    flat[prefix] = isString(node) ? node : encodeUnknown(node);
  }
  return flat;
}

const decodeUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeUnknown = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

function violation(
  constraint: Constraint,
  run: string,
  intentVersion: number,
  at_: string,
  { evidence, truncated }: Breach,
): DriftReport {
  return {
    id: `d-${findingKey(constraint.id, evidence)}`,
    at: at_,
    run,
    intent_version: intentVersion,
    constraint: constraint.id,
    kind: "rule",
    severity: constraint.severity,
    evidence: [...evidence],
    evidence_truncated: truncated,
    resolution: "open",
  };
}

/**
 * Every rule constraint this Intent has, checked against what is actually there. No model
 * is involved: these are facts, and a fact Collie can check itself is one it should never
 * pay to have judged.
 *
 * A `command_exit` whose verification is missing is a violation, not a pass. "Nobody ran
 * it" and "it passed" are different, and only one of them is evidence.
 */
export function checkRules(intent: Intent, facts: RuleFacts, at_: string): DriftReport[] {
  const found: DriftReport[] = [];
  for (const constraint of intent.constraints) {
    if (constraint.kind !== "rule" || constraint.rule === undefined) continue;
    const evidence = breachOf(constraint.rule, facts);
    if (evidence !== null)
      found.push(violation(constraint, intent.run, intent.version, at_, evidence));
  }
  return found;
}

/** What a rule found, and whether the list was cut to `MAX_FILES`. */
interface Breach {
  readonly evidence: ReadonlyArray<Ref>;
  readonly truncated: boolean;
}

const whole = (evidence: ReadonlyArray<Ref> | null): Breach | null =>
  evidence === null ? null : { evidence, truncated: false };

function breachOf(rule: RuleSpec, facts: RuleFacts): Breach | null {
  if (rule.kind !== "protected_paths") return whole(refsOf(rule, facts));
  // Not "these paths may not change": the globs are where change is allowed, and what
  // is reported is every file outside them.
  const outside = Arr.filter(
    facts.changedFiles,
    (file) => !Arr.some(rule.globs, (glob) => matchesGlob(glob, file)),
  );
  return outside.length === 0
    ? null
    : {
        evidence: Arr.map(outside.slice(0, MAX_FILES), (path) => ({ kind: "diff" as const, path })),
        truncated: outside.length > MAX_FILES,
      };
}

function refsOf(
  rule: Exclude<RuleSpec, { kind: "protected_paths" }>,
  facts: RuleFacts,
): Ref[] | null {
  switch (rule.kind) {
    case "branch_is":
      return facts.branch === rule.name
        ? null
        : [{ kind: "git", excerpt: `on ${facts.branch ?? "no branch"}, not ${rule.name}` }];
    case "mr_target": {
      const target = facts.mrTarget;
      if (target === null) return [{ kind: "record", excerpt: "no merge request recorded" }];
      if (target.project !== rule.project)
        return [{ kind: "record", excerpt: `targets ${target.project}, not ${rule.project}` }];
      if (rule.iid !== undefined && target.iid !== rule.iid)
        return [{ kind: "record", excerpt: `is !${target.iid ?? "?"}, not !${rule.iid}` }];
      return null;
    }
    case "output_field": {
      const output = facts.outputs[rule.step];
      if (output === undefined)
        return [{ kind: "output", path: rule.step, excerpt: "no Output recorded" }];
      const value = output[rule.path] ?? "";
      const holds = rule.op === "eq" ? value === rule.value : value !== rule.value;
      return holds
        ? null
        : [
            {
              kind: "output",
              path: `${rule.step}.${rule.path}`,
              excerpt: `is ${JSON.stringify(value)}`,
            },
          ];
    }
    case "command_exit": {
      const verification = facts.verifications[rule.name];
      // Nobody ran it is not the same as it passed, and only one of those is evidence.
      if (verification === undefined)
        return [{ kind: "verification", path: rule.name, excerpt: "no verification of that name" }];
      return verification.exit === rule.expect
        ? null
        : [
            {
              kind: "verification",
              path: rule.name,
              sha: verification.ref,
              excerpt: `exited ${verification.exit}, wanted ${rule.expect}`,
            },
          ];
    }
  }
}

/** The log line a drift report found at `where` leaves, saying when its evidence was cut. */
export const driftSaid = (report: DriftReport, where: string) =>
  `drift at ${where}: ${report.constraint} (${report.severity}) — ${Arr.join(
    Arr.map(report.evidence, (ref) => ref.path ?? ref.excerpt ?? ref.kind),
    ", ",
  )}${report.evidence_truncated ? " (evidence truncated)" : ""}`;

export interface EvidenceBlock {
  readonly path: string;
  readonly diff: string;
  readonly truncated: boolean;
}

export class TreeUnread extends Data.TaggedError("TreeUnread")<{ reason: string }> {}

/** What git printed, or why it could not say: a failing `git diff` is not an unchanged tree. */
export const gitOutput = Effect.fn("Drift.gitOutput")(function* (args: string[], cwd: string) {
  const ran = yield* shell("git", args, cwd);
  if (ran.code === 0) return ran.stdout;
  return yield* new TreeUnread({
    reason: `git ${Arr.join(args, " ")} exited ${ran.code}: ${Str.split(Str.trim(ran.stderr ?? ""), "\n")[0]}`,
  });
});

/**
 * Whether `worktree` is in an unfinished merge, such as an Integration left conflicted.
 * Its working tree against `MERGE_HEAD` is then the Run's side of it alone.
 */
export const merging = Effect.fn("Drift.merging")(function* (worktree: string) {
  return (yield* shell("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree)).code === 0;
});

/** Whether `dir` is in no git checkout at all, which is a Run with no diff to read. */
const outsideGit = (dir: string) =>
  shell("git", ["rev-parse", "--git-dir"], dir).pipe(
    Effect.map(
      (ran) => ran.code !== 0 && pipe(ran.stderr ?? "", Str.includes("not a git repository")),
    ),
  );

/**
 * The actual diff a judgement is made from, capped and redacted. Actual, because a
 * summary of a change is a second thing to be wrong about; capped, because a judgement
 * given the whole of a large change is a judgement about whatever fitted; redacted by
 * *filename*, because a file called `.env` has nothing in it worth quoting to a model.
 */
export const evidenceFor = Effect.fn("Drift.evidenceFor")(function* (
  worktree: string,
  paths: ReadonlyArray<string>,
  base: string,
) {
  const scope = paths.length === 0 ? [] : ["--", ...paths];
  const diff = (yield* merging(worktree))
    ? yield* gitOutput(["diff", "MERGE_HEAD", "--unified=3", ...scope], worktree)
    : Arr.join(
        [
          yield* gitOutput(["diff", `${base}..HEAD`, "--unified=3", ...scope], worktree),
          yield* gitOutput(["diff", "HEAD", "--unified=3", ...scope], worktree),
        ],
        "\n",
      );
  const blocks = splitDiff(diff);
  return {
    blocks: blocks.slice(0, MAX_FILES),
    truncated: blocks.length > MAX_FILES || Arr.some(blocks, (block) => block.truncated),
  };
});

/** One unified diff, per file, each cut to the cap and each secret file named only. */
export function splitDiff(diff: string): EvidenceBlock[] {
  const blocks: EvidenceBlock[] = [];
  let path: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (path === null) return;
    if (looksSecret(path)) blocks.push({ path, diff: "<redacted>", truncated: false });
    else
      blocks.push({
        path,
        diff: Arr.join(lines.slice(0, MAX_LINES_PER_FILE), "\n"),
        truncated: lines.length > MAX_LINES_PER_FILE,
      });
    lines = [];
  };
  for (const line of Str.split(diff, "\n")) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) {
      flush();
      path = header[2] ?? header[1] ?? null;
      continue;
    }
    if (path !== null) lines.push(line);
  }
  flush();
  return blocks;
}

/** One Output a judgement is shown, by the operation that wrote it. */
export interface ShownOutput {
  readonly operation: string;
  readonly text: string;
}

const NOT_OUTPUTS = [".launch.json", ".mcp.json", ".settings.json"];

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const printJson = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown, { space: 2 })),
  Result.getOrThrow,
);

/** Each Output in `agentsDir`, printed with a two-space indent, by operation; one named like a credential is not quoted. */
export const outputsIn = Effect.fn("Drift.outputsIn")(function* (agentsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const names = Arr.filter(
    yield* fs.readDirectory(agentsDir).pipe(Effect.orElseSucceed(() => [])),
    (name) =>
      pipe(name, Str.endsWith(".json")) &&
      !Arr.some(NOT_OUTPUTS, (not) => pipe(name, Str.endsWith(not))),
  ).sort();
  const outputs: Array<ShownOutput & { readonly truncated: boolean }> = [];
  for (const name of names.slice(0, MAX_FILES)) {
    const operation = pipe(name, Str.slice(0, -".json".length));
    if (looksSecret(name)) {
      outputs.push({ operation, text: "<redacted>", truncated: false });
      continue;
    }
    const raw = yield* fs
      .readFileString(`${agentsDir}/${name}`)
      .pipe(Effect.orElseSucceed(() => ""));
    const decoded = decodeJson(raw);
    const printed = decoded._tag === "None" ? raw : printJson(decoded.value);
    const lines = Str.split(printed, "\n");
    outputs.push({
      operation,
      text: Arr.join(lines.slice(0, MAX_LINES_PER_FILE), "\n"),
      truncated: lines.length > MAX_LINES_PER_FILE,
    });
  }
  return {
    outputs: Arr.map(outputs, ({ operation, text }) => ({ operation, text })),
    truncated: names.length > MAX_FILES || Arr.some(outputs, (one) => one.truncated),
  };
});

/**
 * The reports this check found that are not already open. Deduped by finding rather than
 * by id alone: the same constraint breached in the same place is the same finding however
 * many times it is looked at. One found again at a newer Intent version is the open
 * report moved to it, so a correction can still follow it.
 */
export function newReports(
  found: ReadonlyArray<DriftReport>,
  existing: ReadonlyArray<DriftLine>,
): DriftReport[] {
  const known = new Map(
    Arr.map(openReports(existing), (report) => [
      findingKey(report.constraint, report.evidence),
      report,
    ]),
  );
  const fresh: DriftReport[] = [];
  for (const report of found) {
    const key = findingKey(report.constraint, report.evidence);
    const open = known.get(key);
    if (open !== undefined && open.intent_version >= report.intent_version) continue;
    const next = open === undefined ? report : movedTo(open, report);
    known.set(key, next);
    fresh.push(next);
  }
  return fresh;
}

/** What was found again, under the id and correction state of the report on file. */
function movedTo(open: DriftReport, found: DriftReport): DriftReport {
  const moved = { ...found, id: open.id, resolution: open.resolution };
  return open.correction === undefined ? moved : { ...moved, correction: open.correction };
}

/** Files one report unless the finding is already open at its version; true if it filed. */
export const fileReport = Effect.fn("Drift.fileReport")(function* (
  runDir: string,
  report: DriftReport,
) {
  const before = yield* readDrift(runDir).pipe(Effect.orElseSucceed(() => []));
  const [next] = newReports([report], before);
  if (next === undefined) return false;
  yield* appendDrift(runDir, next).pipe(Effect.ignore);
  return true;
});

/** A judgement nobody could make, recorded so a card can say why it says nothing. */
export const recordSkipped = Effect.fn("Drift.recordSkipped")(function* (
  runDir: string,
  run: string,
  reason: string,
  check?: "rule",
) {
  yield* appendDrift(runDir, {
    kind: "skipped",
    at: yield* nowIso,
    run,
    reason,
    ...(check && { check }),
  });
});

// ---------------------------------------------------------------------------
// Judging what Collie cannot check by itself
// ---------------------------------------------------------------------------

/** How far a judgement got. Every field is a reason `alignment` may not say `true`. */
export interface Judged {
  /** Every semantic constraint was put to a Judgement that answered. */
  readonly semantic: boolean;
  /** The evidence it saw was cut to the cap, so it judged whatever fitted. */
  readonly truncated: boolean;
  /** When a judgement last answered; it answers every skip before it. */
  readonly at?: string;
}

/** Nothing was judged. The honest default, and what every refusal answers with. */
export const NOT_JUDGED: Judged = { semantic: false, truncated: false };

/** How far a judgement got, and what it found. */
export interface Judgement {
  readonly judged: Judged;
  readonly reports: ReadonlyArray<DriftReport>;
}

/** No judgement was made, so nothing was found and nothing may be claimed. */
const NOTHING: Judgement = { judged: NOT_JUDGED, reports: [] };

/** What a Judgement is made with, and where its call is written down. */
export interface JudgementDeps {
  readonly evaluator: EvaluatorDeps;
  readonly budgetFile: string;
  readonly limits: CallLimits;
  readonly newId: Effect.Effect<string, never, PlatformServices>;
  readonly log: (line: string) => Effect.Effect<void, never, PlatformServices>;
}

/** Which files a judgement is about: what the semantic constraints name, else everything. */
export function judgementPaths(intent: Intent): string[] {
  const named = pipe(
    intent.constraints,
    Arr.filter((constraint) => constraint.kind === "semantic"),
    Arr.flatMap((constraint) => [...(constraint.paths ?? [])]),
  );
  return [...new Set(named)];
}

/** What both judgements are told about a plan's constraints and the goal they were cut from. */
export const PLAN_NARROWS_GOAL = [
  "A constraint read from the plan narrows the goal it was cut from: the goal is what was asked, not work done, and it is never evidence of drift.",
  "A report must cite the work it was shown.",
];

/**
 * What the model is asked. The Intent's own words and the actual diff, and nothing else:
 * no pane text, no agent transcript, no narrative anybody wrote about the work.
 *
 * The evidence is data, and the prompt says so. A diff can contain anything — including a
 * line telling a model to ignore its instructions — so it goes in last, fenced, and named
 * as the thing being judged rather than as anything to obey.
 */
export function judgementPack(
  intent: Intent,
  evidence: {
    readonly blocks: ReadonlyArray<EvidenceBlock>;
    readonly outputs: ReadonlyArray<ShownOutput>;
    readonly truncated: boolean;
  },
): string {
  const semantic = Arr.filter(intent.constraints, (constraint) => constraint.kind === "semantic");
  return Arr.join(
    Arr.filter(
      [
        `run: ${intent.run}`,
        `intent_version: ${intent.version}`,
        `goal: ${intent.goal ?? "(none stated)"}`,
        "",
        ...PLAN_NARROWS_GOAL,
        "",
        "constraints to judge:",
        ...Arr.map(
          semantic,
          (constraint) => `- ${constraint.id} (${constraint.severity}): ${constraint.text}`,
        ),
        "",
        evidence.truncated
          ? "evidence (TRUNCATED to the cap; judge only what is here):"
          : "evidence (the whole change):",
        ...Arr.map(evidence.blocks, (block) => `--- ${block.path}\n${block.diff}`),
        ...Arr.map(evidence.outputs, (output) => `--- output ${output.operation}\n${output.text}`),
        evidence.blocks.length === 0 && evidence.outputs.length === 0
          ? "(nothing has changed yet)"
          : "",
      ],
      (line) => line !== "",
    ),
    "\n",
  );
}

/** The work a pack showed: the files whose diff it quoted, and the Outputs by operation. */
export interface ShownWork {
  readonly files: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
}

/**
 * The reference as it cites work the pack showed, or null where it cites none. A file
 * may be named under `worktree`, and is kept as the pack named it.
 */
export const citedIn =
  (shown: ShownWork, worktree: string) =>
  (ref: Ref): Ref | null => {
    if (ref.path === undefined) return null;
    if (ref.kind === "output") return shown.outputs.includes(ref.path) ? ref : null;
    if (ref.kind !== "diff") return null;
    const file = pipe(ref.path, Str.startsWith(`${worktree}/`))
      ? pipe(ref.path, Str.slice(worktree.length + 1))
      : ref.path;
    return shown.files.includes(file) ? { ...ref, path: file } : null;
  };

/**
 * One report as Collie will keep it, whatever the model returned. The model says which
 * constraint and how bad; it does not say which Run, which Intent version, when, or
 * whether the thing is still open — those are facts about the journal it is going into,
 * and a model that set them could file a report against a Run it was never shown.
 *
 * A ref pointing outside the Run is dropped rather than rewritten: an unresolvable
 * reference in a report a human is asked to act on is worse than one fewer reference.
 */
export function judgedReport(
  report: DriftReport,
  intent: Pick<Intent, "run" | "version">,
  at_: string,
  roots: ReadonlyArray<string>,
  truncated: boolean,
  cited: (ref: Ref) => Ref | null = () => null,
): DriftReport {
  const evidence = Arr.flatMap(report.evidence, (ref) => {
    const work = cited(ref);
    if (work !== null) return [work];
    return ref.path === undefined || insideKnown(ref.path, roots) ? [ref] : [];
  });
  return {
    id: `d-${findingKey(report.constraint, evidence)}`,
    at: at_,
    run: intent.run,
    intent_version: intent.version,
    constraint: report.constraint,
    kind: "semantic",
    severity: report.severity,
    evidence,
    evidence_truncated: truncated,
    resolution: "open",
  };
}

/** A Judgement that was made, or the reason there is none to read. */
export interface Asked {
  readonly refused: string | null;
  readonly reports: ReadonlyArray<DriftReport>;
}

const notAsked = (refused: string): Asked => ({ refused, reports: [] });

/**
 * One paid Judgement: the evaluator's flags, a reservation, the call, and the settlement
 * whatever the call did. The caller decides what a refusal is — a `skipped` line in a
 * Run's journal, or an answer to a Herd's election.
 */
export const askJudgement = Effect.fn("Drift.askJudgement")(function* (
  deps: JudgementDeps,
  run: string,
  pack: string,
) {
  const checked = yield* flagsPresent(deps.evaluator).pipe(Effect.result);
  if (checked._tag === "Failure")
    return notAsked(`the evaluator is unavailable: ${checked.failure.reason}`);
  const missing = checked.success;
  if (missing.length > 0) return notAsked(`the evaluator is missing ${Arr.join(missing, ", ")}`);

  // Written down before and after, as usage: what was asked, how long it took and what
  // it cost. Nothing here refuses a call over a count.
  const callId = yield* deps.newId;
  yield* reserve(deps.budgetFile, { id: callId, run }, deps.limits);
  const asked = yield* evaluate(deps.evaluator, "judgement", pack);
  yield* settleBudget(deps.budgetFile, callId, {
    outcome: asked.spent.outcome === "ok" && asked.error !== null ? "failed" : asked.spent.outcome,
    usd: asked.spent.usd,
    seconds: asked.spent.seconds,
    bytes: asked.spent.bytes,
  });
  const answer = asked.value;
  return answer === null || !("reports" in answer)
    ? notAsked(`the judgement did not answer: ${asked.error ?? "no reports"}`)
    : ({ refused: null, reports: answer.reports } satisfies Asked);
});

/**
 * The semantic half of a drift check: one Judgement against bounded actual evidence
 * (SPEC §7.9). Returns how far it got and what it found; appending is the caller's,
 * because the Driver is the only writer of its own drift journal.
 *
 * Every way this cannot happen is recorded rather than silently passing. A Run whose
 * judgement was skipped is `unverified`, never `aligned: true` — "nobody checked" and
 * "it is fine" are different answers and only one of them is evidence.
 */
export const judge = Effect.fn("Drift.judge")(function* (
  deps: JudgementDeps,
  intent: Intent,
  what: {
    readonly runDir: string;
    readonly worktree: string;
    /** Where the Run's Outputs are, which are judged beside its diff. */
    readonly agentsDir?: string;
    /** The revision the change is measured from, as `git diff <base>..HEAD`. */
    readonly base: string;
    readonly at: string;
    /** The work boundary this is judged at; absent at the finish. */
    readonly boundary?: string;
  },
) {
  const semantic = Arr.filter(intent.constraints, (constraint) => constraint.kind === "semantic");
  // Only a semantic constraint can be reported against, so without one a call buys nothing.
  if (semantic.length === 0) return NOTHING;

  const read = yield* evidenceFor(what.worktree, judgementPaths(intent), what.base).pipe(
    Effect.result,
  );
  const unread =
    read._tag === "Failure" ? `the diff could not be read: ${read.failure.reason}` : null;
  // No checkout is an empty diff; any other git failure is never judged on nothing.
  if (unread !== null && !(yield* outsideGit(what.worktree))) {
    yield* recordSkipped(what.runDir, intent.run, unread);
    return NOTHING;
  }
  const diff = read._tag === "Success" ? read.success : { blocks: [], truncated: false };
  const shown =
    what.agentsDir === undefined
      ? { outputs: [], truncated: false }
      : yield* outputsIn(what.agentsDir);
  const evidence = {
    blocks: diff.blocks,
    outputs: shown.outputs,
    truncated: diff.truncated || shown.truncated,
  };
  // A report must cite work it was shown, so with none the call could find nothing.
  if (evidence.blocks.length === 0 && evidence.outputs.length === 0) {
    yield* recordSkipped(what.runDir, intent.run, unread ?? "no change to judge");
    return NOTHING;
  }
  if (evidence.truncated && what.boundary !== undefined) {
    yield* deps.log(`not judged at ${what.boundary}: evidence past the cap; judged at the finish`);
    return NOTHING;
  }

  const asked = yield* askJudgement(deps, intent.run, judgementPack(intent, evidence));
  if (asked.refused !== null) {
    yield* recordSkipped(what.runDir, intent.run, asked.refused);
    return NOTHING;
  }

  // Only the constraints this Intent actually has, and only a report citing the change it
  // was shown: one about something nobody asked for is a model inventing a rule.
  const known = new Set(Arr.map(semantic, (constraint) => constraint.id));
  const cited = citedIn(
    {
      files: Arr.map(evidence.blocks, (block) => block.path),
      outputs: Arr.map(evidence.outputs, (output) => output.operation),
    },
    what.worktree,
  );
  const reports = Arr.map(
    Arr.filter(
      asked.reports,
      (report) =>
        known.has(report.constraint) && Arr.some(report.evidence, (ref) => cited(ref) !== null),
    ),
    (report) =>
      judgedReport(
        report,
        intent,
        what.at,
        [what.runDir, what.worktree],
        evidence.truncated,
        cited,
      ),
  );
  yield* deps.log(
    `judged ${semantic.length} semantic constraint(s) at ${what.at}: ${reports.length} report(s)${
      evidence.truncated ? ", on truncated evidence" : ""
    }`,
  );
  return {
    judged: { semantic: true, truncated: evidence.truncated },
    reports,
  };
});

// ---------------------------------------------------------------------------
// Correcting what was found
// ---------------------------------------------------------------------------

export interface CorrectionContext {
  /** Whether the agent this would go to has been typed into by a human. */
  readonly overridden: boolean;
  /** Whether the harness can tell Collie's own submissions from a human's. */
  readonly attributable: boolean;
  readonly held: boolean;
  /** How many corrections have already gone out for each constraint. */
  readonly sent: Readonly<Record<string, number>>;
  /** Constraints with a delivery in flight or unaccounted for. */
  readonly inFlight: ReadonlySet<string>;
  /** Whether this harness has been shown to take a `now` delivery. */
  readonly nowProven: boolean;
}

export interface Correction {
  readonly report: DriftReport;
  readonly mode: "boundary" | "now";
}

/**
 * Which open reports Collie may correct by itself, and how. Every gate here is a way of
 * not fighting somebody: the human who typed into that pane, the human who held the Run,
 * the human who turned `auto_correct` off, and the previous
 * correction that may or may not have arrived.
 *
 * Pure, and every gate independent, so the matrix is a test rather than a reading.
 */
export function decideCorrections(
  intent: Intent,
  open: ReadonlyArray<DriftReport>,
  ctx: CorrectionContext,
): Correction[] {
  const authority = intent.authority;
  if (!authority.auto_correct) return [];
  if (ctx.held) return [];
  // Somebody is at that keyboard. Collie does not take turns with a human.
  if (ctx.overridden) return [];
  // On a harness where an external submission is invisible, Collie cannot know whether
  // it is taking turns with a human — so correcting needs the human to have said that
  // nobody else is steering this Run.
  if (!ctx.attributable && !authority.exclusive_steering) return [];

  const corrections: Correction[] = [];
  for (const report of open) {
    if (report.intent_version !== intent.version) continue;
    if (ctx.inFlight.has(report.constraint)) continue;
    if ((ctx.sent[report.constraint] ?? 0) >= authority.max_corrections_per_constraint) continue;
    const urgent = report.severity === "block" && authority.now_allowed && ctx.nowProven;
    corrections.push({ report, mode: urgent ? "now" : "boundary" });
  }
  return corrections;
}

/**
 * What a correction says. A fixed template, not a model's words: this text is sent
 * without a human reading it first, so what it can say has to be what the Run's
 * authority allows, on by default and revocable.
 *
 * The last sentence is the important one. An agent told to obey a constraint that
 * conflicts with the goal will pick one, silently; told to say so instead, it hands the
 * conflict back to the person who can settle it.
 */
export function correctionText(
  deliveryId: string,
  constraint: Constraint,
  report: DriftReport,
): string {
  const evidence = Arr.join(
    Arr.map(
      report.evidence,
      (ref) =>
        `${ref.path ?? ref.kind}${ref.line === undefined ? "" : `:${ref.line}`}${ref.excerpt === undefined ? "" : ` (${ref.excerpt})`}`,
    ),
    "; ",
  );
  return Arr.join(
    [
      `Steering correction ${deliveryId} for constraint ${constraint.id}: ${constraint.text}.`,
      `Evidence: ${evidence || "none recorded"}.`,
      "Bring the work back within this constraint; if that conflicts with the goal, say so",
      "in your Output instead of choosing.",
    ],
    " ",
  );
}

/** How many corrections have gone out per constraint, from the ledger's own account. */
export function correctionsSent(
  deliveries: ReadonlyArray<{ readonly cause: { readonly kind: string; readonly ref: string } }>,
) {
  const counted: Record<string, number> = {};
  for (const delivery of deliveries)
    if (delivery.cause.kind === "correction")
      counted[delivery.cause.ref] = (counted[delivery.cause.ref] ?? 0) + 1;
  return counted;
}

/**
 * Whether this Run's work is what was asked for, at the revision it ended on.
 *
 * `true` is the strong claim and is made only when everything was actually checked:
 * every rule passing, every semantic constraint judged against evidence that was not
 * truncated, and no open report; with no constraint nothing was checked, so never `true`.
 * `false` is the other strong claim — something is open and blocking. Everything else is
 * `unverified`, which is not a hedge: it is the accurate answer when nobody looked, or
 * looked at only part.
 */
export interface Alignment {
  readonly aligned: "true" | "false" | "unverified";
  readonly why: string;
}

/** Why a judgement was skipped, once per reason, leaving out what a later judgement answered. */
export function standingSkips(
  lines: ReadonlyArray<DriftLine>,
  judged: Pick<Judged, "at">,
): string[] {
  const answered = (line: Schema.Schema.Type<typeof SkippedSchema>) =>
    line.check === undefined && judged.at !== undefined && line.at < judged.at;
  const reasons = Arr.flatMap(lines, (line) =>
    line.kind === "skipped" && !answered(line) ? [line.reason] : [],
  );
  return [...new Set(reasons)];
}

export function alignment(
  intent: Intent | null,
  lines: ReadonlyArray<DriftLine>,
  judged: Judged,
): Alignment {
  if (intent === null) return { aligned: "unverified", why: "the Run has no Intent to compare to" };
  if (intent.constraints.length === 0) return { aligned: "unverified", why: "nothing was judged" };
  const open = openReports(lines);
  if (Arr.some(open, (report) => report.severity === "block"))
    return { aligned: "false", why: `${open.length} open report(s), at least one blocking` };
  const skippedReasons = standingSkips(lines, judged);
  if (skippedReasons.length > 0)
    return {
      aligned: "unverified",
      why: `a judgement was skipped: ${skippedReasons.at(-1) ?? ""}`,
    };
  const hasSemantic = Arr.some(intent.constraints, (c) => c.kind === "semantic");
  if (hasSemantic && !judged.semantic)
    return { aligned: "unverified", why: "the semantic constraints were never judged" };
  if (judged.truncated)
    return { aligned: "unverified", why: "the evidence a judgement saw was truncated" };
  if (open.length > 0) return { aligned: "unverified", why: `${open.length} open warning(s)` };
  return { aligned: "true", why: "every constraint was checked and none is open" };
}

// ---------------------------------------------------------------------------
// Cross-run evaluation, by election
// ---------------------------------------------------------------------------

/**
 * Open reports the Intent has moved past: an older version, or a constraint since removed
 * (SPEC §9.4). Left open, one keeps a finished Run `aligned: false` about something nobody
 * asks for, and its correction argues for the old text.
 */
export function supersededBy(reports: ReadonlyArray<DriftReport>, intent: Intent): DriftReport[] {
  const live = new Set(Arr.map(intent.constraints, (constraint) => constraint.id));
  return Arr.filter(
    reports,
    (report) => report.intent_version < intent.version || !live.has(report.constraint),
  );
}

/**
 * A judgement about how sibling Runs relate needs one caller, not one per Driver — and
 * Collie has no daemon to be that caller. So the Drivers elect one: whichever of them
 * takes the Herd's evaluator lock does the check, and the rest write down that they were
 * there and get on with their own work.
 *
 * A loser's `dirty` line is what stops the winner's answer going stale silently: the
 * winner re-reads after its call, and a `dirty` newer than the snapshot it judged means
 * something happened while it was thinking.
 */
const ElectionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["candidate", "dirty"]),
    at: Schema.String,
    by: Schema.String,
    run: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    since: Schema.String,
    runs: Schema.Array(Schema.String),
  }),
  /** A Judgement that was actually made, and the Runs it was about. */
  Schema.Struct({
    kind: Schema.Literal("evaluated"),
    at: Schema.String,
    by: Schema.String,
    runs: Schema.Array(Schema.String),
  }),
]);
export type ElectionLine = Schema.Schema.Type<typeof ElectionSchema>;
/** An evaluation the Herd owes and nobody has made: durable, and read by name. */
export type PendingEvaluation = Extract<ElectionLine, { kind: "pending" }>;
const ElectionJson = Schema.fromJsonString(ElectionSchema);

export const electionsPath = Effect.fn("Drift.electionsPath")(function* (
  stateDir: string,
  herdKey: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, "herd", herdKey, "elections.jsonl");
});

export const readElections = (file: string) => readJournal(file, ElectionJson);

export const appendElection = (file: string, line: ElectionLine) =>
  appendJournal(file, ElectionJson, line);

/**
 * Whether this Driver should stand. Siblings are the ordinary reason; a `pending` line is
 * the other one, and it applies to **every** Driver in the Herd — that is the wake rule.
 * Without it, an evaluation nobody could finish would wait for a Driver that has a
 * parent, which may never run again.
 */
export function shouldStand(lines: ReadonlyArray<ElectionLine>, hasSiblings: boolean): boolean {
  if (hasSiblings) return true;
  return pendingEvaluation(lines) !== null;
}

/**
 * Whether this Run has already said it is standing under the pending evaluation that is
 * open now. Nothing when none is open: an ordinary election is a fresh event each time,
 * and every candidate for it is worth writing down.
 */
export function alreadyStood(lines: ReadonlyArray<ElectionLine>, run: string): boolean {
  const pending = pendingEvaluation(lines);
  if (pending === null) return false;
  return Arr.some(
    lines,
    (line) => line.kind === "candidate" && line.run === run && line.at >= pending.since,
  );
}

/**
 * A `pending` nobody has cleared, and which Runs it is about. Cleared by an `evaluated`
 * line after it that covers every Run it named: the wake rule puts those Runs into the
 * next winner's snapshot, so a Judgement made after the mark is the evaluation it owed.
 * Without this a mark stood for ever, and every Driver in the Herd stood — and paid —
 * at every boundary for a question that had been answered.
 */
export function pendingEvaluation(lines: ReadonlyArray<ElectionLine>): PendingEvaluation | null {
  let latest: PendingEvaluation | null = null;
  for (const line of lines) {
    if (line.kind === "pending") latest = line;
    else if (
      line.kind === "evaluated" &&
      latest !== null &&
      Arr.every(latest.runs, (run) => line.runs.includes(run))
    )
      latest = null;
  }
  return latest;
}

/** Whether something moved in the Herd after this snapshot: a loser's `dirty` newer than it. */
export function staleSince(lines: ReadonlyArray<ElectionLine>, snapshotAt: string): boolean {
  return Arr.some(lines, (line) => line.kind === "dirty" && line.at > snapshotAt);
}

/** How many times a winner re-snapshots and judges again before it writes `pending` (§9.6). */
export const EXTRA_PASSES = 2;

/**
 * Whether the Herd's cross-run question about this Run has been answered since anything
 * last made it stale. `evaluated` on a card means a Judgement was made and this Run was in
 * it; a `dirty` or a `pending` after that one means the answer is behind, so it does not
 * count. Without this a card said `none` — "there was nothing to check" — about a check
 * that had happened.
 */
export function evaluatedFor(lines: ReadonlyArray<ElectionLine>, run: string): boolean {
  let answered = false;
  for (const line of lines) {
    if (line.kind === "evaluated") answered = line.runs.includes(run);
    else if (line.kind === "dirty" || line.kind === "pending") answered = false;
  }
  return answered;
}
