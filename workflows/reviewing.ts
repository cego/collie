import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { FixOutputSchema } from "collie";
import {
  Agents,
  Host,
  ReviewOutputSchema,
  ReviewScope,
  Run,
  SynthesisSchema,
  WorkflowError,
  agentWork,
  contentOf,
  conflictingDispositions,
  findingKey,
  findingsIn,
  panelOf,
  formatFindings,
  isBlocking,
  leaveOutstanding,
  leaveReview,
  mrForgeFacts,
  parseMrTarget,
  remainingDisputes,
  renderRecordedChecks,
  repoArgs,
  riskLine,
  settleFinalFix,
  settleRound,
  splitDisputed,
  step,
  targetKind,
} from "collie";
import type { Finding, Integration, SynthesisReport } from "collie";
import { Effect, FileSystem, Option, Result, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import type { WorkflowEngine, WorkflowInstance } from "effect/workflow/WorkflowEngine";
import markdown from "./review.md" with { type: "text" };
import type { Reviewed } from "./delivering.ts";

const content = contentOf(markdown);
const text = Schema.String;

const change = {
  inputs: Schema.Struct({ target: text, target_kind: text, plan: text, outcome: text }),
  target_repo: text,
  mr: Schema.Struct({ forge: text, noun: text, diff: text, view: text, checkout: text }),
  base: text,
};

export const HEAD_MOVED = "reviewed head changed while reviewing";
export const MR_ENDED = "reviewed merge request ended: ";

export const NO_MR = { forge: "", noun: "", diff: "", view: "", checkout: "" };

export const DEFAULT_BASE = "<default-branch>";

export const REVIEW = content.template("review", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  previous: Schema.Struct({ review: text, fix: text }),
  ledger: text,
  changes: text,
  iteration: text,
  max_iterations: text,
  disputed: text,
  risks: text,
  obstacle: text,
  checks: text,
  criteria: text,
});

const SYNTHESIZE = content.template("synthesize", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  previous: Schema.Struct({ review: text }),
  ledger: text,
  changes: text,
  fan_in: text,
  disputed: text,
  obstacle: text,
});

export const FIX_PROMPT = content.template("fix", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  branch: text,
  iteration: text,
  max_iterations: text,
  findings: text,
  disputed: text,
});

// WARNING: the role in the definition sets the reviewer, not the work's pin, so a fork's role reaches every reviewer.
export const REVIEWER = { harness: "claude", model: "opus", effort: "high" };

export const IMPLEMENTER = { harness: "claude", model: "opus", effort: "high" };

export const reviewRound = step({
  id: "review",
  title: "Review",
  description: "Reviewers read the change, and what blocks goes back to be fixed.",
  kind: "agent",
  role: "reviewer",
  produces: "review",
});

export const synthesisStep = step({
  id: "synthesis",
  title: "Synthesis",
  description: "Reconcile the reviewers' findings into one report.",
  kind: "agent",
  role: "reviewer",
  produces: "review",
});

export interface ReviewAsk {
  readonly target: string;
  readonly plan: string;
  readonly proves: string;
  readonly previous: string;
  readonly ledger?: ReadonlyArray<Finding>;
  // WARNING: a new finding never takes an id this Run already gave outside `ledger`.
  readonly taken?: ReadonlyArray<string>;
  readonly head?: string;
  readonly stamped?: string;
  readonly changes?: string;
  readonly delta?: string;
  readonly answered: string;
  readonly risks: string;
  readonly at: number;
  readonly of: number;
  readonly disputed: ReadonlyArray<Finding>;
  readonly prefix?: string;
  readonly reviewers?: string;
  readonly obstacle?: string;
  readonly base?: string;
  readonly criteria?: string;
  readonly source?: string | null;
}

const LedgerJson = Schema.fromJsonString(Schema.Unknown, { space: 2 });
const formatDisputes = (disputed: ReadonlyArray<Finding>) =>
  formatFindings(
    Arr.map(disputed, (finding) => {
      const reason = Str.trim(finding.reason ?? "");
      return reason === ""
        ? finding
        : { ...finding, detail: Str.trim(`${finding.detail ?? ""}\nDisputed because: ${reason}`) };
    }),
  );

export const told = (ask: ReviewAsk, run: { readonly dir: string; readonly id: string }) => ({
  inputs: {
    target: ask.target,
    target_kind: targetKind(ask.target),
    plan: ask.plan,
    outcome: ask.proves,
  },
  run,
  previous: { review: ask.previous, fix: ask.answered },
  ledger:
    ask.ledger === undefined
      ? ""
      : `Earlier findings ledger:\n${Result.getOrThrow(Schema.encodeResult(LedgerJson)(ask.ledger))}`,
  changes: `${ask.head ? `Review head: ${ask.head}\n\n` : ""}${ask.changes ?? ""}${ask.delta ?? ""}`,
  iteration: String(ask.at),
  max_iterations: String(ask.of),
  disputed: formatDisputes(ask.disputed),
  risks: riskLine(ask.risks),
  target_repo: Arr.join(repoArgs(parseMrTarget(ask.target)?.project ?? null), " "),
  mr: ask.changes
    ? { ...(mrForgeFacts(ask.target) ?? NO_MR), diff: "the supplied diff below" }
    : (mrForgeFacts(ask.target) ?? NO_MR),
  base: ask.base || DEFAULT_BASE,
  obstacle: ask.obstacle ?? "",
});

export const reviewPass = (ask: ReviewAsk) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const { id } = yield* Run;
    const host = yield* Host;
    const { dir, cwd } = yield* host.place(id);
    const completed = Activity.make({
      name: `${ask.prefix ?? ""}review-completed-${ask.at}`,
      success: Schema.Void,
      error: WorkflowError,
      execute: host.completedRound({ runId: id, target: ask.target }),
    });
    const confirmHead = Effect.gen(function* () {
      if (ask.head) {
        yield* Activity.make({
          name: `${ask.prefix ?? ""}review-head-confirmed-${ask.at}`,
          success: Schema.String,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const reading = yield* host.mrReading({ target: ask.target, cwd });
            if (reading.state !== "open") {
              return yield* new WorkflowError({ reason: `${MR_ENDED}${reading.state}` });
            }
            if (reading.head !== ask.head) {
              return yield* new WorkflowError({
                reason: `${HEAD_MOVED} ${ask.head}; review again before posting`,
              });
            }
            return reading.head;
          }),
        });
      }
    });
    const record = (report: SynthesisReport) =>
      Effect.gen(function* () {
        if (ask.ledger === undefined) {
          yield* leaveReview(dir, report);
          yield* completed;
          yield* confirmHead;
          yield* recordReview(report);
          return report;
        }
        const before = ask.ledger;
        const findings: Array<Finding> = [];
        const ids = new Set<string>();
        const reserved = new Set([
          ...Arr.map([...before, ...report.findings], (one) => one.id),
          ...(ask.taken ?? []),
        ]);
        let next = 1;
        for (const finding of report.findings) {
          const earlier = Option.getOrUndefined(
            Arr.findFirst(before, (one) =>
              finding.id === undefined
                ? findingKey(one) === findingKey(finding)
                : one.id === finding.id,
            ),
          );
          let identity = finding.id ?? earlier?.id;
          if (identity === undefined) {
            while (reserved.has(`${id}-F${next}`)) {
              next += 1;
            }
            identity = `${id}-F${next}`;
          }
          if (ids.has(identity)) {
            return yield* new WorkflowError({ reason: `duplicate finding id ${identity}` });
          }
          ids.add(identity);
          reserved.add(identity);
          const status = finding.status ?? "open";
          findings.push({
            ...finding,
            id: identity,
            status,
            head: ask.head ?? ask.stamped ?? "",
            note: status === earlier?.status ? (earlier.note ?? "") : "",
          });
        }
        for (const earlier of before) {
          if (Arr.some(findings, (one) => one.id === earlier.id)) {
            continue;
          }
          if (Arr.some(report.fixed, (one) => findingKey(one) === findingKey(earlier))) {
            findings.push({
              ...earlier,
              status: "fixed",
              head: ask.head ?? ask.stamped ?? "",
              note: "",
            });
          } else {
            return yield* new WorkflowError({
              reason: `review omitted earlier finding ${earlier.id ?? earlier.title}; return its status`,
            });
          }
        }
        const recorded: SynthesisReport = {
          ...report,
          findings,
          verdict: Arr.some(findings, (one) => one.status === "open" || one.status === "disputed")
            ? "findings"
            : "clean",
        };
        yield* leaveReview(dir, recorded);
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(`${dir}/review-head`, ask.head ?? "")
          .pipe(Effect.orDie);
        yield* completed;
        yield* confirmHead;
        yield* recordReview(recorded);
        return recorded;
      });
    // WARNING: a check left to CI is read from the forge where the Run has a merge request, never run.
    const leftToCi = yield* Effect.forEach(
      Arr.filter(yield* host.approved(id), (spec) => spec.ci !== undefined),
      (spec) =>
        Effect.map(host.ciJob({ runId: id, cwd, name: spec.name }), (read) => ({
          name: spec.name,
          job: spec.ci ?? "",
          state: "proved" in read ? "passed" : read.state,
        })),
    );
    const checks = renderRecordedChecks(yield* host.evidence(id, cwd), leftToCi);
    const prefix = ask.prefix ?? "";
    const reviewOp = (seat: string) =>
      `${prefix}${ask.at === 1 ? `review-${seat}` : `review-${ask.at}-${seat}`}`;
    const synthesis = `${prefix}${ask.at === 1 ? "synthesize" : `synthesize-${ask.at}`}`;

    const seats = Arr.map(yield* panelOf("reviewer"), (seat, at) => ({
      seat,
      operation: reviewOp(seat.name ?? String(at + 1)),
      agent:
        ask.reviewers === undefined
          ? undefined
          : `${ask.reviewers}review-${seat.name ?? String(at + 1)}`,
    }));
    const scope = yield* Activity.make({
      name: `${synthesis}.scope`,
      success: Schema.NullOr(ReviewScope),
      execute: Effect.gen(function* () {
        if (ask.source === null || (ask.target !== "" && ask.target !== "worktree")) {
          return null;
        }
        const fs = yield* FileSystem.FileSystem;
        const collected = yield* Effect.forEach(seats, ({ operation }) =>
          fs.exists(agents.outputFor(id, operation)),
        );
        // WARNING: earlier passes without a journaled scope cannot acquire one on replay.
        if (Arr.some(collected, Boolean)) {
          return null;
        }
        return yield* host.reviewScope(id, ask.source ?? ask.plan, ask.proves, ask.risks);
      }).pipe(Effect.orDie),
    });
    const input = told({ ...ask, base: scope?.target ?? ask.base }, { dir, id });
    const recordReview = (review: SynthesisReport) =>
      Activity.make({
        name: `${synthesis}.record`,
        success: Schema.Void,
        execute: host.recordReview(id, scope, scope?.target ?? ask.base ?? "", review),
      });
    // WARNING: a lone reviewer is asked for the synthesis's own fields; a second agent would only copy it.
    if (seats.length === 1) {
      const [only] = seats;
      const alone: SynthesisReport = yield* agentWork({
        operation: only.operation,
        agent: only.agent,
        role: "reviewer",
        seat: only.seat,
        instructions: REVIEW,
        input: { ...input, checks, criteria: ask.criteria ?? "" },
        output: SynthesisSchema,
      });
      return yield* record(alone);
    }
    yield* Effect.forEach(
      seats,
      ({ seat, operation, agent }) =>
        agentWork({
          operation,
          agent,
          role: "reviewer",
          seat,
          instructions: REVIEW,
          input: { ...input, checks, criteria: ask.criteria ?? "" },
          output: ReviewOutputSchema,
        }),
      { concurrency: "unbounded" },
    );

    const reconciled: SynthesisReport = yield* synthesisStep(
      agentWork({
        operation: synthesis,
        agent: ask.reviewers === undefined ? undefined : `${ask.reviewers}synthesize`,
        role: "reviewer",
        instructions: SYNTHESIZE,
        input: {
          ...input,
          fan_in: Arr.join(
            Arr.map(seats, ({ operation }) => `- ${agents.outputFor(id, operation)}`),
            "\n",
          ),
        },
        output: SynthesisSchema,
      }),
    );
    return yield* record(reconciled);
  });

export const followUp = (ask: {
  readonly name: string;
  readonly target: string;
  readonly cwd: Effect.Effect<string>;
  readonly head: string;
  readonly now: string;
  readonly base?: string;
  readonly open: ReadonlyArray<Finding>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const changes =
      ask.head === ask.now
        ? "The head has not moved since that round: the fix committed nothing."
        : yield* Activity.make({
            name: ask.name,
            success: Schema.String,
            execute: Effect.flatMap(ask.cwd, (cwd) =>
              host.reviewChanges({
                target: ask.target,
                cwd,
                previous: ask.head,
                head: ask.now,
                base: ask.base,
              }),
            ).pipe(
              Effect.orElseSucceed(
                () =>
                  `The changes since it could not be listed: read \`git diff ${ask.head} ${ask.now}\`.`,
              ),
            ),
          });
    return Arr.join(
      [
        `Previous round's head: ${ask.head}. Review head: ${ask.now}.`,
        changes,
        `Still open after the previous fix, beside those disputed below:\n${formatFindings(ask.open)}`,
        "Check each open and disputed finding against the change, and read the changed files in full. Look beyond them only where the change reaches into code it did not touch or this round's criteria require it.",
      ],
      "\n\n",
    );
  });

const isResolved = (finding: Finding) =>
  finding.status === "fixed" || finding.status === "obsolete";

export const ROUNDS = 4;

type Needs = Run | Agents | Host | WorkflowEngine | WorkflowInstance | FileSystem.FileSystem;

type CheckedBeforeReview = (ask: {
  readonly name: string;
  readonly cwd: string;
  readonly fix: (
    operation: string,
    findings: string,
    open: ReadonlyArray<Finding>,
  ) => Effect.Effect<unknown, WorkflowError, Needs>;
}) => Effect.Effect<
  { readonly halted: string; readonly failed: ReadonlyArray<Finding> } | null,
  WorkflowError,
  Needs
>;

// WARNING: a Run whose features do not say `before_review` started on an earlier release, and runs none.
export const checkedBeforeReview: CheckedBeforeReview = (ask) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    if ((yield* host.place(runId)).features?.before_review !== true) {
      return null;
    }
    for (let attempt = 1; ; attempt++) {
      const failed: ReadonlyArray<Finding> = yield* Activity.make({
        name: `${ask.name}.${attempt}`,
        success: Schema.Array(Schema.Struct({ severity: text, title: text, detail: text })),
        execute: Effect.gen(function* () {
          const marked = Arr.filter(
            yield* host.approved(runId),
            (spec) => spec.before_review === true,
          );
          const ran = yield* Effect.forEach(marked, (spec) =>
            host.verify({ runId, name: spec.name, cwd: ask.cwd }),
          );
          return Arr.map(
            Arr.filter(ran, (one) => one.result !== "pass"),
            (one) => ({
              severity: "blocker",
              title: `check "${one.name}" failed before review`,
              detail: `It was ${one.result} (exit ${one.exit}); read its output with \`collie run read ${runId} verification:${one.id}\`.`,
            }),
          );
        }).pipe(Effect.orDie),
      });
      if (failed.length === 0) {
        return null;
      }
      if (attempt > ROUNDS) {
        return {
          halted: `before_review_failed: ${Arr.join(
            Arr.map(failed, (one) => one.title),
            "; ",
          )}, after ${ROUNDS} fixes`,
          failed,
        };
      }
      yield* ask.fix(`${ask.name}-fix-${attempt}`, formatFindings(failed), failed);
    }
  });

const disputesOf = (findings: ReadonlyArray<Finding>) =>
  Arr.map(
    Arr.filter(findings, isBlocking),
    (one) =>
      `disputed blocking finding: [${one.severity}] ${one.title}${one.file ? ` (${one.file})` : ""}${one.reason ? `: ${one.reason}` : ""}`,
  );

export interface Rallied extends Reviewed {
  readonly halted: string | null;
}

// WARNING: the last fix has no review after it, so its account is judged against the journal, not taken on its word.
export const rally = (ask: {
  readonly rounds: { n: number };
  readonly cwd: string;
  readonly plan: string;
  readonly proves: Effect.Effect<string, never, WorkflowEngine | WorkflowInstance>;
  readonly risks: string;
  readonly criteria: string;
  readonly source?: string | null;
  readonly prefix: string;
  readonly obstacle: string;
  readonly resume?: { readonly previous: Rallied; readonly reviewers: string };
  readonly ledger?: ReadonlyArray<Finding>;
  readonly taken?: ReadonlyArray<string>;
  readonly integrate: (
    operation: string,
  ) => Effect.Effect<Integration & { readonly base: string }, WorkflowError, Needs>;
  readonly fix: (round: {
    readonly operation: string;
    readonly at: number;
    readonly proves: string;
    readonly findings: string;
    readonly open: ReadonlyArray<Finding>;
    // WARNING: "" or absent where the round did not read its head.
    readonly head?: string;
  }) => Effect.Effect<typeof FixOutputSchema.Type, WorkflowError, Needs>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const agents = yield* Agents;
    const runId = (yield* Run).id;
    const { prefix } = ask;
    let disputed: Array<Finding> = [];
    let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;
    const delta =
      ask.resume === undefined && (yield* host.place(runId)).features?.review_delta === true;
    let prior: { readonly head: string; readonly open: ReadonlyArray<Finding> } | null = null;
    let ledger = ask.ledger;

    const repair = Effect.gen(function* () {
      const resumed = ask.resume;
      if (resumed === undefined) {
        return;
      }
      const open = [
        ...Arr.filter(
          resumed.previous.reviewed.findings,
          (one) =>
            !Arr.some(
              resumed.previous.disputes,
              (dispute) => findingKey(dispute) === findingKey(one),
            ),
        ),
        ...resumed.previous.disputes,
      ];
      const fixed = yield* ask.fix({
        operation: `${prefix}fix`,
        at: 1,
        proves: yield* ask.proves,
        findings: formatFindings(open),
        open,
      });
      const settled = new Set(Arr.map([...fixed.fixed, ...fixed.disputed], findingKey));
      disputed = [
        ...Arr.filter(resumed.previous.disputes, (one) => !settled.has(findingKey(one))),
        ...fixed.disputed,
      ];
    });

    for (let at = 1; at <= ROUNDS; at++) {
      ask.rounds.n += 1;
      const ended = yield* reviewRound(
        Effect.gen(function* () {
          yield* repair;
          const merged = yield* ask.integrate(`${prefix}merge-${at}`);
          const proves = yield* ask.proves;
          const unopened = yield* checkedBeforeReview({
            name: `${prefix}before-review-${at}`,
            cwd: ask.cwd,
            fix: (operation, findings, open) => ask.fix({ operation, at, proves, findings, open }),
          });
          if (unopened !== null) {
            return {
              halted: unopened.halted,
              unreviewed: "",
              unsettled: disputesOf(disputed),
              disputes: Arr.filter(disputed, isBlocking),
              reviewed: {
                verdict: "findings" as const,
                summary: unopened.halted,
                findings: unopened.failed,
                disputed: [],
                dropped: [],
                fixed: [],
              },
            };
          }
          const head =
            delta || ledger !== undefined
              ? yield* Activity.make({
                  name: `${prefix}review-head-${at}`,
                  success: Schema.String,
                  execute: host.reviewedHead({ target: "", cwd: ask.cwd }),
                })
              : "";
          const given =
            !delta || prior === null || head === ""
              ? ""
              : yield* followUp({
                  name: `${prefix}review-changes-${at}`,
                  target: "",
                  cwd: Effect.succeed(ask.cwd),
                  head: prior.head,
                  now: head,
                  base: merged.base,
                  open: prior.open,
                });
          const synthesis = yield* reviewPass({
            target: "",
            plan: ask.plan,
            source: ask.source,
            proves,
            previous: "",
            delta: given,
            answered:
              ask.resume !== undefined
                ? agents.outputFor(runId, `${prefix}fix`)
                : at === 1
                  ? ""
                  : agents.outputFor(runId, `${prefix}fix-${at - 1}`),
            prefix,
            ledger,
            stamped: head,
            taken: ask.taken,
            reviewers: ask.resume?.reviewers,
            obstacle: ask.obstacle,
            risks: ask.risks,
            criteria: ask.criteria,
            base: merged.base,
            at,
            of: ask.resume === undefined ? ROUNDS : 1,
            disputed,
          });
          if (ledger !== undefined) {
            ledger = synthesis.findings;
          }
          const unresolved = Arr.filter(synthesis.findings, (one) => !isResolved(one));
          for (const conflict of conflictingDispositions(synthesis)) {
            yield* host.record(runId, `review ${at}: ${conflict}`);
          }
          disputed = remainingDisputes(disputed, synthesis);
          const split = splitDisputed(synthesis.findings, disputed);
          const round = settleRound({
            live: split.live,
            disputed: [...disputed, ...split.settled],
            at,
            seen,
          });
          if (round.go === "halt" && round.halt === "dispute_unresolved") {
            return {
              halted: null,
              unreviewed: "",
              unsettled: disputesOf(round.outstanding),
              disputes: Arr.filter(round.outstanding, isBlocking),
              reviewed: synthesis,
            };
          }
          if (round.go === "halt") {
            return {
              halted: `${round.halt}: ${round.reason}`,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          if (round.go === "clean") {
            // WARNING: nothing blocking is not nothing found; what is left goes to the merge request unfixed.
            if (unresolved.length > 0) {
              yield* host.record(
                runId,
                `carried ${unresolved.length} non-blocking finding(s) unfixed: ${Arr.join(
                  Arr.map(unresolved, (one) => one.title),
                  "; ",
                )}`,
              );
            }
            return {
              halted: null,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          if (ask.resume !== undefined) {
            return {
              halted: `round_unresolved: ${formatFindings(round.live)}`,
              unreviewed: "",
              unsettled: disputesOf(disputed),
              disputes: Arr.filter(disputed, isBlocking),
              reviewed: synthesis,
            };
          }
          seen = { at, keys: round.keys };

          const fixed = yield* ask.fix({
            operation: `${prefix}fix-${at}`,
            at,
            proves,
            findings: formatFindings(round.live),
            open: round.live,
            head,
          });
          const settledNow = new Set(Arr.map([...fixed.fixed, ...fixed.disputed], findingKey));
          disputed = [
            ...Arr.filter(disputed, (one) => !settledNow.has(findingKey(one))),
            ...fixed.disputed,
          ];
          const answered = new Set(Arr.map([...fixed.fixed, ...disputed], findingKey));
          if (head !== "") {
            prior = {
              head,
              open: Arr.filter(unresolved, (one) => !answered.has(findingKey(one))),
            };
          }

          if (at === ROUNDS) {
            const settled = settleFinalFix(round.live, fixed, yield* host.evidence(runId, ask.cwd));
            // WARNING: every round's disputes count, not only this fix's; earlier ones are still the human's to settle.
            if (settled.ok || settled.halt === "dispute_unresolved") {
              yield* leaveOutstanding((yield* host.place(runId)).dir, settled.outstanding);
              return {
                halted: null,
                unreviewed: settled.attestation,
                unsettled: disputesOf(disputed),
                disputes: Arr.filter(disputed, isBlocking),
                reviewed: synthesis,
              };
            }
            return {
              halted: `${settled.halt}: ${Arr.join(settled.reasons, "; ")}`,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          return null;
        }),
        { round: ask.rounds.n },
      );
      if (ended !== null) {
        if (ended.disputes.length > 0) {
          const dir = (yield* host.place(runId)).dir;
          const keys = new Set(Arr.map(ended.disputes, findingKey));
          const onFile = yield* findingsIn(dir);
          yield* leaveOutstanding(dir, [
            ...Arr.filter(onFile, (one) => !keys.has(findingKey(one))),
            ...ended.disputes,
          ]);
        }
        return ended;
      }
    }
    return yield* new WorkflowError({ reason: "the rally ran no rounds at all" });
  });
