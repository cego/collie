// One card, one drift report, one delivery — as lines, once. Both the app's Live region
// and the one-screen text view draw these, and two renderers of one card is how the text
// view comes to say less about a Run than the app does. A row's marks and a proposed
// action's sentence are here for the same reason: they are the same words in both.
//
// Nothing here reaches for Effect, which is what lets the state layer and the components
// take these directly (ADR-0005).
//
// The discipline is in the lines themselves rather than in whoever draws them: a claim is
// prefixed `claimed:` so it can never be read as a pass, `missing` is emitted even when it
// is empty, and the narrative is last and named as Collie's. A `tone` is a hint about
// emphasis and never the only carrier — every line reads correctly with no colour at all.

import type { Card } from "./cards";
import type { Delivery } from "./steering";
import type { Action, DriftReport, Ref } from "./evaluator";

/** How much a line asks for the eye. Never the only thing saying what it says. */
export type Tone = "plain" | "dim" | "bad" | "accent";

export interface Line {
  text: string;
  tone: Tone;
  /** How far in it sits, so a renderer can indent without parsing the text. */
  depth: number;
}

const line = (text: string, tone: Tone = "dim", depth = 0): Line => ({ text, tone, depth });

/** A short revision: enough to say which tree a card is about without filling its header. */
const short = (sha: string) => sha.slice(0, 7);

/** Where a piece of evidence is, in the words a human would use to go and look. */
export function refText(ref: Ref): string {
  const where = [ref.path, ref.line === undefined ? "" : `:${ref.line}`].join("");
  return [ref.kind, where === "" ? (ref.sha ?? "") : where].filter((part) => part !== "").join(" ");
}

/** What a verification's result asks for. A pass takes none: plain text reads as ordinary. */
function resultTone(result: Card["verifications"][number]["result"]): Tone {
  if (result === "fail") return "bad";
  return result === "pass" ? "plain" : "dim";
}

/** Why a result that is neither a pass nor a fail is neither, said in words. */
function resultNote(result: Card["verifications"][number]["result"]): string {
  if (result === "stale") return " (against an older tree)";
  return result === "unstable" ? " (not repeatable)" : "";
}

export function cardLines(card: Card): Line[] {
  const lines: Line[] = [
    line(
      `${card.kind} · ${card.step} · iteration ${card.iteration} · ${short(card.revision.head_sha)} · ${card.significance}`,
      "accent",
    ),
  ];
  if (card.requested.goal !== null) lines.push(line(`asked for: ${card.requested.goal}`));
  for (const constraint of card.requested.constraints) {
    lines.push(line(`constraint: ${constraint}`, "dim", 1));
  }
  if (card.changes.files.length > 0) {
    lines.push(line(`changed: ${card.changes.files.join(" ")}`));
  }
  // What somebody ran, bound to this tree. Never mixed with what an agent said.
  for (const check of card.verifications) {
    lines.push(
      line(
        `${check.name} ${check.result}${resultNote(check.result)} · ${check.ref}`,
        resultTone(check.result),
        1,
      ),
    );
  }
  for (const claim of card.claims) {
    lines.push(line(`claimed: ${claim.text} · ${claim.ref}`, "dim", 1));
  }
  // Always: the half of a report that is usually missing from one.
  lines.push(
    line(
      `missing: ${card.missing.length === 0 ? "nothing was left unchecked" : card.missing.join("; ")}`,
      "dim",
      1,
    ),
  );
  for (const entry of card.inspect) {
    lines.push(
      line(`look at ${entry.what}: ${entry.how}${entry.note ? ` (${entry.note})` : ""}`, "dim", 1),
    );
  }
  for (const [name, where] of Object.entries(card.links)) {
    lines.push(line(`${name}: ${String(where)}`, "dim", 1));
  }
  // Last, and dim: prose a model wrote about its own work, marked as its author.
  if (card.narrative !== null) lines.push(line(`Collie: ${card.narrative}`, "dim", 1));
  return lines;
}

/**
 * One drift report and its evidence. `undelivered` is a report about a Run that had
 * already finished when it was judged: never written to that Run's inbox, because there
 * is nothing there to act on it (SPEC §9.5).
 */
export function driftLines(report: DriftReport, undelivered = false): Line[] {
  const lines = [
    line(
      `${undelivered ? "pending report (undelivered) · " : ""}${report.severity} ${report.constraint} · ${report.resolution}`,
      report.severity === "block" ? "bad" : "plain",
    ),
  ];
  for (const ref of report.evidence) lines.push(line(refText(ref), "dim", 2));
  if (report.evidence_truncated) {
    lines.push(line("(the evidence was cut to its bound)", "dim", 2));
  }
  return lines;
}

export function deliveryLine(delivery: Delivery): Line {
  return line(
    `→ ${delivery.agent} ${delivery.state} · ${delivery.mode} · ${delivery.cause.kind}`,
    "dim",
    1,
  );
}

/** The Home's ownership question, which only a human can settle. */
export function ownershipLines(why: string, candidates: ReadonlyArray<string>): Line[] {
  return [
    line("Collie cannot tell which workspace is this Herd's Home.", "bad"),
    line(why, "bad", 1),
    line(`candidates: ${candidates.join(", ")}`, "bad", 1),
    line("`collie home reconcile --adopt <id>` or `--forget` settles it.", "bad", 1),
  ];
}

/** One line as text, indented. What the one-screen view draws and what a test reads. */
export const asText = (entry: Line) => `${"  ".repeat(entry.depth)}${entry.text}`;

/**
 * One proposed action in a sentence. Here rather than beside the CLI that first needed
 * it, because the board draws the same preview and a board that described an action its
 * own way would be a second opinion about what a human is being asked to consent to.
 */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "deliver":
      return `deliver to ${action.agent} (${action.mode}): ${action.text}`;
    case "update_intent":
      return `update ${action.run}'s intent: ${action.patch}`;
    case "ask_human":
      return `ask you: ${action.question}`;
    case "none":
      return `do nothing: ${action.why}`;
    case "start":
      return `start ${action.workflow}`;
    default:
      return `${action.kind} ${"run" in action ? action.run : ""}`.trim();
  }
}

/**
 * What steering has found about one Run, as the row's own marks. Facts, not a verdict:
 * significance is the card's business and drift is the report's, so a row only says
 * which of them there is something to see about.
 */
export interface RunMarks {
  /** A card worth a human's eyes: significance `try-it`, nobody has looked yet. */
  tryIt: boolean;
  /** A DriftReport nobody has resolved. */
  drift: boolean;
  /** Told to take on no new work until a human releases it. */
  held: boolean;
  /**
   * A human typed at one of this Run's agents themselves. Per Run rather than per
   * incarnation: the ledger records it against one agent, and what a human needs to know
   * is that this Run is being argued with — so the Run's row and its agents' rows both
   * say so.
   */
  override: boolean;
  /**
   * Corrections are going out on a harness that cannot tell Collie's submissions from a
   * human's. Words rather than a glyph, because it is a disclosure — see `Live.unattributed`.
   */
  unattributed: boolean;
  /** A proposal waiting on a yes or a no. */
  proposal: boolean;
}

export const NO_MARKS: RunMarks = {
  tryIt: false,
  drift: false,
  held: false,
  override: false,
  unattributed: false,
  proposal: false,
};

/** What a Run's marks look like, worst first. */
const MARKS: ReadonlyArray<readonly [keyof RunMarks, string]> = [
  ["drift", "↯"],
  ["override", "⚠ manual"],
  ["unattributed", "⚠ unattributed"],
  ["held", "⏸"],
  ["proposal", "!"],
  ["tryIt", "▶"],
];

/**
 * A Run's marks as one string. Glyphs rather than colour, because the text fallback and
 * herdr's tab strip show these too — and `⚠ manual` is words as well as a glyph because
 * a human sending to an agent behind Collie's back is what stops corrections.
 */
export function marksOf(marks: RunMarks): string {
  return MARKS.filter(([key]) => marks[key])
    .map(([, glyph]) => glyph)
    .join(" ");
}

/** The marks a group row inherits: the worst of what is under it. */
export function worstOf(marks: ReadonlyArray<RunMarks>): string {
  for (const [key, glyph] of MARKS) {
    if (marks.some((mark) => mark[key])) return glyph;
  }
  return "";
}

/** What a producer hands the rows: one entry per Run it found anything about. */
export type Marks = Readonly<Record<string, RunMarks>>;

export const markFor = (marks: Marks | undefined, runId: string | null): RunMarks =>
  (runId === null ? undefined : marks?.[runId]) ?? NO_MARKS;
