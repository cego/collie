// A judged Heal's Collie defect, filed on Collie's own repository or linked to the issue
// already there for its cause (cego/collie#443).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { Duration, Effect, Result } from "effect";
import { WorkflowError, type HostApi } from "./sdk";
import { recoveriesIn, type HealFinding, type Metric, type Publication } from "./metrics";

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// self-improve's marker (workflows/retrospective.ts), so either finds the other's issues.
const MARKER = /<!-- collie-finding: ([a-z0-9-]+) -->/g;
const markerOf = (key: string) => `<!-- collie-finding: ${key} -->`;
const keysIn = (body: string) =>
  Arr.map([...pipe(body, Str.matchAll(MARKER))], (match) => match[1] ?? "");

const SETTLED: ReadonlySet<Publication> = new Set(["filed", "linked", "not-filed"]);
const JUDGED = new Set(["recovered", "escalated", "false-recovery"]);

export interface Pending {
  readonly run: string;
  readonly heal: string;
  readonly judged: string;
  readonly cause: string;
  readonly build: string;
  readonly finding: HealFinding;
  /** The issue a comment was sent to whose answer was lost, or null. */
  readonly commented: string | null;
  /** The report last recorded for this Heal, or null. */
  readonly last: Pick<Reported, "publication" | "note"> | null;
}

/** Each of this Run's judged Heals whose Collie defect is not yet filed, linked or set aside. */
export const pendingIn = (run: string, lines: ReadonlyArray<Metric>): ReadonlyArray<Pending> => {
  const latest = new Map<string, Metric>();
  for (const line of lines)
    if (line.kind === "report" && line.heal !== undefined) latest.set(line.heal, line);
  return Arr.flatMap(recoveriesIn(lines), (line): ReadonlyArray<Pending> => {
    if (
      line.action !== "healed" ||
      line.heal === undefined ||
      line.finding?.collie_defect !== true ||
      !JUDGED.has(line.outcome ?? "")
    )
      return [];
    const last = latest.get(line.heal);
    if (last?.publication !== undefined && SETTLED.has(last.publication)) return [];
    return [
      {
        run,
        heal: line.heal,
        judged: line.outcome!,
        cause: line.cause ?? "unknown",
        build: line.build ?? "unknown",
        finding: line.finding,
        commented: last?.publication === "uncertain" ? (last.issue ?? null) : null,
        last:
          last?.publication === undefined
            ? null
            : { publication: last.publication, note: last.note },
      },
    ];
  });
};

/** Each key filed or linked from these lines, with its issue. */
export const knownIn = (lines: ReadonlyArray<Metric>): ReadonlyArray<readonly [string, string]> =>
  Arr.flatMap(lines, (line) =>
    line.kind === "report" &&
    line.issue !== undefined &&
    (line.publication === "filed" || line.publication === "linked")
      ? [[line.subject, line.issue] as const]
      : [],
  );

/** Why a finding is not filed as fact, or null where it is. */
const setAside = ({ judged, finding }: Pending) => {
  if (judged === "false-recovery")
    return "its Heal said the Run resumed while it stayed parked, so its finding is not filed as fact";
  if (!KEY.test(finding.key)) return "its key is not a kebab-case slug";
  for (const field of ["root_cause", "fix", "regression"] as const)
    if (Str.trim(finding[field]) === "") return `it does not say its ${field}`;
  return null;
};

const clip = (text: string, most: number) =>
  text.length <= most ? text : `${pipe(text, Str.slice(0, most - 1))}…`;

const titleOf = (finding: HealFinding) => {
  const said = Str.trim(finding.title ?? "");
  return clip(
    said !== "" ? said : (Str.split(Str.trim(finding.root_cause), /(?<=\.)\s/)[0] ?? ""),
    120,
  );
};

const said = (text: string | undefined) => clip(Str.trim(text ?? "") || "Not stated.", 2000);

const bodyOf = (item: Pending) =>
  Arr.join(
    [
      `**Observed.** ${said(item.finding.observed)}`,
      `**Expected.** ${said(item.finding.expected)}`,
      `Collie ${item.build} parked a Run for \`${item.cause}\` and started a Heal; Collie judged the Heal \`${item.judged}\` from the Run's own facts.`,
      `**Diagnosis**, the healer's, not yet confirmed. ${said(item.finding.root_cause)}`,
      `**Proposed fix.** ${said(item.finding.fix)}`,
      `**Regression.** ${said(item.finding.regression)}`,
      `Reported by Heal ${item.heal} of Run ${item.run}.`,
      markerOf(item.finding.key),
    ],
    "\n\n",
  );

const commentOf = (item: Pending) =>
  Arr.join(
    [
      `Also found by Heal ${item.heal} of Run ${item.run} on Collie ${item.build}, as \`${item.finding.key}\`, judged \`${item.judged}\`.`,
      `**Diagnosis**, the healer's, not yet confirmed. ${said(item.finding.root_cause)}`,
      markerOf(item.finding.key),
    ],
    "\n\n",
  );

// The forge's own words for a write whose answer was lost (src/forge/threads.ts).
const sent = (reason: string) => pipe(reason, Str.endsWith("before retrying"));

const ANSWER_WITHIN = Duration.minutes(2);
/** `call`, failing as unanswered after ANSWER_WITHIN; a write's may have landed. */
const bounded = <A>(call: Effect.Effect<A, WorkflowError>, write: boolean) =>
  call.pipe(
    Effect.timeoutOrElse({
      duration: ANSWER_WITHIN,
      orElse: () =>
        Effect.fail(
          new WorkflowError({
            reason: `no answer from Collie's repository within ${Duration.format(ANSWER_WITHIN)}${write ? "; inspect its issues before retrying" : ""}`,
          }),
        ),
    }),
  );

export interface Reported {
  readonly publication: Publication;
  readonly note: string;
  readonly issue?: string;
}

/**
 * Files `item` on Collie's repository, or links the issue already there: the one the healer
 * named, else an open one carrying its key, else one `known` for its key. Lists first every
 * time, so a filing whose answer was lost is found by its marker rather than filed again.
 */
export const report = (
  host: HostApi,
  item: Pending,
  known: ReadonlyMap<string, string>,
): Effect.Effect<Reported> =>
  Effect.gen(function* () {
    const why = setAside(item);
    if (why !== null) return { publication: "not-filed", note: why } satisfies Reported;
    const { heal, finding } = item;
    const listed = yield* Effect.result(bounded(host.issues(heal, undefined, "collie"), false));
    if (Result.isFailure(listed))
      return { publication: "refused", note: listed.failure.reason } satisfies Reported;
    const open = listed.success;
    const named =
      finding.issue === undefined || finding.issue === null
        ? undefined
        : (Option.getOrUndefined(Arr.findFirst(open, (one) => one.number === finding.issue)) ??
          (yield* bounded(host.issues(heal, [finding.issue], "collie"), false).pipe(
            Effect.map((read) => read[0]),
            Effect.orElseSucceed(() => undefined),
          )));
    const target =
      named ??
      Option.getOrUndefined(Arr.findFirst(open, (one) => keysIn(one.body).includes(finding.key)));
    const before = item.commented ?? known.get(finding.key);
    if (target === undefined && before !== undefined)
      return {
        publication: "linked",
        issue: before,
        note: `linked to the issue already reported for ${finding.key}`,
      } satisfies Reported;
    if (target !== undefined) {
      if (keysIn(target.body).includes(finding.key) || before === target.url)
        return {
          publication: "linked",
          issue: target.url,
          note: `linked to #${target.number}, which already carries ${finding.key}`,
        } satisfies Reported;
      const commented = yield* Effect.result(
        bounded(
          host.commentIssue({
            runId: heal,
            number: target.number,
            body: commentOf(item),
            on: "collie",
          }),
          true,
        ),
      );
      if (Result.isSuccess(commented))
        return {
          publication: "linked",
          issue: target.url,
          note: `linked to #${target.number} with ${finding.key} as another key for its cause`,
        } satisfies Reported;
      return sent(commented.failure.reason)
        ? ({
            publication: "uncertain",
            issue: target.url,
            note: commented.failure.reason,
          } satisfies Reported)
        : ({ publication: "refused", note: commented.failure.reason } satisfies Reported);
    }
    const filed = yield* Effect.result(
      bounded(
        host.fileIssue({ runId: heal, title: titleOf(finding), body: bodyOf(item), on: "collie" }),
        true,
      ),
    );
    if (Result.isSuccess(filed))
      return {
        publication: "filed",
        issue: filed.success.url,
        note: `filed as #${filed.success.number}`,
      } satisfies Reported;
    return {
      publication: sent(filed.failure.reason) ? "uncertain" : "refused",
      note: filed.failure.reason,
    } satisfies Reported;
  });
