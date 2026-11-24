// WARNING: The discipline is in the lines: `claimed:` keeps a claim from reading as a pass, and `missing` is always emitted.
import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { CommandLine } from "effect/process";
import type { Card } from "./cards";
import type { Delivery } from "./steering";
import type { DriftReport, Ref } from "./evaluator";
import { recipientOf } from "./actions";
import type { Action } from "./actions";

export type Tone = "plain" | "dim" | "bad" | "accent";

export interface Line {
  text: string;
  tone: Tone;
  depth: number;
}

const line = (text: string, tone: Tone = "dim", depth = 0) => ({ text, tone, depth });

const short = (sha: string) => pipe(sha, Str.slice(0, 7));

export function refText(ref: Ref) {
  const where = Arr.join(
    Arr.map([ref.path, ref.line === undefined ? "" : `:${ref.line}`], (part) =>
      part === null || part === undefined ? "" : globalThis.String(part),
    ),
    "",
  );
  return Arr.join(
    Arr.filter([ref.kind, where === "" ? (ref.sha ?? "") : where], (part) => part !== ""),
    " ",
  );
}

function resultTone(result: Card["verifications"][number]["result"]) {
  if (result === "fail") {
    return "bad";
  }
  return result === "pass" ? "plain" : "dim";
}

function resultNote(result: Card["verifications"][number]["result"]) {
  if (result === "stale") {
    return " (against an older tree)";
  }
  return result === "unstable" ? " (not repeatable)" : "";
}

export function cardLines(card: Card) {
  const lines: Array<Line> = [
    line(
      `${card.kind} · ${card.step} · ${short(card.revision.head_sha)} · ${card.significance}`,
      "accent",
    ),
  ];
  if (card.requested.goal !== null) {
    lines.push(line(`asked for: ${card.requested.goal}`));
  }
  for (const constraint of card.requested.constraints) {
    lines.push(line(`constraint: ${constraint}`, "dim", 1));
  }
  if (card.changes.files.length > 0) {
    lines.push(line(`changed: ${Arr.join(card.changes.files, " ")}`));
  }
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
  lines.push(
    line(
      `missing: ${card.missing.length === 0 ? "nothing was left unchecked" : Arr.join(card.missing, "; ")}`,
      "dim",
      1,
    ),
  );
  for (const entry of card.inspect) {
    lines.push(
      line(`look at ${entry.what}: ${entry.how}${entry.note ? ` (${entry.note})` : ""}`, "dim", 1),
    );
  }
  for (const [name, where] of Arr.map(
    Struct.keys(card.links),
    (key) => [key, card.links[key]] as const,
  )) {
    lines.push(line(`${name}: ${String(where)}`, "dim", 1));
  }
  if (card.narrative !== null) {
    lines.push(line(`Collie: ${card.narrative}`, "dim", 1));
  }
  return lines;
}

// WARNING: Never written to the Run's inbox: a report on a finished Run has no consumer, so it shows as undelivered.
export function driftLines(report: DriftReport, undelivered = false) {
  const lines = [
    line(
      `${undelivered ? "pending report (undelivered) · " : ""}${report.severity} ${report.constraint} · ${report.resolution}`,
      report.severity === "block" ? "bad" : "plain",
    ),
  ];
  for (const ref of report.evidence) {
    lines.push(line(refText(ref), "dim", 2));
  }
  if (report.evidence_truncated) {
    lines.push(line("(the evidence was cut to its bound)", "dim", 2));
  }
  return lines;
}

export function deliveryLine(delivery: Delivery) {
  return line(
    `→ ${delivery.agent} ${delivery.state} · ${delivery.mode} · ${delivery.cause.kind}`,
    "dim",
    1,
  );
}

export function newsLines(news: { waiting: number; uncertain: number }) {
  if (news.waiting === 0) {
    return [];
  }
  return [
    line(
      `${news.waiting} development(s) Collie has noticed and not yet told the conversation.`,
      "accent",
    ),
    ...(news.uncertain === 0
      ? []
      : [line(`${news.uncertain} of them nobody can account for having sent.`, "bad", 1)]),
  ];
}

// oxlint-disable-next-line effecttsgo/prefer-effect-string -- Effect repeat would remove RangeError validation for negative indentation.
export const asText = (entry: Line) => `${"  ".repeat(entry.depth)}${entry.text}`;

function everyNewRunIn(workspace: string) {
  return `what every new Run in workspace ${workspace} begins with`;
}

const commandLine = (command: {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
}) => `${CommandLine.display([command.executable, ...command.argv])} (in ${command.cwd})`;

const named = (fields: Record<string, string>) =>
  Arr.map(Rec.toEntries(fields), ([name, value]) => `${name}=${value}`);

export function describeAction(action: Action) {
  switch (action.kind) {
    case "deliver":
      return `deliver to ${recipientOf(action)} (${action.mode}): ${action.text}`;
    case "update_intent":
      return `${action.change} on ${action.run}'s intent: ${action.patch}`;
    case "set_verification":
      return action.command === undefined
        ? `withdraw ${action.run}'s check ${action.name}`
        : `let Collie run ${action.name} for ${action.run}: ${commandLine(action.command)}`;
    case "remember_verification":
      return `keep ${action.run}'s checks for every later Run in its repository${action.replace === true ? ", replacing what is kept there" : ""}`;
    // WARNING: Always name the workspace: a line without it asks a yes to a change nobody could see.
    case "update_defaults":
      return action.change === "remove-constraint"
        ? `remove the constraint ${action.text} from ${everyNewRunIn(action.workspace)}`
        : `add to ${everyNewRunIn(action.workspace)}: ${action.text}`;
    case "fork_definition":
      return `fork ${action.what} ${action.name} as ${action.as} in the ${action.layer ?? "user"} layer`;
    case "home_cleanup":
      return "forget Tasks whose workspace is gone";
    case "cleanup":
      return "sweep now: remove what Collie made that nothing needs any more, as `collie cleanup` lists it";
    case "upgrade":
      return "upgrade this installation of Collie";
    case "onboard":
      return `onboard this Machine: install or repair what Collie needs here${action.skip?.length ? `, without ${Arr.join(action.skip, " and ")}` : ""}`;
    case "hold":
      return action.until === undefined
        ? `hold ${action.run}`
        : `hold ${action.run} until ${action.until}`;
    case "ask_human":
      return `ask you: ${action.question}`;
    case "none":
      return `do nothing: ${action.why}`;
    case "start": {
      const where =
        action.workspace === undefined
          ? "no workspace named, so it will be refused"
          : `workspace ${action.workspace}`;
      // WARNING: Inputs are shown too: a yes to a workflow name alone approves a plan nobody read.
      const on = named(action.inputs);
      const decided = named(action.decisions ?? {});
      const checks = Arr.map(action.verify ?? [], (spec) => `${spec.name}: ${commandLine(spec)}`);
      return Arr.join(
        [
          `start ${action.workflow} in ${where}`,
          ...(on.length === 0 ? [] : [`on ${Arr.join(on, ", ")}`]),
          ...(decided.length === 0 ? [] : [`with ${Arr.join(decided, ", ")} already decided`]),
          ...(checks.length === 0 ? [] : [`letting Collie run ${Arr.join(checks, "; ")}`]),
        ],
        " ",
      );
    }
    default:
      return Str.trim(`${action.kind} ${"run" in action ? action.run : ""}`);
  }
}

export interface RunMarks {
  tryIt: boolean;
  drift: boolean;
  held: boolean;
  override: boolean;
  unattributed: boolean;
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

const MARKS: ReadonlyArray<readonly [keyof RunMarks, string]> = [
  ["drift", "↯"],
  ["override", "⚠ manual"],
  ["unattributed", "⚠ unattributed"],
  ["held", "⏸"],
  ["proposal", "!"],
  ["tryIt", "▶"],
];

export function marksOf(marks: RunMarks) {
  return Arr.join(
    Arr.map(
      Arr.filter(MARKS, ([key]) => marks[key]),
      ([, glyph]) => glyph,
    ),
    " ",
  );
}

export function worstOf(marks: ReadonlyArray<RunMarks>) {
  for (const [key, glyph] of MARKS) {
    if (Arr.some(marks, (mark) => mark[key])) {
      return glyph;
    }
  }
  return "";
}

export type Marks = Readonly<Record<string, RunMarks>>;

export const markFor = (marks: Marks | undefined, runId: string | null) =>
  (runId === null ? undefined : marks?.[runId]) ?? NO_MARKS;
