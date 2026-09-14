// Step Outputs are JSON files in the run dir. Gates and loops read these,
// never terminal text (CONTEXT.md, Output).

import { Schema } from "effect";
import { isNumber, isString } from "./schema";
import { staleAgainst, type Snapshot, type Verification } from "./verify";
import { isYamlMap, YamlValueJsonSchema, type YamlValue } from "./yaml";

export const FindingSchema = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  severity: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  /** A reviewer's answer to the implementer's reason for disputing this finding. */
  rebuttal: Schema.optionalKey(Schema.String),
  /** Why a synthesis dropped this finding; only a `dropped` entry carries one. */
  reason: Schema.optionalKey(Schema.String),
});
export interface Finding {
  file?: string;
  line?: number;
  severity: string;
  title: string;
  detail?: string;
  /** A reviewer's answer to the implementer's reason for disputing this finding. */
  rebuttal?: string;
  /** Why a synthesis dropped this finding; only a `dropped` entry carries one. */
  reason?: string;
}

export interface ReviewOutput {
  verdict: "clean" | "findings";
  findings: Finding[];
  disputed: Finding[];
}

/** The one review that comes out of several, and the file a human reads it in. */
export interface Synthesis extends ReviewOutput {
  /** Two sentences: what the change does, and what is wrong with it. */
  summary: string;
  /** What one reviewer raised that this synthesis could not defend from the diff. */
  dropped: Finding[];
  /** What the previous review over this target raised and this one found fixed. */
  fixed: Fixed[];
}

/** A finding the last review raised that is not there any more. */
export interface Fixed {
  file?: string;
  title: string;
  note?: string;
}

/** The human-facing review, written next to run.json. */
export const REVIEW_FILE = "review.md";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseJson(text: string, where: string): Parsed<YamlValue> {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(YamlValueJsonSchema)(text) };
  } catch (cause) {
    return { ok: false, error: `${where}: not valid JSON (${String(cause)})` };
  }
}

function display(value: YamlValue | undefined): string {
  return value === undefined ? "undefined" : Schema.encodeSync(YamlValueJsonSchema)(value);
}

export function parseReviewOutput(text: string, where: string): Parsed<ReviewOutput> {
  const parsed = parseJson(text, where);
  if (!parsed.ok) return parsed;
  if (!isYamlMap(parsed.value)) return { ok: false, error: `${where}: expected a JSON object` };
  const obj = parsed.value;
  if (obj.verdict !== "clean" && obj.verdict !== "findings") {
    return {
      ok: false,
      error: `${where}: verdict must be "clean" or "findings", got ${display(obj.verdict)}`,
    };
  }
  const findings = parseFindings(obj.findings, `${where}: findings`);
  if (!findings.ok) return findings;
  const disputed = parseFindings(obj.disputed, `${where}: disputed`);
  if (!disputed.ok) return disputed;
  if (obj.verdict === "findings" && findings.value.length === 0) {
    return { ok: false, error: `${where}: verdict "findings" with an empty findings list` };
  }
  return {
    ok: true,
    value: { verdict: obj.verdict, findings: findings.value, disputed: disputed.value },
  };
}

export function parseFindings(raw: YamlValue | undefined, where: string): Parsed<Finding[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: `${where}: expected an array` };
  const out: Finding[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isYamlMap(item)) return { ok: false, error: `${where}[${index}]: expected an object` };
    if (!isString(item.title) || item.title.trim() === "") {
      return { ok: false, error: `${where}[${index}]: title is required` };
    }
    if (!isString(item.severity) || item.severity.trim() === "") {
      return { ok: false, error: `${where}[${index}]: severity is required` };
    }
    const finding: Finding = { severity: item.severity, title: item.title };
    if (isString(item.file)) finding.file = item.file;
    if (isNumber(item.line)) finding.line = item.line;
    if (isString(item.detail)) finding.detail = item.detail;
    if (isString(item.rebuttal)) finding.rebuttal = item.rebuttal;
    if (isString(item.reason)) finding.reason = item.reason;
    out.push(finding);
  }
  return { ok: true, value: out };
}

/**
 * What makes two findings the same finding. The line is deliberately left out: it
 * moves as the branch is fixed, and a dispute has to survive that to ever settle.
 */
export function findingKey(f: Pick<Finding, "file" | "title">): string {
  return `${f.file ?? ""}::${f.title.trim().toLowerCase()}`;
}

/**
 * A review of reviews: everything `review.json` has, plus the summary a human reads
 * first and the findings this synthesis decided not to carry.
 */
export function parseSynthesis(text: string, where: string): Parsed<Synthesis> {
  const base = parseReviewOutput(text, where);
  if (!base.ok) return base;
  const parsed = parseJson(text, where);
  if (!parsed.ok || !isYamlMap(parsed.value))
    return { ok: false, error: `${where}: expected a JSON object` };
  const obj = parsed.value;
  if (!isString(obj.summary) || obj.summary.trim() === "") {
    return { ok: false, error: `${where}: summary is required` };
  }
  const dropped = parseFindings(obj.dropped, `${where}: dropped`);
  if (!dropped.ok) return dropped;
  for (const [i, finding] of dropped.value.entries()) {
    // A finding dropped without a reason is a finding lost, not one resolved.
    if (!finding.reason || finding.reason.trim() === "") {
      return { ok: false, error: `${where}: dropped[${i}]: reason is required` };
    }
  }
  const fixed = parseFixed(obj.fixed, `${where}: fixed`);
  if (!fixed.ok) return fixed;
  return {
    ok: true,
    value: {
      ...base.value,
      summary: obj.summary.trim(),
      dropped: dropped.value,
      fixed: fixed.value,
    },
  };
}

/** What the last review raised and this one could not find any more. */
export function parseFixed(value: YamlValue | undefined, where: string): Parsed<Fixed[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${where}: expected a list` };
  const out: Fixed[] = [];
  for (const [i, item] of value.entries()) {
    if (!isYamlMap(item)) return { ok: false, error: `${where}[${i}]: expected an object` };
    if (!isString(item.title) || item.title.trim() === "") {
      return { ok: false, error: `${where}[${i}]: title is required` };
    }
    const entry: Fixed = { title: item.title.trim() };
    if (isString(item.file)) entry.file = item.file;
    if (isString(item.note)) entry.note = item.note;
    out.push(entry);
  }
  return { ok: true, value: out };
}

/**
 * One check the implementer says it ran, by the name it was recorded under. Whether it
 * passed is not here: that is read from the verification journal, bound to the tree it
 * ran on. A `passed` the Output carries is a claim, and is ignored as one.
 */
export interface Check {
  name: string;
  note?: string;
}

/**
 * What a fix step reports under a converging loop: each finding it fixed, keyed like
 * the finding itself, each one it disputed, and the checks it ran. A `fixed` entry is
 * an object here, not a sentence, because the engine has to match it to a finding.
 */
export interface FixOutput {
  verdict: "clean" | "findings";
  /** What the fix itself still reports open: work it did not finish. */
  findings: Finding[];
  fixed: Fixed[];
  disputed: Finding[];
  checks: Check[];
}

export function parseFixOutput(raw: YamlValue, where: string): Parsed<FixOutput> {
  if (!isYamlMap(raw)) return { ok: false, error: `${where}: expected a JSON object` };
  if (raw.verdict !== "clean" && raw.verdict !== "findings") {
    return { ok: false, error: `${where}: verdict must be "clean" or "findings"` };
  }
  const findings = parseFindings(raw.findings, `${where}: findings`);
  if (!findings.ok) return findings;
  if (raw.verdict === "findings" && findings.value.length === 0) {
    return { ok: false, error: `${where}: verdict "findings" with an empty findings list` };
  }
  const fixed = parseFixed(raw.fixed, `${where}: fixed`);
  if (!fixed.ok) return fixed;
  const disputed = parseFindings(raw.disputed, `${where}: disputed`);
  if (!disputed.ok) return disputed;
  const checks = parseChecks(raw.checks, `${where}: checks`);
  if (!checks.ok) return checks;
  return {
    ok: true,
    value: {
      verdict: raw.verdict,
      findings: findings.value,
      fixed: fixed.value,
      disputed: disputed.value,
      checks: checks.value,
    },
  };
}

function parseChecks(value: YamlValue | undefined, where: string): Parsed<Check[]> {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${where}: expected a list` };
  const out: Check[] = [];
  for (const [i, item] of value.entries()) {
    if (!isYamlMap(item)) return { ok: false, error: `${where}[${i}]: expected an object` };
    if (!isString(item.name) || item.name.trim() === "") {
      return { ok: false, error: `${where}[${i}]: name is required` };
    }
    const check: Check = { name: item.name.trim() };
    if (isString(item.note)) check.note = item.note;
    out.push(check);
  }
  return { ok: true, value: out };
}

/**
 * Whether a blocking finding says enough to act on: where it is, and what goes wrong.
 * A `blocker` with no file and no detail is a reviewer's impression, and the implementer
 * it lands on can only guess at it or dispute it — both of which cost a round.
 *
 * Deliberately **not** "the file is in the diff". An unchanged caller this change breaks,
 * and a file that should exist and does not, are exactly the blockers worth having; a
 * changed-file whitelist would throw them away to catch the vaguer ones. What is required
 * is that the reviewer named a place and gave a reason.
 *
 * Minor findings are exempt: they do not drive the loop, and holding a passing remark to
 * the standard of a blocker would cost a repair round for a note nobody has to act on.
 */
export function substantiated(finding: Finding): boolean {
  if (!isBlocking(finding)) return true;
  return (finding.file ?? "").trim() !== "" && (finding.detail ?? "").trim() !== "";
}

/** What to tell a reviewer whose blocking findings cannot be acted on, naming them. */
export function unsubstantiated(findings: ReadonlyArray<Finding>): string | null {
  const bad = findings.filter((f) => !substantiated(f));
  if (bad.length === 0) return null;
  const named = bad.map((f) => `"${f.title}"`).join(", ");
  return (
    `${bad.length} blocking finding(s) say neither where nor why: ${named}. ` +
    `Every blocker and major needs a "file" it is about and a "detail" of one or two ` +
    `sentences. The file need not be one the change touched.`
  );
}

/** Minor is the one severity not worth blocking on; anything unrecognised fails closed. */
export function isBlocking(finding: Finding): boolean {
  return finding.severity !== "minor";
}

/** Why a converging loop stopped for the human; `attention` reports it as `reason`. */
export type Halt =
  | "no_progress"
  | "dispute_unresolved"
  | "fix_unverified"
  | "definition_changed"
  | "evidence_missing";

export type FinalFix =
  | { ok: true; attestation: string; outstanding: Finding[] }
  | { ok: false; halt: Halt; reasons: string[]; outstanding: Finding[] };

/** What the journal holds, and the tree in front of us, for the checks to be read against. */
export interface CheckEvidence {
  readonly verifications: ReadonlyArray<Verification>;
  readonly final: Snapshot;
}

/**
 * Why a named check is not proof on this tree, or null where it is. A record by an agent
 * counts: what binds it is the collector, not who called it.
 */
function checkGap(name: string, evidence: CheckEvidence): string | null {
  const records = evidence.verifications.filter((v) => v.name === name);
  if (records.length === 0)
    return `check "${name}" has no verification record — run it through collie verify`;
  if (records.some((v) => v.result === "pass" && !staleAgainst(v, evidence.final))) return null;
  const last = records[records.length - 1]!;
  if (last.result === "fail") return `check failed: ${name}`;
  if (last.result === "unstable") return `check "${name}" ran on a tree that moved under it`;
  return `check "${name}" last passed on an earlier tree`;
}

/**
 * The last fix of a loop has no review after it, so its own report is what decides:
 * every blocking finding the review raised is fixed by key, nothing is disputed, and
 * every check it names has a passing verification on the tree as it stands. The review
 * before it is history, not evidence that the fixed code still has its findings — and
 * the fix's word is not a review either, which is what the attestation says. Nor is it
 * evidence that the checks passed: the journal is.
 */
export function settleFinalFix(live: Finding[], fix: FixOutput, evidence: CheckEvidence): FinalFix {
  const fixed = new Set(fix.fixed.map(findingKey));
  const disputed = new Set(fix.disputed.map(findingKey));
  const disputes: string[] = [];
  const unverified: string[] = [];
  if (fix.verdict !== "clean") unverified.push(`the fix reports verdict "findings"`);
  if (fix.findings.length > 0) {
    unverified.push(
      `the fix reports ${fix.findings.length} finding(s) of its own: ${fix.findings.map(oneLine).join(", ")}`,
    );
  }
  const seen = new Set<string>();
  for (const entry of [...fix.fixed, ...fix.disputed]) {
    const key = findingKey(entry);
    if (seen.has(key) && !(fixed.has(key) && disputed.has(key))) {
      unverified.push(`duplicate disposition: ${key}`);
    }
    seen.add(key);
  }
  for (const finding of live.filter(isBlocking)) {
    const key = findingKey(finding);
    if (fixed.has(key) && disputed.has(key)) {
      unverified.push(`both fixed and disputed: ${oneLine(finding)}`);
    } else if (fixed.has(key)) {
      continue;
    } else if (disputed.has(key)) {
      disputes.push(`disputed blocking finding: ${oneLine(finding)}`);
    } else {
      unverified.push(`no disposition for ${oneLine(finding)}`);
    }
  }
  // A blocking dispute the review did not raise again is still a dispute: the reviewers
  // were told to leave it to the human, and leaving it out is not the human deciding.
  const raised = new Set(live.map(findingKey));
  const standing = fix.disputed.filter((d) => isBlocking(d) && !raised.has(findingKey(d)));
  for (const d of standing) disputes.push(`disputed blocking finding: ${oneLine(d)}`);
  if (fix.checks.length === 0) unverified.push("no checks reported");
  for (const check of fix.checks) {
    const gap = checkGap(check.name, evidence);
    if (gap !== null) unverified.push(`${gap}${check.note ? ` (${check.note})` : ""}`);
  }
  // A fix that does not hold up verifies nothing: everything the review raised stays open.
  const unresolved = [...live, ...fix.findings, ...standing];
  // A dispute is the human's call only once everything else about the fix holds up.
  if (unverified.length > 0) {
    return {
      ok: false,
      halt: "fix_unverified",
      reasons: [...unverified, ...disputes],
      outstanding: unresolved,
    };
  }
  if (disputes.length > 0) {
    return { ok: false, halt: "dispute_unresolved", reasons: disputes, outstanding: unresolved };
  }
  const outstanding = live.filter((f) => !fixed.has(findingKey(f)));
  const blocking = live.filter(isBlocking).length;
  return {
    ok: true,
    attestation: `last fix: ${blocking} blocking finding(s) reported fixed, ${fix.checks.length} check(s) verified on this tree — implementer-reported, not re-reviewed`,
    outstanding,
  };
}

const oneLine = (f: Finding) => `[${f.severity}] ${f.title}${f.file ? ` (${f.file})` : ""}`;

/** Worst first; anything a fork's own vocabulary adds sorts after these, by name. */
const SEVERITIES = ["blocker", "major", "minor"];

function severityOrder(findings: Finding[]): string[] {
  const present = [...new Set(findings.map((f) => f.severity))];
  const known = SEVERITIES.filter((s) => present.includes(s));
  return [...known, ...present.filter((s) => !SEVERITIES.includes(s)).sort()];
}

/**
 * The review a human reads, and the note posted to a merge request. Rendered here
 * rather than asked for, so every review is the same shape: the summary, then the
 * findings under their severity, and nothing about how it was produced.
 */
export function renderReview(synthesis: Synthesis): string {
  const blocks = [synthesis.summary.trim()];
  // Read first: it is what says the rally is converging rather than repeating.
  if (synthesis.fixed.length > 0) {
    blocks.push("**Fixed since last review**");
    blocks.push(
      synthesis.fixed
        .map((f) => {
          const at = f.file ? `\`${f.file}\` — ` : "";
          const note = f.note?.trim() ? `\n  ${f.note.trim().replace(/\s*\n\s*/g, " ")}` : "";
          return `- ${at}${f.title.trim()}${note}`;
        })
        .join("\n"),
    );
  }
  if (synthesis.findings.length === 0) {
    blocks.push("Nothing to fix.");
  } else {
    for (const severity of severityOrder(synthesis.findings)) {
      const group = synthesis.findings.filter((f) => f.severity === severity);
      blocks.push(`**${severity.charAt(0).toUpperCase()}${severity.slice(1)}**`);
      blocks.push(group.map(reviewBullet).join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function reviewBullet(finding: Finding): string {
  const at = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\` — ` : "";
  // The detail is a sentence or two; a continuation line keeps it in the same bullet.
  const detail = finding.detail?.trim()
    ? `\n  ${finding.detail.trim().replace(/\s*\n\s*/g, " ")}`
    : "";
  return `- ${at}${finding.title.trim()}${detail}`;
}

export interface Split {
  /** What the fix step still has to act on. */
  live: Finding[];
  /** Already disputed, raised again with no answer: the human decides, not the loop. */
  settled: Finding[];
  /** Disputes a reviewer answered, so they are back in front of the implementer. */
  rebutted: Finding[];
}

/**
 * A finding the implementer has already rejected with a reason cannot be settled by
 * another round of the same two agents — only by the human. So it stops driving the
 * loop, unless a reviewer answers the reason with a `rebuttal`.
 */
export function splitDisputed(findings: Finding[], disputed: Finding[]): Split {
  const known = new Set(disputed.map(findingKey));
  const split: Split = { live: [], settled: [], rebutted: [] };
  for (const finding of findings) {
    if (!known.has(findingKey(finding))) {
      split.live.push(finding);
    } else if (finding.rebuttal) {
      split.live.push(finding);
      split.rebutted.push(finding);
    } else {
      split.settled.push(finding);
    }
  }
  return split;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "(none)";
  return findings
    .map((f) => {
      const at = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const detail = f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : "";
      const rebuttal = f.rebuttal
        ? `\n  answers your dispute: ${f.rebuttal.replace(/\n/g, "\n  ")}`
        : "";
      return `- [${f.severity}] ${f.title}${at}${detail}${rebuttal}`;
    })
    .join("\n");
}
