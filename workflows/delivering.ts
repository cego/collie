// A reviewed change delivered: Collie's gate over the Run's checks, the merge request, and
// CI's proof of the checks left to it, each with the fixes that settle what it finds.
//
// Shared, like `reviewing.ts`: every workflow that ends in a merge request wants the same
// gate and the same proof, so it is an ordinary function over the caller's prompts, Output
// and outcome kind, not steps one workflow copied from another.

import {
  Agents,
  FixOutputSchema,
  Host,
  Run,
  WorkflowError,
  agentWork,
  baseFailuresOf,
  baselinesOwed,
  checkGapsOf,
  checkProof,
  evidenceGapsOf,
  findingKey,
  findingsIn,
  flakesOf,
  formatFindings,
  isOutcome,
  leaveOutstanding,
  owedLocally,
  recheckOwed,
  renderApproved,
  renderEvidence,
  rerunsOwed,
  reviewGapsOf,
  settledChecks,
  settleFinalFix,
  step,
  stepFailed,
  wholeRunsOwed,
  type Finding,
  type SynthesisReport,
  type Template,
  type Verification,
  type VerifySpec,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";

/** At most four fix rounds at the gate, and four for CI. */
const ROUNDS = 4;

export const Tree = Schema.Struct({ head: Schema.String, fingerprint: Schema.String });

/** A check left to CI whose job failed on the merge request's head, as a CI fix round is told of it. */
const CiFailed = Schema.Struct({
  name: Schema.String,
  job: Schema.String,
  url: Schema.NullOr(Schema.String),
  log: Schema.NullOr(Schema.String),
  unproved: Schema.String,
});

export const gate = step({
  id: "checks",
  title: "Checks",
  description: "Collie runs every check on the tree, and the implementer fixes what they lack.",
  kind: "check",
  produces: "evidence",
});
export const mergeRequest = step({
  id: "merge-request",
  title: "Merge request",
  description: "The implementer pushes the branch and opens its merge request, citing the checks.",
  kind: "agent",
  role: "implementer",
  produces: "merge-request",
});
const ciFix = step({
  id: "ci-fix",
  title: "CI fix",
  description: "The implementer fixes what a CI job failed on the merge request's head.",
  kind: "agent",
  role: "implementer",
});

type Needs = Run | Agents | Host | WorkflowEngine | WorkflowInstance | FileSystem.FileSystem;

/** What every prompt here is given beside its own fields. */
type Told = Readonly<Record<string, Schema.Json>> & {
  readonly inputs: Readonly<Record<string, Schema.Json>> & { readonly outcome: string };
  readonly verify: string;
};

interface Fixing {
  readonly iteration: string;
  readonly max_iterations: string;
  readonly findings: string;
}

interface Opening {
  readonly evidence: string;
  readonly unreviewed: string;
  readonly unsettled: string;
  readonly mr: {
    readonly forge: string;
    readonly noun: string;
    readonly assignee: string;
    readonly template: string;
    readonly issues: string;
    readonly existing: string;
    readonly create: string;
    readonly comment: string;
  };
  readonly target_repo: string;
}

/** What the merge request's agent must report for delivery to count as done. */
interface Opened {
  readonly verdict: "clean" | "findings";
  readonly findings?: ReadonlyArray<Finding>;
  readonly mr_url?: string | null;
  readonly pushed: boolean;
}

/** Where the review before delivery left the change. */
export interface Reviewed {
  /** What the last fix is attested by where no review came after it; empty otherwise. */
  readonly unreviewed: string;
  /** Blocking disputes nobody answered, for the human to settle in the merge request. */
  readonly unsettled: ReadonlyArray<string>;
  /** Those disputes as findings, which stay counted until the human settles them. */
  readonly disputes: ReadonlyArray<Finding>;
  /** The review that decided it, which is the one judgement the gate may read. */
  readonly reviewed: SynthesisReport;
}

export interface Delivery<I extends Told, O extends Opened> {
  readonly cwd: string;
  readonly source: { readonly value: string; readonly kind: string };
  /** The agent that fixes and opens the merge request, and its role. */
  readonly agent: string;
  readonly role: string;
  readonly input: I;
  readonly checksNow: Effect.Effect<string, never, Needs>;
  readonly prompts: {
    readonly fix: Template<I & Fixing>;
    readonly ciFix: Template<I & Fixing>;
    readonly mr: Template<I & Opening>;
  };
  readonly opened: Schema.Codec<O, unknown, never, never>;
  /** The outcome kind as it stands, read inside the gate's Activities. */
  readonly outcome: Effect.Effect<string, never, Needs>;
  /** The same, journaled, as the merge request is told it. */
  readonly outcomeJournaled: Effect.Effect<string, never, Needs>;
  /** The Outputs the outcome is read from, beside the review's `synthesize`. */
  readonly outputs: () => Parameters<typeof evidenceGapsOf>[0]["outputs"];
  readonly tickets: ReadonlyArray<{
    readonly file: string;
    readonly checks: ReadonlyArray<string>;
  }>;
  readonly roots: ReadonlyArray<string>;
  readonly rallied: Reviewed;
  /** What the caller leaves unsettled, listed before what delivery adds. */
  readonly unsettled: ReadonlyArray<string>;
  /** Integrates the default branch before a fresh review. */
  readonly integrate: (operation: string) => Effect.Effect<unknown, WorkflowError, Needs>;
  /**
   * A fresh review of the gate's tree, told where the last gate fix's account is. Prepared
   * once the gate's fixes end, outside the Activity that may run it.
   */
  readonly review: Effect.Effect<
    (answered: string) => Effect.Effect<SynthesisReport, WorkflowError, Needs>,
    WorkflowError,
    Needs
  >;
  /** Run after a gate or CI fix that moved the tree, before readiness is read again. */
  readonly moved?: (fix: {
    readonly pass: "gate" | "ci";
    readonly round: number;
  }) => Effect.Effect<void, WorkflowError, Needs>;
}

/** A fix round that changed nothing and disputed every finding: another would read the same tree. */
const stalledFix = (
  before: typeof Tree.Type | undefined,
  after: typeof Tree.Type | undefined,
  findings: ReadonlyArray<Finding>,
  fixed: typeof FixOutputSchema.Type,
) => {
  const disputed = new Set((fixed.disputed ?? []).map(findingKey));
  return (
    before !== undefined &&
    after?.head === before.head &&
    after.fingerprint === before.fingerprint &&
    (fixed.fixed ?? []).length === 0 &&
    findings.every((one) => disputed.has(findingKey(one)))
  );
};

/**
 * Each check as the gate last spawned it: a grant can change under a Run, and the command
 * the human reads has to be the one that ran.
 */
const spawned = (
  granted: ReadonlyArray<VerifySpec>,
  verifications: ReadonlyArray<Verification>,
): ReadonlyArray<VerifySpec> =>
  granted.map((spec) => {
    const ran = verifications.findLast(
      (one) => one.name === spec.name && one.by === "collie" && one.test === undefined,
    );
    return ran === undefined
      ? spec
      : { ...spec, executable: ran.executable, argv: ran.argv, cwd: ran.cwd };
  });

/** The gate, the merge request and CI's proof, answering with the merge request's URL. */
export const deliver = <I extends Told, O extends Opened>(ask: Delivery<I, O>) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const agents = yield* Agents;
    const runId = (yield* Run).id;
    const { cwd, rallied } = ask;
    const { dir } = yield* host.place(runId);
    const treeNow = Effect.map(host.evidence(runId, cwd), ({ final }) => ({
      head: final.head_sha,
      fingerprint: final.fingerprint,
    }));

    // The gate: Collie's own run of every check, on this tree, and then what this kind of
    // result still has no evidence for. An Output saying the tests pass is a claim; a
    // record in the journal, bound to this tree, is not. Each pass is journaled, so a
    // replay follows the results the merge request will cite rather than a fresh run of
    // checks that may come out differently. The host runs nothing that already passed on
    // this tree.
    let passes = 0;
    let reruns = 0;
    let passed: ReadonlyArray<string> = [];
    const readGaps = Effect.fn("deliver.readGaps")(function* (
      approved: ReadonlyArray<VerifySpec>,
      reviewed: SynthesisReport,
    ) {
      const now = yield* ask.outcome;
      const asked = {
        kind: isOutcome(now) ? now : ("unspecified" as const),
        evidence: yield* host.evidence(runId, cwd),
        approved,
        outputs: { ...ask.outputs(), synthesize: { ...reviewed } },
        reviewed: ["synthesize"],
        roots: ask.roots,
        tickets: ask.tickets,
      };
      return {
        gaps: evidenceGapsOf(asked),
        fixable: checkGapsOf(asked),
        reviewable: reviewGapsOf(asked),
      };
    });
    // Why each pass runs, which every door shows while it does (ADR-0042).
    const gapsNow = Effect.fn("deliver.gapsNow")(function* (
      why: {
        readonly pass: "gate" | "recheck" | "fix";
        readonly round?: number;
      },
      since?: typeof Tree.Type,
    ) {
      passes += 1;
      const pass = yield* Activity.make({
        name: `gate.${passes}`,
        success: Schema.Struct({
          gaps: Schema.Array(Schema.String),
          // A pass journaled before gaps were told apart handed a fix every gap.
          fixable: Schema.optionalKey(Schema.Array(Schema.String)),
          passed: Schema.Array(Schema.String),
          tree: Schema.optionalKey(Tree),
        }),
        execute: Effect.gen(function* () {
          const checks = yield* host.approved(runId);
          const now = [...passed];
          const journal = { ...(yield* host.evidence(runId, cwd)), approved: checks };
          // On a tree a fix left as it was, its records stand: only a check with none runs.
          const unmoved =
            since?.head === journal.final.head_sha &&
            since.fingerprint === journal.final.fingerprint;
          // A failure that named its tests had them run again alone instead.
          const whole = why.pass === "recheck" ? wholeRunsOwed(journal) : null;
          for (const spec of owedLocally(checks)) {
            if (now.includes(spec.name)) continue;
            if (whole !== null && !whole.includes(spec.name)) continue;
            if (unmoved && checkProof(journal, spec.name, "collie").last !== undefined) continue;
            const ran = yield* host.verify({ runId, name: spec.name, cwd, ...why });
            if (ran.result === "pass") now.push(spec.name);
          }
          const { final } = yield* host.evidence(runId, cwd);
          return {
            ...(yield* readGaps(checks, rallied.reviewed)),
            passed: now,
            tree: { head: final.head_sha, fingerprint: final.fingerprint },
          };
        }).pipe(Effect.orDie),
      });
      passed = pass.passed;
      return { gaps: pass.gaps, fixable: pass.fixable ?? pass.gaps, tree: pass.tree };
    });
    // Each test a failed check named, run again alone once on the same tree, and each that
    // still fails run alone at the base: a Flake, or a test that fails there too, is neither
    // a gap nor a pass (ADR-0034, amended 2026-10-15).
    const settleTests = Effect.gen(function* () {
      const approved = yield* host.approved(runId);
      for (const { check, test } of rerunsOwed({
        ...(yield* host.evidence(runId, cwd)),
        approved,
      }))
        yield* host.verify({ runId, name: check, cwd, pass: "rerun", test });
      // A base that cannot be reached exempts nothing.
      for (const { check, test } of baselinesOwed({
        ...(yield* host.evidence(runId, cwd)),
        approved,
      }))
        yield* host
          .verify({ runId, name: check, cwd, at: "default-base", test })
          .pipe(Effect.ignore);
      return approved;
    });
    const settleFailed = Effect.fn("deliver.settleFailed")(function* (gaps: {
      readonly gaps: ReadonlyArray<string>;
      readonly fixable: ReadonlyArray<string>;
      readonly tree?: { readonly head: string; readonly fingerprint: string };
    }) {
      if (gaps.fixable.length === 0) return gaps;
      reruns += 1;
      const reread = yield* Activity.make({
        name: `rerun.${reruns}`,
        success: Schema.Struct({
          gaps: Schema.Array(Schema.String),
          fixable: Schema.Array(Schema.String),
        }),
        execute: settleTests.pipe(
          Effect.flatMap((approved) => readGaps(approved, rallied.reviewed)),
          Effect.orDie,
        ),
      });
      // Neither moves the tree from where the pass before read it.
      return { ...reread, tree: gaps.tree };
    });
    const { unreviewed, stalled } = yield* gate(
      Effect.gen(function* () {
        let gaps = yield* settleFailed(yield* gapsNow({ pass: "gate" }));
        // Once more before a fix, where a failure named no tests: a check that fails and then
        // passes on the same tree is a flake, and a Run that ends on one has proved nothing.
        if (gaps.fixable.length > 0)
          gaps = yield* settleFailed(yield* gapsNow({ pass: "recheck" }));
        // A gate fix lands after the last review, so the merge request says it was not re-reviewed.
        let unreviewed = rallied.unreviewed;
        // The implementer fixes what a check could still prove, bounded like the rally; the
        // human reads what is left in the merge request, before it lands.
        let fixes = 0;
        // A round that changed nothing and disputed every finding: another would check the same tree.
        let stalled: { readonly at: number; readonly disputed: ReadonlyArray<Finding> } | null =
          null;
        for (; gaps.fixable.length > 0 && fixes < ROUNDS && stalled === null; fixes++) {
          const at = fixes + 1;
          const before = gaps.tree;
          passed = [];
          const atBase = baseFailuresOf({
            ...(yield* host.evidence(runId, cwd)),
            approved: yield* host.approved(runId),
          }).map(({ check, name, file }) => `${check}: ${name} (${file})`);
          const findings = gaps.fixable.map((gap) => ({
            severity: "blocker",
            title: gap,
            detail: `Collie read this Run's checks on this tree, and this is what is still unproved.${
              atBase.length === 0
                ? ""
                : ` These also fail where this branch leaves the default branch, so they are not yours to fix: ${atBase.join("; ")}.`
            }`,
          }));
          const fixed = yield* agentWork({
            operation: `gate-fix-${at}`,
            agent: ask.agent,
            role: ask.role,
            pushes: true,
            instructions: ask.prompts.fix,
            input: {
              ...ask.input,
              verify: yield* ask.checksNow,
              iteration: String(at),
              max_iterations: String(ROUNDS),
              findings: formatFindings(findings),
            },
            output: FixOutputSchema,
          });
          if (ask.moved !== undefined) {
            const after = yield* Activity.make({
              name: `gate-tree.${at}`,
              success: Tree,
              execute: treeNow,
            });
            if (after.head !== before?.head || after.fingerprint !== before.fingerprint)
              yield* ask.moved({ pass: "gate", round: at });
          }
          gaps = yield* settleFailed(yield* gapsNow({ pass: "fix", round: at }, before));
          if (stalledFix(before, gaps.tree, findings, fixed))
            stalled = { at, disputed: fixed.disputed ?? [] };
          const settled = settleFinalFix(findings, fixed, yield* host.evidence(runId, cwd));
          unreviewed = [
            unreviewed,
            settled.ok
              ? `gate fix ${at}: ${settled.attestation}`
              : `gate fix ${at}, not re-reviewed: ${settled.reasons.join("; ")}`,
          ]
            .filter((line) => line !== "")
            .join("\n");
        }
        const { final } = yield* host.evidence(runId, cwd);
        const review = yield* ask.review;
        const proofKey = yield* Activity.idempotencyKey(
          Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
            final,
            approved: yield* host.approved(runId),
          }),
        );
        yield* Activity.make({
          name: `proof.${proofKey}`,
          success: Schema.Void,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const approved = yield* host.approved(runId);
            let reviewed = rallied.reviewed;
            const disputed = new Set((stalled?.disputed ?? []).map(findingKey));
            const undisputed = (gap: string) => !disputed.has(findingKey({ title: gap }));
            const reading = Effect.suspend(() => readGaps(approved, reviewed)).pipe(
              Effect.map(({ gaps, fixable, reviewable }) => ({
                gaps: gaps.filter(undisputed),
                fixable: fixable.filter(undisputed),
                reviewable,
              })),
            );
            // A check that failed on this tree is run whole again only where its failures named no
            // tests and it has had no recheck here, or on a resume from the park below; one that is
            // has its named failures run alone too, before any gap is read (ADR-0034, amended
            // 2026-10-19).
            const rely = Effect.fn("deliver.rely")(function* (resumed: boolean) {
              const journal = { ...(yield* host.evidence(runId, cwd)), approved };
              const settled = settledChecks(journal);
              const whole = recheckOwed(journal);
              for (const spec of owedLocally(approved).filter(
                (one) => !settled.includes(one.name),
              )) {
                const proof = checkProof(journal, spec.name, "collie");
                const relied =
                  proof.state === "passed" || resumed || whole.includes(spec.name)
                    ? yield* host.verify({ runId, name: spec.name, cwd, pass: "recheck" })
                    : proof.last;
                if (relied !== undefined)
                  yield* host.record(
                    runId,
                    `proof: ${spec.name} relies on verification ${relied.id}`,
                  );
              }
              yield* settleTests;
            });
            const fs = yield* FileSystem.FileSystem;
            const unprovedPark = `${dir}/proof-parked-unproved`;
            const resumed = yield* fs.exists(unprovedPark).pipe(Effect.orDie);
            yield* rely(resumed);
            if (resumed) yield* fs.remove(unprovedPark).pipe(Effect.orDie);
            if (stalled !== null) {
              const standing = (yield* readGaps(approved, reviewed)).fixable.filter(
                (gap) => !undisputed(gap),
              );
              if (standing.length > 0)
                yield* host.record(
                  runId,
                  `outcome unproved: ${standing.join("; ")}; gate fix ${stalled.at} disputed them and changed nothing`,
                );
            }
            let missing = yield* reading;
            if (missing.fixable.length > 0) {
              yield* fs.writeFileString(unprovedPark, "").pipe(Effect.orDie);
              const why = `Outcome unproved after ${fixes} gate fixes: ${missing.gaps.join("; ")}. Repair the checks, then resume ${runId}.`;
              yield* stepFailed(why);
              yield* host.parked(runId, why);
              return yield* Workflow.suspend(yield* WorkflowInstance);
            }
            const reviewedAgain = missing.reviewable.length > 0;
            if (reviewedAgain) {
              // A fresh review sees what will merge too; checks that passed before a merge
              // prove nothing about the tree after it.
              const checked = (yield* host.evidence(runId, cwd)).final;
              yield* ask.integrate("merge-proof");
              const now = (yield* host.evidence(runId, cwd)).final;
              if (now.head_sha !== checked.head_sha || now.fingerprint !== checked.fingerprint)
                yield* rely(false);
              reviewed = yield* review(
                fixes === 0 ? "" : agents.outputFor(runId, `gate-fix-${fixes}`),
              );
              missing = yield* reading;
            }
            if (missing.gaps.length > 0)
              return yield* new WorkflowError({
                reason: `Outcome ${reviewedAgain ? "still unproved after a fresh review" : "unproved, and no reviewer can change that"}: ${missing.gaps.join("; ")}. Continue with a follow-up Run to repair the work.`,
              });
            yield* host.parked(runId, null);
          }),
        });
        return { unreviewed, stalled };
      }),
    );
    // A dispute the human settles stays counted at its own severity, whatever review wrote last.
    if (rallied.disputes.length > 0) {
      const disputedKeys = new Set(rallied.disputes.map(findingKey));
      const onFile = yield* findingsIn(dir);
      yield* leaveOutstanding(dir, [
        ...onFile.filter((one) => !disputedKeys.has(findingKey(one))),
        ...rallied.disputes,
      ]);
    }
    const checks = yield* host.approved(runId);
    const journal = { ...(yield* host.evidence(runId, cwd)), approved: checks };
    const flakes = flakesOf(journal);
    // Failed before this Run changed anything, and still fails: reported, never passed.
    const preexisting = baseFailuresOf(journal);
    const unsettled = [
      ...ask.unsettled,
      ...rallied.unsettled,
      ...(stalled?.disputed ?? []).map(
        (one) =>
          `${one.title}: gate fix ${stalled!.at} disputed it and changed nothing${one.reason ? `: ${one.reason}` : ""}`,
      ),
      ...flakes.map(
        ({ check, name, file }) =>
          `${check}: ${name} (${file}) failed, then passed when run again alone on the same tree — a Flake, so this Run has not settled it.`,
      ),
      ...preexisting.map(
        ({ check, name, file, at }) =>
          `${check}: ${name} (${file}) also fails at ${at.slice(0, 12)}, where this branch leaves the default branch, so it failed before this Run's changes.`,
      ),
    ];
    if (unsettled.length > 0) yield* host.record(runId, `unsettled: ${unsettled.join("; ")}`);
    const leftToCi = checks.filter((spec) => spec.ci !== undefined);
    const mrUrl = yield* mergeRequest(
      Effect.gen(function* () {
        const ready = yield* host.mr({ cwd, source: ask.source });
        if (!ready.ok) {
          const head = (yield* host.evidence(runId, cwd)).final.head_sha.slice(0, 12);
          const unproved = leftToCi.map(
            (spec) =>
              ` ${spec.name} is left to CI and unproved: job ${spec.ci} on ${head} cannot be read without one.`,
          );
          const reason = `Cannot open the merge request: ${ready.reason}.${unproved.join("")} Repair it, then resume ${runId}.`;
          yield* host.record(runId, reason);
          yield* stepFailed(reason);
          yield* host.parked(runId, reason);
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }

        const settledEvidence = yield* host.evidence(runId, cwd);
        const opened = yield* agentWork({
          operation: "mr",
          agent: ask.agent,
          role: ask.role,
          pushes: true,
          // Not merging: only a message of its own asks for that.
          clears: !ready.branch
            ? []
            : [
                `pushing ${ready.branch} to origin${ready.url === undefined ? "" : ` (${ready.url})`}`,
                `opening or updating its ${ready.noun ?? "merge request"} there`,
              ],
          instructions: ask.prompts.mr,
          input: {
            ...ask.input,
            inputs: { ...ask.input.inputs, outcome: yield* ask.outcomeJournaled },
            verify: renderApproved(spawned(checks, settledEvidence.verifications)),
            // Read after the gate settled, so the merge request cites the passing runs.
            evidence: renderEvidence(settledEvidence),
            unreviewed,
            unsettled: unsettled.map((line) => `- ${line}`).join("\n"),
            mr: {
              forge: ready.forge ?? "GitLab",
              noun: ready.noun ?? "merge request",
              assignee: ready.assignee,
              template: ready.template,
              issues: ready.issues.join(", "),
              existing: ready.existing ?? "",
              create: ready.commands?.create ?? "",
              comment: ready.commands?.comment ?? "",
            },
            // Not read by the shipped content; a fork's may, and `--repo` suits both CLIs.
            target_repo: ready.repository ? `--repo ${ready.repository}` : "",
          },
          output: ask.opened,
        });
        if (
          opened.verdict !== "clean" ||
          !opened.pushed ||
          !opened.mr_url ||
          (opened.findings ?? []).length > 0
        ) {
          const missing = [
            ...(!opened.pushed ? ["the branch was not pushed"] : []),
            ...(!opened.mr_url ? ["no merge request URL was reported"] : []),
            ...(opened.findings ?? []).map((finding) => finding.title),
          ];
          return yield* new WorkflowError({
            reason: `Merge request delivery did not finish: ${missing.join("; ") || opened.verdict}. Continue with a follow-up Run to finish delivery.`,
          });
        }
        yield* host.mergeRequest(runId, opened.mr_url);
        return opened.mr_url;
      }),
    );
    // Each check left to CI is proved by its job on the merge request's head. A failed one
    // is the builder's in a CI fix round, bounded like the gate's; the gate's fix loop stays
    // apart, since what fails, how it is read again and the replay keys all differ.
    const told = (line: string) =>
      Effect.andThen(host.record(runId, line), host.note({ runId, cwd, body: line }));
    let ciFixes = 0;
    // Why a job still failing parks the Run rather than going to another round.
    let blocked: { readonly why: string; readonly unmoved: boolean } | null = null;
    while (leftToCi.length > 0) {
      const read = yield* Activity.make({
        name: `ci-proof.${ciFixes}`,
        success: Schema.Struct({ failed: Schema.Array(CiFailed), tree: Tree }),
        execute: Effect.gen(function* () {
          const unproved: string[] = [];
          const failed: Array<typeof CiFailed.Type> = [];
          for (const spec of leftToCi) {
            const job = spec.ci ?? "";
            const read = yield* host.ciJob({
              runId,
              cwd,
              name: spec.name,
              wait: true,
              // The same job on an unmoved head was compared and retried already.
              settle: blocked?.unmoved !== true,
            });
            if ("proved" in read) {
              if (read.retried === true)
                yield* told(
                  `unsettled: ${spec.name}: job ${job} failed on ${read.proved.end.head_sha.slice(0, 12)}, then passed when retried — a Flake, so this Run has not settled it.`,
                );
            } else if (read.before !== undefined)
              yield* told(
                `unsettled: ${spec.name}: job ${job} also fails at ${read.before.at.slice(0, 12)}, where this branch leaves its target branch, so it failed before this Run's changes.`,
              );
            else if (read.state === "failed")
              failed.push({
                name: spec.name,
                job,
                url: read.url,
                log: read.log,
                unproved: read.unproved,
              });
            else unproved.push(read.unproved);
          }
          if (yield* host.stopRequested(runId))
            return yield* Workflow.suspend(yield* WorkflowInstance);
          const why =
            unproved.length > 0
              ? `Outcome unproved: ${[...unproved, ...failed.map((one) => one.unproved)].join("; ")}`
              : blocked !== null && failed.length > 0
                ? `${blocked.why}: ${failed.map((one) => one.unproved).join("; ")}`
                : null;
          if (why !== null) {
            const reason = `${why}. Repair it, then resume ${runId}.`;
            yield* host.record(runId, reason);
            yield* host.parked(runId, reason);
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }
          yield* host.parked(runId, null);
          return { failed, tree: yield* treeNow };
        }),
      });
      if (read.failed.length === 0) break;
      ciFixes += 1;
      const at = ciFixes;
      const findings = read.failed.map((one) => ({
        severity: "blocker",
        title: `${one.name}: its CI job ${one.job} failed`,
        detail: `On ${read.tree.head.slice(0, 12)}, the merge request's head: ${one.url ?? "the forge gave no URL"}. Its log: ${one.log ?? "the forge gave no command for it"}`,
      }));
      const fixed = yield* ciFix(
        agentWork({
          operation: `ci-fix-${at}`,
          agent: ask.agent,
          role: ask.role,
          pushes: true,
          instructions: ask.prompts.ciFix,
          input: {
            ...ask.input,
            verify: yield* ask.checksNow,
            iteration: String(at),
            max_iterations: String(ROUNDS),
            findings: formatFindings(findings),
          },
          output: FixOutputSchema,
        }),
        { round: at, of: ROUNDS },
      );
      const after = yield* Activity.make({
        name: `ci-tree.${at}`,
        success: Tree,
        execute: treeNow,
      });
      if (stalledFix(read.tree, after, findings, fixed)) {
        const lines = (fixed.disputed ?? []).map(
          (one) =>
            `${one.title}: ci fix ${at} disputed it and changed nothing${one.reason ? `: ${one.reason}` : ""}`,
        );
        yield* Activity.make({
          name: `ci-disputed.${at}`,
          success: Schema.Void,
          execute: told(`outcome unproved: ${lines.join("; ")}`),
        });
        break;
      }
      const settled = settleFinalFix(findings, fixed, yield* host.evidence(runId, cwd));
      yield* Activity.make({
        name: `ci-unreviewed.${at}`,
        success: Schema.Void,
        execute: told(
          `ci fix ${at} landed after the last review and was not re-reviewed: ${
            settled.ok ? settled.attestation : settled.reasons.join("; ")
          }`,
        ),
      });
      if (ask.moved !== undefined && after.head !== read.tree.head)
        yield* ask.moved({ pass: "ci", round: at });
      blocked =
        after.head === read.tree.head
          ? {
              why: `Outcome unproved: ci fix ${at} pushed no new commit: the head is still ${after.head.slice(0, 12)}`,
              unmoved: true,
            }
          : at >= ROUNDS
            ? { why: `Outcome unproved after ${ROUNDS} CI fixes`, unmoved: false }
            : null;
    }
    return mrUrl;
  });
