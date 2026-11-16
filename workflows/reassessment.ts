import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  Host,
  Run,
  ReassessmentSchema,
  WorkflowError,
  agentWork,
  formatFindings,
  template,
  leaveReview,
  type Finding,
  type MrRead,
  type SynthesisReport,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./reassess.md" with { type: "text" };
import { HEAD_MOVED, MR_ENDED } from "./reviewing.ts";

type Reply = NonNullable<MrRead["replies"]>[number];
const REASSESS = template(markdown, {
  head: Schema.String,
  findings: Schema.String,
  replies: Schema.String,
});

export const repliesTo = (finding: Finding, replies: ReadonlyArray<Reply>, run: string) => {
  const threads = new Set(
    Arr.flatMap(replies, (one) =>
      one.run === run && finding.note && Str.includes(finding.note)(one.body) && one.thread !== null
        ? [one.thread]
        : [],
    ),
  );
  return Arr.filter(
    replies,
    (one) =>
      one.run !== run &&
      ((one.thread !== null && threads.has(one.thread)) ||
        (finding.id !== undefined &&
          new RegExp(`(^|[^\\w-])${RegExp.escape(finding.id)}(?![\\w-])`).test(one.body))),
  );
};

export const formatReplies = (replies: ReadonlyArray<Reply>) =>
  Arr.join(
    Arr.map(
      replies,
      (one) =>
        `${one.run === null ? "human-typed" : `Collie-signed by ${one.run}`} · @${one.author} · ${one.id}\n${one.body}`,
    ),
    "\n\n",
  );

export const reassess = (ask: {
  readonly target: string;
  readonly head: string;
  readonly at: number;
  readonly ledger: ReadonlyArray<Finding>;
  readonly findings: ReadonlyArray<Finding>;
  readonly replies: ReadonlyArray<Reply>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const run = yield* Run;
    const { dir, cwd } = yield* host.place(run.id);
    const judged = yield* agentWork({
      operation: `reassess-${ask.at}`,
      role: "reviewer",
      instructions: REASSESS,
      input: {
        head: ask.head,
        findings: formatFindings(ask.findings),
        replies: formatReplies(ask.replies),
      },
      output: ReassessmentSchema(Arr.map(ask.findings, (one) => one.id!)),
    });
    const findings = Arr.map(ask.ledger, (one): Finding => {
      const found = Arr.findFirst(judged.findings, (next) => next.id === one.id);
      if (found._tag === "None") return one;
      const status = found.value;
      const judgedHere = {
        ...one,
        ...status,
        head: ask.head,
        note: status.status === one.status ? one.note : "",
      };
      return status.status === "disputed" ? { ...judgedHere, rebuttal: status.reason } : judgedHere;
    });
    const review: SynthesisReport = {
      summary: `Reassessed replies at ${ask.head}.`,
      verdict: Arr.some(findings, (one) => one.status === "open" || one.status === "disputed")
        ? "findings"
        : "clean",
      findings,
      disputed: [],
      dropped: [],
      fixed: [],
    };
    yield* leaveReview(dir, review);
    yield* (yield* FileSystem.FileSystem)
      .writeFileString(`${dir}/review-head`, ask.head)
      .pipe(Effect.orDie);
    yield* Activity.make({
      name: `reassess-head-${ask.at}`,
      success: Schema.Void,
      error: WorkflowError,
      execute: Effect.gen(function* () {
        const reading = yield* host.mrReading({ target: ask.target, cwd });
        if (reading.state !== "open")
          return yield* new WorkflowError({ reason: `${MR_ENDED}${reading.state}` });
        if (reading.head !== ask.head)
          return yield* new WorkflowError({ reason: `${HEAD_MOVED} ${ask.head}` });
      }),
    });
    return review;
  });
