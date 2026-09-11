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

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, Path, Schema } from "effect";
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
  return SECRET_FILES.some((looksLike) => looksLike.test(path));
}

const SkippedSchema = Schema.Struct({
  kind: Schema.Literal("skipped"),
  at: Schema.String,
  run: Schema.String,
  reason: Schema.String,
});

const LineSchema = Schema.Union([SkippedSchema, DriftReportSchema]);
export type DriftLine = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);

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
  return currentReports(lines).filter(
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
    `${constraint}\n${evidence.map((ref) => `${ref.kind}:${ref.path ?? ""}:${ref.line ?? ""}`).join("\n")}`,
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
  const pattern = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
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
      for (const [key, child] of Object.entries(node))
        stack.push({ prefix: prefix === "" ? key : `${prefix}.${key}`, node: child });
      continue;
    }
    if (prefix === "") continue;
    flat[prefix] = isString(node) ? node : encodeUnknown(node);
  }
  return flat;
}

const decodeUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function violation(
  constraint: Constraint,
  run: string,
  intentVersion: number,
  at_: string,
  evidence: ReadonlyArray<Ref>,
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
    evidence_truncated: false,
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

function breachOf(rule: RuleSpec, facts: RuleFacts): Ref[] | null {
  switch (rule.kind) {
    // Not "these paths may not change": the globs are where change is allowed, and what
    // is reported is every file outside them.
    case "protected_paths": {
      const outside = facts.changedFiles.filter(
        (file) => !rule.globs.some((glob) => matchesGlob(glob, file)),
      );
      return outside.length === 0
        ? null
        : outside.slice(0, MAX_FILES).map((path) => ({ kind: "diff" as const, path }));
    }
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

export interface EvidenceBlock {
  readonly path: string;
  readonly diff: string;
  readonly truncated: boolean;
}

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
  const committed = yield* shell(
    "git",
    ["diff", `${base}..HEAD`, "--unified=3", ...scope],
    worktree,
  );
  const dirty = yield* shell("git", ["diff", "HEAD", "--unified=3", ...scope], worktree);
  const blocks = splitDiff(`${committed.stdout}\n${dirty.stdout}`);
  return {
    blocks: blocks.slice(0, MAX_FILES),
    truncated: blocks.length > MAX_FILES || blocks.some((block) => block.truncated),
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
        diff: lines.slice(0, MAX_LINES_PER_FILE).join("\n"),
        truncated: lines.length > MAX_LINES_PER_FILE,
      });
    lines = [];
  };
  for (const line of diff.split("\n")) {
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

/**
 * The reports this check found that are not already open. Deduped by finding rather than
 * by id alone: the same constraint breached in the same place is the same finding however
 * many times it is looked at.
 */
export function newReports(
  found: ReadonlyArray<DriftReport>,
  existing: ReadonlyArray<DriftLine>,
): DriftReport[] {
  const known = new Set(
    openReports(existing).map((report) => findingKey(report.constraint, report.evidence)),
  );
  const fresh: DriftReport[] = [];
  for (const report of found) {
    const key = findingKey(report.constraint, report.evidence);
    if (known.has(key)) continue;
    known.add(key);
    fresh.push(report);
  }
  return fresh;
}

/** A judgement nobody could make, recorded so a card can say why it says nothing. */
export const recordSkipped = Effect.fn("Drift.recordSkipped")(function* (
  runDir: string,
  run: string,
  reason: string,
) {
  yield* appendDrift(runDir, { kind: "skipped", at: yield* nowIso(), run, reason });
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
  /** The goal was judged, where there is one. */
  readonly goal: boolean;
}

/** Nothing was judged. The honest default, and what every refusal answers with. */
export const NOT_JUDGED: Judged = { semantic: false, truncated: false, goal: false };

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
  readonly newId: Effect.Effect<string, never, BunServices>;
  readonly log: (line: string) => Effect.Effect<void, never, BunServices>;
}

/** Which files a judgement is about: what the semantic constraints name, else everything. */
export function judgementPaths(intent: Intent): string[] {
  const named = intent.constraints
    .filter((constraint) => constraint.kind === "semantic")
    .flatMap((constraint) => [...(constraint.paths ?? [])]);
  return [...new Set(named)];
}

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
  evidence: { readonly blocks: ReadonlyArray<EvidenceBlock>; readonly truncated: boolean },
): string {
  const semantic = intent.constraints.filter((constraint) => constraint.kind === "semantic");
  return [
    `run: ${intent.run}`,
    `intent_version: ${intent.version}`,
    `goal: ${intent.goal ?? "(none stated)"}`,
    "",
    "constraints to judge:",
    ...semantic.map(
      (constraint) => `- ${constraint.id} (${constraint.severity}): ${constraint.text}`,
    ),
    semantic.length === 0 ? "- (none; judge the goal only)" : "",
    "",
    evidence.truncated
      ? "evidence (TRUNCATED to the cap; judge only what is here):"
      : "evidence (the whole change):",
    ...evidence.blocks.map((block) => `--- ${block.path}\n${block.diff}`),
    evidence.blocks.length === 0 ? "(nothing has changed yet)" : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

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
  intent: Intent,
  at_: string,
  roots: ReadonlyArray<string>,
  truncated: boolean,
): DriftReport {
  const evidence = report.evidence.filter(
    (ref) => ref.path === undefined || insideKnown(ref.path, roots),
  );
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
  const missing = yield* flagsPresent(deps.evaluator);
  if (missing.length > 0) return notAsked(`the evaluator is missing ${missing.join(", ")}`);

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
    /** The revision the change is measured from, as `git diff <base>..HEAD`. */
    readonly base: string;
    readonly at: string;
  },
) {
  const semantic = intent.constraints.filter((constraint) => constraint.kind === "semantic");
  // Nothing to judge is not a judgement that happened: with no semantic constraint and no
  // goal, `alignment` never asks, and paying for a call to hear so would be the only cost.
  if (semantic.length === 0 && intent.goal === null) return NOTHING;

  const evidence = yield* evidenceFor(what.worktree, judgementPaths(intent), what.base).pipe(
    Effect.catch(() => Effect.succeed({ blocks: [], truncated: false })),
  );

  const asked = yield* askJudgement(deps, intent.run, judgementPack(intent, evidence));
  if (asked.refused !== null) {
    yield* recordSkipped(what.runDir, intent.run, asked.refused);
    return NOTHING;
  }

  // Only the constraints this Intent actually has: a report about something nobody asked
  // for is a model inventing a rule, and it is dropped rather than filed.
  const known = new Set(semantic.map((constraint) => constraint.id));
  const reports = asked.reports
    .filter((report) => known.has(report.constraint))
    .map((report) =>
      judgedReport(report, intent, what.at, [what.runDir, what.worktree], evidence.truncated),
    );
  yield* deps.log(
    `judged ${semantic.length} semantic constraint(s) at ${what.at}: ${reports.length} report(s)${
      evidence.truncated ? ", on truncated evidence" : ""
    }`,
  );
  return {
    judged: { semantic: true, truncated: evidence.truncated, goal: intent.goal !== null },
    reports,
  };
});

// ---------------------------------------------------------------------------
// Correcting what was found
// ---------------------------------------------------------------------------

/** The work a correction is about, so two attempts at one constraint are one piece of work. */
export function correctionCause(report: DriftReport) {
  return { kind: "correction" as const, ref: report.constraint };
}

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
 * the human who never granted `auto_correct` in the first place, and the previous
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
 * without a human reading it first, so what it can say has to be something a human
 * already agreed to when they granted `auto_correct`.
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
  const evidence = report.evidence
    .map(
      (ref) =>
        `${ref.path ?? ref.kind}${ref.line === undefined ? "" : `:${ref.line}`}${ref.excerpt === undefined ? "" : ` (${ref.excerpt})`}`,
    )
    .join("; ");
  return [
    `Steering correction ${deliveryId} for constraint ${constraint.id}: ${constraint.text}.`,
    `Evidence: ${evidence || "none recorded"}.`,
    "Bring the work back within this constraint; if that conflicts with the goal, say so",
    "in your Output instead of choosing.",
  ].join(" ");
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
 * truncated, no open report, and the goal judged where there is one. `false` is the other
 * strong claim — something is open and blocking. Everything else is `unverified`, which
 * is not a hedge: it is the accurate answer when nobody looked, or looked at only part.
 */
export interface Alignment {
  readonly aligned: "true" | "false" | "unverified";
  readonly why: string;
}

export function alignment(
  intent: Intent | null,
  lines: ReadonlyArray<DriftLine>,
  judged: { readonly semantic: boolean; readonly truncated: boolean; readonly goal: boolean },
): Alignment {
  if (intent === null) return { aligned: "unverified", why: "the Run has no Intent to compare to" };
  const open = openReports(lines);
  if (open.some((report) => report.severity === "block"))
    return { aligned: "false", why: `${open.length} open report(s), at least one blocking` };
  const skippedReasons = lines.flatMap((line) => (line.kind === "skipped" ? [line.reason] : []));
  if (skippedReasons.length > 0)
    return {
      aligned: "unverified",
      why: `a judgement was skipped: ${skippedReasons.at(-1) ?? ""}`,
    };
  const hasSemantic = intent.constraints.some((c) => c.kind === "semantic");
  if (hasSemantic && !judged.semantic)
    return { aligned: "unverified", why: "the semantic constraints were never judged" };
  if (judged.truncated)
    return { aligned: "unverified", why: "the evidence a judgement saw was truncated" };
  if (intent.goal !== null && !judged.goal)
    return { aligned: "unverified", why: "the goal was never judged" };
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
  const live = new Set(intent.constraints.map((constraint) => constraint.id));
  return reports.filter(
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
  return lines.some(
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
      latest.runs.every((run) => line.runs.includes(run))
    )
      latest = null;
  }
  return latest;
}

/** Whether something moved in the Herd after this snapshot: a loser's `dirty` newer than it. */
export function staleSince(lines: ReadonlyArray<ElectionLine>, snapshotAt: string): boolean {
  return lines.some((line) => line.kind === "dirty" && line.at > snapshotAt);
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
