// Step Outputs are JSON files in the run dir. Gates and loops read these,
// never terminal text (CONTEXT.md, Output).

import { Effect, FileSystem, Schema, SchemaGetter } from "effect";
import { isNumber, isString } from "./schema";
import { staleAgainst, type Snapshot, type Verification } from "./verify";
import { isYamlMap, YamlValueJsonSchema, type YamlValue } from "./yaml";

/** Present and not only whitespace: a required judgement nobody wrote is not one. */
const said = (field: string) =>
  Schema.refine<Schema.String, string>((value): value is string => value.trim() !== "", {
    title: `${field} is required`,
  });

/**
 * A list an Output may leave out; absent and null both read as none, which is what the
 * parsers below have always done and what keeps an old Output readable.
 */
const optionalList = <S extends Schema.Top>(item: S) =>
  Schema.NullOr(Schema.Array(item)).pipe(
    Schema.decodeTo(Schema.Array(item), {
      decode: SchemaGetter.transform((value) => value ?? []),
      encode: SchemaGetter.passthrough(),
    }),
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  );

/** A verdict of `findings` with nothing in the list is a report that says nothing. */
const listed = <
  S extends Schema.Top & {
    readonly Type: { readonly verdict: string; readonly findings: ReadonlyArray<unknown> };
  },
>() =>
  Schema.refine<S, S["Type"]>(
    (value): value is S["Type"] => value.verdict !== "findings" || value.findings.length > 0,
    { title: 'verdict "findings" with an empty findings list' },
  );

/**
 * A finding, as every Output that carries one writes it.
 *
 * `severity` is free text on purpose. `blocker`, `major` and `minor` are the vocabulary
 * this repository's prompts ask for, but a fork's own word is a valid judgement and only
 * `minor` is not blocking, so closing this to a literal union would throw away reviews
 * rather than validate them. The judgement fields beside it are optional for the same
 * reason: a reviewer who has no line number has still said something worth reading.
 */
export const FindingSchema = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
  severity: Schema.String.pipe(said("severity")),
  title: Schema.String.pipe(said("title")),
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

const VerdictSchema = Schema.Literals(["clean", "findings"]);

/**
 * The shapes a workflow's steps write, shared with an author through the SDK so a module
 * declaring a review step declares the same contract the engine reads — one definition,
 * not a copy per workflow. `output-schemas.test.ts` holds each of these to the parser
 * below it, case for case, because two readings of one file is the bug they would
 * otherwise be.
 *
 * None of them is closed against extra keys: an Output may say more than a gate reads.
 */
export const ReviewOutputSchema = Schema.Struct({
  verdict: VerdictSchema,
  findings: optionalList(FindingSchema),
  disputed: optionalList(FindingSchema),
}).pipe(listed());

export const FixedSchema = Schema.Struct({
  file: Schema.optionalKey(Schema.String),
  title: Schema.String.pipe(said("title")),
  note: Schema.optionalKey(Schema.String),
});

/** A finding a synthesis dropped says why, or it is a finding lost rather than resolved. */
const DroppedSchema = FindingSchema.pipe(
  Schema.refine<typeof FindingSchema, typeof FindingSchema.Type>(
    (value): value is typeof FindingSchema.Type => (value.reason ?? "").trim() !== "",
    { title: "reason is required" },
  ),
);

export const SynthesisSchema = Schema.Struct({
  verdict: VerdictSchema,
  summary: Schema.String.pipe(said("summary")),
  findings: optionalList(FindingSchema),
  disputed: optionalList(FindingSchema),
  dropped: optionalList(DroppedSchema),
  fixed: optionalList(FixedSchema),
}).pipe(listed());

export const CheckSchema = Schema.Struct({
  name: Schema.String.pipe(said("name")),
  note: Schema.optionalKey(Schema.String),
});

export const FixOutputSchema = Schema.Struct({
  verdict: VerdictSchema,
  findings: optionalList(FindingSchema),
  fixed: optionalList(FixedSchema),
  disputed: optionalList(FindingSchema),
  checks: optionalList(CheckSchema),
}).pipe(listed());

/**
 * What the step that opens a merge request reports. `pushed: false` is a real answer —
 * auto-merge on someone else's merge request is a reason not to push — so the url is
 * optional rather than the proof.
 */
export const MrOutputSchema = Schema.Struct({
  pushed: Schema.Boolean,
  mr_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  note: Schema.optionalKey(Schema.String),
});

/** What a plan leaves behind: the directory of tickets a later Run is fanned out from. */
export const PlanOutputSchema = Schema.Struct({
  issues_dir: Schema.String.pipe(said("issues_dir")),
  spec: Schema.optionalKey(Schema.String),
});

/** The human-facing review, written next to run.json. */
export const REVIEW_FILE = "review.md";

/**
 * The findings that review left, beside it, as the JSON a reader can count. The prose is
 * for the human and this is for the card: what a Run left open is a fact about it, and a
 * card that had to read `review.md` would be reading a summary for one.
 */
export const FINDINGS_FILE = "findings.json";

const FindingsJson = Schema.fromJsonString(Schema.Array(FindingSchema));
const decodeFindings = Schema.decodeUnknownEffect(FindingsJson);
const encodeFindings = Schema.encodeSync(FindingsJson);

/**
 * What a Run leaves behind about a review: the prose a human reads, and the findings
 * beside it for whatever reads them next. Written together because they are one answer —
 * a review with no findings file is a review nothing can count.
 */
export const leaveReview = (
  dir: string,
  synthesis: Synthesis,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Effect.all([
        fs.writeFileString(`${dir}/${REVIEW_FILE}`, renderReview(synthesis)),
        fs.writeFileString(`${dir}/${FINDINGS_FILE}`, encodeFindings(synthesis.findings)),
      ]),
    ),
    Effect.asVoid,
    Effect.orDie,
  );

/** The extra axes a human asked for, as a paragraph, or nothing where they asked for none. */
export function riskLine(risks: string): string {
  const asked = risks.trim();
  if (asked === "") return "";
  return (
    `Additional axes requested for this change: ${asked}. Apply the matching skill where ` +
    `one is installed (\`security-and-hardening\`, \`performance-optimization\`) and say in ` +
    `your review which of them you applied. These are on top of the complete review, not ` +
    `instead of it.`
  );
}

/**
 * How many findings this Run left for somebody to fix. A finding still open *and* the
 * review that holds it: a Run with findings and no review wrote no review, and one with
 * a review and no findings came back clean.
 */
export const openFindingsIn = (dir: string): Effect.Effect<number, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(`${dir}/${REVIEW_FILE}`))) return 0;
    const found = yield* decodeFindings(yield* fs.readFileString(`${dir}/${FINDINGS_FILE}`));
    return found.length;
  }).pipe(Effect.orElseSucceed(() => 0));

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

/**
 * What the blocking findings of one round come to, as the key a later round compares
 * against. A finding a reviewer answered a dispute on is the argument moving rather than
 * standing, so it is not part of what "the same set again" means.
 */
export function blockingKeys(findings: ReadonlyArray<Finding>): string[] {
  return [...new Set(findings.filter((f) => isBlocking(f) && !f.rebuttal).map(findingKey))].sort();
}

/** Where a review/fix rally goes after one review, and what it is carrying there. */
export type Rally =
  /** Nothing blocking is left; `remaining` is what was raised and is not worth a round. */
  | { readonly go: "clean"; readonly remaining: Finding[] }
  /** Another fix, on `live`, of which `blocking` drives it; `keys` is this round's set. */
  | {
      readonly go: "fix";
      readonly live: Finding[];
      readonly blocking: Finding[];
      readonly keys: ReadonlyArray<string>;
    }
  /** The rally is the human's now, and why. */
  | {
      readonly go: "halt";
      readonly halt: Halt;
      readonly reason: string;
      readonly outstanding: Finding[];
    };

/**
 * Where one round of a converging review/fix rally goes next — the decision the engine
 * makes for a declared loop, as a function a module makes for a written one.
 *
 * `live` is what `splitDisputed` left for the implementer. Only blocking findings drive
 * it: a dispute nobody answered is the human's call rather than another round of the same
 * two agents, and the same blocking set twice running is not progress, because a third
 * attempt would raise it a third time.
 */
export function settleRound(round: {
  /** What the review left for the implementer, as `splitDisputed` returns it. */
  readonly live: ReadonlyArray<Finding>;
  /** What the implementer has disputed so far, carried between rounds. */
  readonly disputed: ReadonlyArray<Finding>;
  /** Disputes put back in front of the implementer; these drive the loop whatever their
   *  severity, because a human resumed the Run to have them acted on. */
  readonly reopened?: ReadonlyArray<Finding>;
  /** Which round this is, counting from one. */
  readonly at: number;
  /** The blocking set of an earlier round, and which round that was. */
  readonly seen?: { readonly at: number; readonly keys: ReadonlyArray<string> } | null;
}): Rally {
  const live = [...round.live];
  const reopened = [...(round.reopened ?? [])];
  const blocking = [...live.filter(isBlocking), ...reopened];
  if (blocking.length === 0) {
    // A dispute the reviewers did not answer settles nothing serious, whether they
    // raised it again or left it out.
    const standing = round.disputed.filter(isBlocking);
    if (standing.length > 0) {
      return {
        go: "halt",
        halt: "dispute_unresolved",
        reason: `${standing.length} disputed blocking finding(s) stand unanswered — your call, not the loop's`,
        outstanding: [...standing, ...live],
      };
    }
    return { go: "clean", remaining: live };
  }
  const keys = blockingKeys(live);
  const seen = round.seen;
  if (
    seen &&
    seen.at < round.at &&
    keys.length > 0 &&
    keys.length === seen.keys.length &&
    keys.every((key, at) => key === seen.keys[at])
  ) {
    return {
      go: "halt",
      halt: "no_progress",
      reason: `no progress: review ${round.at} raised the same ${keys.length} blocking finding(s) as review ${seen.at}`,
      outstanding: live,
    };
  }
  return { go: "fix", live: [...live, ...reopened], blocking, keys };
}

export type FinalFix =
  | { ok: true; attestation: string; outstanding: Finding[] }
  | { ok: false; halt: Halt; reasons: string[]; outstanding: Finding[] };

/**
 * A fix report as a reader takes one. The lists are not the reader's to change, so a
 * decoded Output — whose arrays are readonly — is one of these without being copied.
 */
export interface FixReport {
  readonly verdict: "clean" | "findings";
  readonly findings: ReadonlyArray<Finding>;
  readonly fixed: ReadonlyArray<Fixed>;
  readonly disputed: ReadonlyArray<Finding>;
  readonly checks: ReadonlyArray<Check>;
}

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
export function settleFinalFix(
  live: ReadonlyArray<Finding>,
  fix: FixReport,
  evidence: CheckEvidence,
): FinalFix {
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
export function splitDisputed(
  findings: ReadonlyArray<Finding>,
  disputed: ReadonlyArray<Finding>,
): Split {
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

export function formatFindings(findings: ReadonlyArray<Finding>): string {
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
