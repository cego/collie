// WARNING: a status is a line, so the latest word wins over the file and nothing believed before is lost.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schema } from "effect";
import type { ReviewFinding } from "./board-model";
import { FindingStatus } from "./board-model";
import type { Finding } from "./output";
import { findingsIn } from "./output";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { RunRecords, runOfDir } from "./run-records";

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

// WARNING: a dispute is someone's still to answer, so it counts as open.
const isOpenFinding = (status: string) => status === "open" || status === "disputed";

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

export const openCountIn = Effect.fn("FindingStatus.count")(function* (runDir: string) {
  return openFindingsOf(yield* findingsIn(runDir), yield* readFindingStatuses(runDir));
});

export const storeOpenCount = Effect.fn("FindingStatus.storeCount")(function* (runDir: string) {
  const count = yield* openCountIn(runDir);
  yield* RunRecords.use((records) => records.put(runOfDir(runDir), OPEN_FINDINGS, String(count)));
  return count;
});

// WARNING: a Run settled before this fact existed has its count computed and kept the first time it is read.
export const openFindingsFact = Effect.fn("FindingStatus.fact")(function* (runDir: string) {
  const kept = yield* RunRecords.use((records) => records.fact(runOfDir(runDir), OPEN_FINDINGS));
  const count = kept === null ? Number.NaN : Number(kept);
  return Number.isFinite(count) ? count : yield* storeOpenCount(runDir);
});
