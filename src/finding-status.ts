// WARNING: a status is a line, so the latest word wins over the file and nothing believed before is lost.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema } from "effect";
import type { ReviewFinding } from "./board-model";
import { FindingStatus } from "./board-model";
import type { Finding } from "./output";
import { FINDINGS_FILE, REVIEW_FILE, findingsIn } from "./output";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { RunRecords, runOfDir } from "./run-records";
import { nowIso } from "./time";
import * as Str from "effect/String";

const STATUS_JOURNAL = "findings/status.jsonl";

export const OPEN_FINDINGS = "open-findings";

const StatusJson = Schema.fromJsonString(FindingStatus);

const findingStatusPath = (runDir: string) => runJournal(runDir, STATUS_JOURNAL);

export const recordFindingStatus = Effect.fn("FindingStatus.record")(function* (
  runDir: string,
  line: FindingStatus,
) {
  yield* appendRunJournal(findingStatusPath(runDir), StatusJson, line);
});

export const readFindingStatuses = Effect.fn("FindingStatus.read")(function* (runDir: string) {
  return yield* readRunJournal(findingStatusPath(runDir), StatusJson);
});

const saidAbout = (lines: ReadonlyArray<FindingStatus>, id: string | undefined) =>
  id === undefined ? undefined : Option.getOrUndefined(Arr.findLast(lines, (one) => one.id === id));

export const isOpenFinding = (status: string) => status === "open" || status === "disputed";

const isIds = Schema.is(Schema.Array(Schema.String));
const isText = Schema.is(Schema.String);

// WARNING: an id list arrives as JSON or as text somebody typed, and anything else is nothing.
export const idsIn: (given: Schema.Json | undefined) => ReadonlyArray<string> | null = (given) => {
  if (given === undefined) {
    return [];
  }
  if (isIds(given)) {
    return given;
  }
  if (!isText(given)) {
    return null;
  }
  return Arr.filter(Arr.map(Str.split(given, /[\n,]/), Str.trim), (one) => one !== "");
};

export const markTaken = Effect.fn("FindingStatus.taken")(function* (
  runDir: string,
  ids: ReadonlyArray<string>,
  offer: string,
  child: string,
  by: string,
) {
  const at = yield* nowIso;
  for (const id of ids) {
    yield* recordFindingStatus(runDir, {
      id,
      status: "taken",
      reason: null,
      offer,
      run: child,
      by,
      at,
    });
  }
  yield* storeOpenCount(runDir);
});

export const effectiveStatusOf: (
  finding: Finding,
  lines: ReadonlyArray<FindingStatus>,
) => ReviewFinding["status"] = (finding, lines) =>
  saidAbout(lines, finding.id)?.status ?? finding.status ?? "open";

const openFindingsOf = (findings: ReadonlyArray<Finding>, lines: ReadonlyArray<FindingStatus>) =>
  Arr.filter(findings, (finding) => isOpenFinding(effectiveStatusOf(finding, lines))).length;

export const findingsWithStatus = Effect.fn("FindingStatus.findings")(function* (runDir: string) {
  const findings = yield* findingsIn(runDir);
  const lines = yield* readFindingStatuses(runDir);
  const returned: ReadonlyArray<ReviewFinding> = Arr.map(findings, (finding) => {
    const said = saidAbout(lines, finding.id);
    return {
      id: finding.id ?? "",
      status: effectiveStatusOf(finding, lines),
      reason: said?.reason ?? null,
      offer: said?.offer ?? null,
      run: said?.run ?? null,
      severity: finding.severity,
      title: finding.title,
      file: finding.file ?? null,
      line: finding.line ?? null,
      detail: finding.detail ?? null,
      basis: finding.basis ?? null,
      evidence: finding.evidence ?? null,
      suggested: finding.suggested ?? null,
    };
  });
  return returned;
});

const REPORT_FILES = [REVIEW_FILE, "investigation.md"];

export const reportIn = Effect.fn("FindingStatus.report")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const name of REPORT_FILES) {
    const there = yield* fs.exists(`${runDir}/${name}`).pipe(Effect.orElseSucceed(() => false));
    if (there) {
      return `${runDir}/${name}`;
    }
  }
  return `${runDir}/${FINDINGS_FILE}`;
});

export const findingText = (finding: ReviewFinding, report: string) =>
  Arr.join(
    Arr.filter(
      [
        `${finding.title} (${finding.severity})`,
        finding.file === null
          ? ""
          : `Where: ${finding.file}${finding.line === null ? "" : `:${finding.line}`}`,
        finding.detail === null ? "" : `Detail: ${finding.detail}`,
        finding.evidence === null ? "" : `Evidence: ${finding.evidence}`,
        finding.basis === null ? "" : `Basis: ${finding.basis}`,
        `From: ${report}`,
      ],
      (one) => one !== "",
    ),
    "\n",
  );

export const openCountIn = Effect.fn("FindingStatus.count")(function* (runDir: string) {
  return openFindingsOf(yield* findingsIn(runDir), yield* readFindingStatuses(runDir));
});

export const storeOpenCount = Effect.fn("FindingStatus.storeCount")(function* (runDir: string) {
  const count = yield* openCountIn(runDir);
  yield* RunRecords.use((records) => records.put(runOfDir(runDir), OPEN_FINDINGS, String(count)));
  return count;
});

// WARNING: a reader that must not move a card writes nothing, so the count is computed and not kept.
export const openFindingsRead = Effect.fn("FindingStatus.readCount")(function* (runDir: string) {
  const kept = yield* RunRecords.use((records) => records.fact(runOfDir(runDir), OPEN_FINDINGS));
  const count = kept === null ? Number.NaN : Number(kept);
  return Number.isFinite(count) ? count : yield* openCountIn(runDir);
});

// WARNING: a Run settled before this fact existed has its count computed and kept the first time it is read.
export const openFindingsFact = Effect.fn("FindingStatus.fact")(function* (runDir: string) {
  const kept = yield* RunRecords.use((records) => records.fact(runOfDir(runDir), OPEN_FINDINGS));
  const count = kept === null ? Number.NaN : Number(kept);
  return Number.isFinite(count) ? count : yield* storeOpenCount(runDir);
});
