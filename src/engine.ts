// Executes a Run: one tab per Step, agents started with the right Harness,
// Model and Persona, gates and loops driven by Output files.

import {
  Clock,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ago, nowIso } from "./time";

import type {
  ChoiceDef,
  Definitions,
  ResolvedStep,
  ResolvedWorkflow,
  RoundDef,
  StepRequirement,
  Variant,
} from "./definitions";
import { roundVariant, stepVariants, variantKeys } from "./definitions";
import type { Defaults } from "./config";
import { configValue, readConfig, writeConfigValue } from "./config";
import type { PluginEnv } from "./env";
import type { PickItem } from "./inputs";
import { slugify } from "./template";
import { checkoutFor, repositoryName, runNames } from "./worktree";
import {
  isYamlMap,
  YamlMapSchema,
  YamlValueJsonSchema,
  type YamlMap,
  type YamlValue,
} from "./yaml";
import type { AgentInfo, AgentStatus, Herdr } from "./herdr";
import { HerdrError, herdrFailureReason } from "./herdr";
import { HARNESSES, isPermissionMode, PERMISSION_MODES, personaPrefix, startArgs } from "./harness";
import {
  atBoundary,
  controlDir,
  gateHarnesses,
  installControls,
  withControlLock,
  type CompactionPorts,
  type CompactionSettings,
} from "./compaction";
import { compactionFor, externalSubmissions } from "./compactors";
import {
  findingKey,
  formatFindings,
  isBlocking,
  parseFindings,
  parseFixOutput,
  parseReviewOutput,
  parseSynthesis,
  unsubstantiated,
  renderReview,
  REVIEW_FILE,
  settleFinalFix,
  splitDisputed,
  type Finding,
  type Halt,
  type ReviewOutput,
} from "./output";
import {
  agentName,
  evenRatio,
  GLYPH,
  insertIndexFor,
  paneLabel,
  rankOf,
  runName,
  runTabLabel,
  shellQuote,
  stepLabel,
  collieOwns,
  displayName,
  tabLabelsFor,
  targetLabel,
  reason,
} from "./naming";
import {
  deliverable,
  readRegistry,
  registerAgent,
  registryPath,
  scopeFor,
  type AgentEntry,
} from "./registry";
import {
  classifyWorkSource,
  inferInputs,
  resolveCandidates,
  shell as shellRun,
  targetKind,
  type InputPrompts,
} from "./inputs";
import { fanoutRepos, fanoutUnfinished, RunStore, type FanoutRecord } from "./run";

import { propagate, readIntent, seedIntent, writeIntent, type Intent } from "./intent";
import { withLock } from "./lock";
import {
  alignment,
  appendDrift,
  askJudgement,
  alreadyStood,
  appendElection,
  findingKey as driftFindingKey,
  checkRules,
  correctionCause,
  correctionText,
  correctionsSent,
  decideCorrections,
  flattenOutput,
  judge,
  newReports,
  NOT_JUDGED,
  recordSkipped,
  electionsPath,
  evaluatedFor,
  openReports,
  pendingEvaluation,
  readDrift,
  readElections,
  shouldStand,
  supersededBy,
  type Judged,
  type Judgement,
  type JudgementDeps,
  EXTRA_PASSES,
  staleSince,
} from "./drift";
import { capabilitiesOf } from "./steering-caps";
import {
  fingerprint,
  readVerifications,
  runApproved,
  staleAgainst,
  type Verification,
} from "./verify";
import { approvedFrom, approvedFor, renderApproved, type VerifySpec } from "./verify-spec";
import { appendMetric, obstacleOf, readMetrics, repeatedFailure } from "./metrics";
import {
  endsWithoutPatch,
  evidenceGaps,
  isOutcome,
  renderEvidence,
  type Collected,
  type Outcome,
} from "./outcome";
import {
  appendCard,
  buildCard,
  encodeCheckpoint,
  inspectFor,
  readCards,
  readCheckpoints,
  type Card,
} from "./cards";
import { ensureHomeFor } from "./home";
import { shell } from "./mr";
import { readChoice, readInboxMidStep, type InboxCommandValue } from "./driver";
import * as dispatch from "./dispatcher";
import type { SubmitOutcome } from "./dispatcher";
import {
  appendLine,
  budgetPath,
  causalKey,
  deliveriesOf,
  herdOf,
  ledgerPath,
  newestById,
  overrideActive,
  readLedger,
  textHash,
  type Cause,
} from "./steering";
import {
  pendingFor,
  proposalsPath,
  read as readProposals,
  record as recordProposal,
} from "./proposals";
import { DriftReportSchema, type Ref } from "./evaluator";
import {
  evaluationDeps,
  handOver,
  newRequestId,
  writeInbox,
  postReview,
  resumeRun,
  runSettled,
  runStatus,
} from "./operations";
import { isSingleRepo, orderedTicketsOf, planReposOf, type PlanRepos, type Slice } from "./plan";
import { notify as notifyRun, type NotificationKind } from "./notify";
import {
  gitlabForProject,
  gitlabReadiness,
  mrFacts,
  addMrRole,
  assignedTo,
  glabLogin,
  parseMrUrl,
  resolveAssignee,
  type MrRef,
  type MrRole,
  parseMrTarget,
  repoArgs,
  type MrFacts,
  projectHere,
  type Runner,
} from "./mr";
import { credentials, releaseClaim, waitForHelle } from "./helle";
import {
  askRoute,
  liveRole,
  sendPlanChange,
  sendReview,
  type HandoffResult,
  type Session,
} from "./handoff";
import { renderTemplate, skillMention } from "./template";
import { resolveWorkflow, skillDirs, skillMentions } from "./definitions";
import type { Run, RunRecord, RunStatus, SliceRecord, StepStatus, VariantRecord } from "./run";
import { isString } from "./schema";

export const VIEW_SOURCE_PREFIX = "cego.collie:";

/**
 * Which toast a blocked step has earned, or none. Both kinds fire only after their
 * own recovery has been tried: a repair that worked, or a nudge that was answered, is
 * not worth interrupting anyone for.
 */
function blockedKind(outcome: VariantOutcome): NotificationKind | null {
  if (outcome.record.repairs.length > 0) return "output-unusable";
  // Being nudged is not being given up on: an agent can be nudged once and then block
  // for a human, which is a question, not a quiet step, and has its own toast.
  if (outcome.stuck) return "step-stuck";
  return null;
}

/** Every toast this engine raises: one Run, one settings map, one taxonomy. */
const notify = (
  o: EngineOptions,
  kind: NotificationKind,
  body: string,
  about: { step?: string; subject?: string } = {},
) =>
  notifyRun(o.herdr, o.run, {
    kind,
    body,
    step: about.step ?? null,
    subject: about.subject,
    settings: o.defaults.notifications,
  });

/** How a Choice step reaches the human. The runner pane supplies the picker TUI. */
export type EnginePrompts = InputPrompts<
  Error | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
>;

export interface EngineOptions {
  herdr: Herdr;
  defs: Definitions;
  defaults: Defaults;
  wf: ResolvedWorkflow;
  run: Run;
  env: PluginEnv;
  out: (
    line: string,
  ) => Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem | Path.Path>;
  /** How long to keep waiting for an Output after the agent hands off to the human. */
  handoffTimeoutMs?: number;
  outputPollMs?: number;
  /** Required by any Workflow with a Choice step. */
  prompts?: EnginePrompts;
  /**
   * The harness compaction interfaces, so a test can script one boundary's answers
   * without an installed harness. Absent means the real four.
   */
  compaction?: CompactionPorts;
  /** The fixed five-minute compaction budget, shortened only by a test. */
  compactionWaitMs?: number;
}

/**
 * What this Run knows about compaction that the config file does not: the threshold it
 * was launched with, and the ports and budget a test scripts. Shared with the Session a
 * hand-off carries, so both boundaries answer to the same numbers.
 */
function compactionSettings(o: EngineOptions): CompactionSettings {
  return {
    configured: o.defaults.compactAtTokens,
    ports: o.compaction,
    waitMs: o.compactionWaitMs,
  };
}

/**
 * The shared compaction policy's dependencies, as this Run supplies them. A warning
 * goes to both front doors — the Run's own channel, which the CLI and the board read,
 * and its audit trail — because a compaction nobody can see is one nobody can explain.
 */
function compactionDeps(o: EngineOptions) {
  return compactionFor({
    herdr: o.herdr,
    stateDir: o.env.stateDir,
    configDir: o.env.configDir,
    log: (line) => o.run.log(line),
    warn: (line) => o.out(line).pipe(Effect.andThen(o.run.log(line.trim()))),
    // The one moment a harness says how big an agent's context is, kept as a fact with
    // a time on it: `run metrics` and the detail panel read their peak from here.
    sample: (at, tokens) =>
      Effect.gen(function* () {
        yield* appendMetric(o.run.dir, {
          at: yield* nowIso(),
          kind: "context",
          subject: at.agent,
          value: tokens,
          note: at.step,
        });
      }),
    pollMs: o.outputPollMs,
    known: compactionSettings(o),
  });
}

interface VariantOutcome {
  record: VariantRecord;
  output: YamlValue | null;
  review: ReviewOutput | null;
  /** Set when the Output itself is what went wrong, which one prompt can fix. */
  problem?: string;
  /** True when this agent was given up on for going quiet, not merely nudged. */
  stuck?: boolean;
}

const choiceResult = (result: ChoiceResult): ChoiceResult => result;
const handoffResult = (result: false | HandoffResult, fallback: string): HandoffResult =>
  result || { ok: false, message: fallback };

const runShell: Runner<ChildProcessSpawner.ChildProcessSpawner> = shellRun;

/** What one execution accumulates as it goes: only this process's panes and agents. */
type SkillPaths = ReadonlyMap<string, string>;

/** The review this target already had, or empty strings where it had none. */
interface PreviousReview {
  review: string;
  when: string;
  run: string;
}

interface RunCtx {
  outputs: Map<string, VariantOutcome[]>;
  /** `name → SKILL.md` for every skill this run mentions, resolved once at the start. */
  skills: SkillPaths;
  /** The last review of this target, so this one can say what happened to it. */
  previous: PreviousReview;
  /** Panes this process created; a resumed run's recorded panes are gone. */
  panes: string[];
  ran: Set<string>;
  /** One agent per `agent:` group, so a resumed run still keeps one implementer. */
  groups: Map<string, VariantRecord>;
  viewSource: string;
  /** The Control Plane tab this run asks its questions in, when there is one. */
  /**
   * The Home's tab, where a pending question is put. It may be in another workspace
   * entirely — one Herd has one board — so it is never used to order anything.
   */
  boardTabId: string | null;
  /**
   * A tab in *this* Run's own workspace to order against, or null. Ordering is a local
   * fact about one strip; the board is a Herd-wide one, and conflating them made a Run in
   * one workspace reorder the tabs of another.
   */
  orderAnchorTabId: string | null;
  /**
   * What this process last called each of the run's tabs, so a reconcile that learns
   * nothing new sends no rename. herdr is not asked what a tab is called: the label is
   * this run's own sentence, and the only other writer is a Control Plane computing
   * the same one.
   */
  tabLabels: Map<string, string>;
  /** Tabs a human has renamed, which this run never names again. */
  manualTabs: Set<string>;
  /**
   * The ticket a sliced step is on, and what the slices before it left behind. Null for
   * every step that is not sliced, which is every step of every workflow that has no
   * `each:`.
   */
  slice: { ticket: Slice; progress: string } | null;
  /** A lone default shell pane the workflow was launched from, consumed at most once. */
  launchPane: { paneId: string; tabId: string } | null;
  /** Whether the last pane read failed, so the next failure is not logged twice. */
  paneReadFailed: boolean;
  /** What the inbox has said about this Run since the last time anything looked. */
  steering: Steering;
  /**
   * How far the last Judgement got. Carried rather than re-derived, because it is the
   * difference between `aligned: true` and `unverified`, and a Driver that lost it would
   * report a Run as unverified for no reason other than having been restarted.
   */
  judged: Judged;
  /**
   * Blocking findings a human put back in front of the implementer by resuming a run
   * that stopped on their dispute. Handed to the fix step with the review's findings,
   * and judged with them; cleared once that fix has run.
   */
  reopened: Finding[];
  /** The plan's tickets as this run last read them; only a told step moves it on. */
  tickets: Map<string, string> | null;
}

/**
 * The steering state a Driver carries through a Run. Plain arrays and plain values: the
 * inbox is the only way in, the Driver is the only reader, and anything cleverer would
 * be a second place a Run's state lives.
 */
interface Steering {
  /** Messages for this Run's agents, waiting for the ticket that sends them. */
  deliveries: InboxCommandValue[];
  /** Why the Run is holding, or null. No new work goes out while this is set. */
  held: { reason: string } | null;
  /** The Intent version this Driver has loaded. */
  intentVersion: number;
  /** External submissions already turned into an override, by agent. */
  externals: Map<string, number>;
  /** Progress checkpoints already turned into a card, by file. */
  checkpointed: Set<string>;
}

export const executeRun = Effect.fn("Engine.executeRun")(function* (o: EngineOptions) {
  const { run, wf, out } = o;
  const viewSource = `${VIEW_SOURCE_PREFIX}${run.id}`;
  const ctx: RunCtx = {
    outputs: new Map(),
    skills: yield* resolveSkills(o),
    previous: yield* previousReviewVars(o),
    panes: [],
    ran: new Set(),
    groups: new Map(),
    viewSource,
    boardTabId: null,
    orderAnchorTabId: null,
    tabLabels: new Map(),
    manualTabs: new Set(),
    slice: null,
    launchPane: null,
    paneReadFailed: false,
    steering: {
      deliveries: [],
      held: null,
      intentVersion: 0,
      externals: new Map(),
      checkpointed: new Set(),
    },
    judged: NOT_JUDGED,
    reopened: [],
    tickets: null,
  };

  // Read before any step runs, so an edit during an unwatched one is still a change.
  const issues = yield* planTickets(o);
  if (issues) ctx.tickets = yield* readTickets(issues);

  run.record.status = "running";
  run.record.finished_at = null;
  // A run resumed after a converging loop stopped it: the stop was the loop's verdict
  // on the evidence, and the resume is the human's word to retry the blocked fix. No
  // review is started for it; the fix runs against the review that is already there.
  if (run.record.halt === "no_progress" && run.record.blocking_seen) {
    run.record.blocking_seen = { ...run.record.blocking_seen, iteration: run.record.iteration };
    yield* run.log(
      `resumed after no_progress: fix ${run.record.iteration} runs again against review ${run.record.iteration}'s findings`,
    );
  }
  if (run.record.halt === "dispute_unresolved") {
    ctx.reopened = run.record.disputed.filter(isBlocking);
    run.record.disputed = run.record.disputed.filter((d) => !isBlocking(d));
    yield* run.log(
      `resumed after dispute_unresolved: ${ctx.reopened.length} disputed blocking finding(s) put back in front of the implementer`,
    );
  }
  run.record.halt = null;
  // The tab, the toast and the workspace view all name the run the same way.
  run.record.target_label = runTarget(wf, run.record);
  yield* run.save();

  // Before anything opens. Two different questions, answered separately: which tab a
  // question goes to — the Herd's one Home, which may be in another workspace entirely
  // (ADR-0009) — and which strip this Run's own tabs are ordered in, which is a local
  // fact about the workspace it runs in.
  ctx.boardTabId = yield* homeTabOf(o);
  ctx.launchPane = yield* reusableLaunchPane(o).pipe(
    Effect.catch((e) => o.run.log(`launch pane: ${reason(e)}`).pipe(Effect.as(null))),
  );
  yield* ensureTrusted(o);

  const indexOf = (id: string) => wf.steps.findIndex((s) => s.id === id);
  const repeats = wf.steps
    .map((s, at) =>
      s.repeat
        ? {
            at,
            from: indexOf(s.repeat.from),
            // The gate is `from`; the loop restarts at `back_to`, which may be earlier.
            back: indexOf(s.repeat.back_to ?? s.repeat.from),
            max: s.repeat.max ?? wf.maxIterations,
            converge: s.repeat.converge === true,
          }
        : null,
    )
    .filter((r): r is Repeat => r !== null);

  let index = 0;
  while (index < wf.steps.length) {
    const step = wf.steps[index]!;
    const record = run.step(step.id);

    if (record.status === "done") {
      yield* out(`✓ ${step.id} — already done, skipped`);
      // A converging loop's gate and fix are decisions, not work: a resumed run makes
      // them again from the Outputs on disk, so a done record cannot carry it past a
      // verdict it never reached. Evidence that is gone stops it rather than skipping.
      const decision = repeats.find((r) => r.converge && (r.from === index || r.at === index));
      if (!decision) {
        index += 1;
        continue;
      }
      const reloaded = yield* reloadOutcomes(o, step);
      if (reloaded === null) {
        return yield* halt(
          o,
          ctx,
          viewSource,
          decision,
          "fix_unverified",
          `cannot re-check ${step.id}: its Output is missing or unreadable`,
          run.record.outstanding,
        );
      }
      ctx.outputs.set(step.id, reloaded);
      const next = yield* afterStep(o, ctx, viewSource, repeats, index, reloaded);
      if (next.kind === "finish") return next.status;
      index = next.index;
      continue;
    }

    // A step that needs something this machine or repo does not have is not a
    // failure: it is work that cannot be done here, and the run carries on.
    let extras: YamlMap | undefined;
    if ((step.requires?.length ?? 0) > 0) {
      const unmet = yield* unmetRequirement(o, step.requires!);
      if (step.requires!.includes("gitlab")) {
        // The merge request is the claim, so this is where the claim is checked. Where
        // there is no GitLab the step is skipped and nothing is claimed — the gaps are
        // still recorded, because a human looking at the board should see what this Run
        // did and did not prove, but they stop nothing.
        const gated = yield* evidenceGate(o, ctx, viewSource, repeats, index, unmet === null);
        if (gated !== null) {
          if (gated.kind === "finish") return gated.status;
          index = gated.index;
          continue;
        }
      }
      if (unmet) {
        yield* run.mark(step.id, "done");
        record.note = `skipped: ${unmet}`;
        yield* run.save();
        yield* out(`◦ ${step.id} — skipped: ${unmet}`);
        index += 1;
        continue;
      }
      if (step.requires!.includes("gitlab")) {
        const facts = yield* mrFacts(
          {
            cwd: run.record.cwd,
            inputs: run.record.inputs,
            configuredAssignee: configValue(yield* readConfig(o.env.configDir), "gitlab.assignee"),
          },
          runShell,
        );
        extras = mrVars(facts);
      }
    }

    // Not a skip: a gate blocks, in the runner, until the Run may have what it asked
    // for — so a queue of hours costs wall clock and no model tokens at all.
    if (step.waits?.includes("helle")) {
      const gated = yield* helleGate(o).pipe(Effect.result);
      if (Result.isFailure(gated)) {
        yield* run.mark(step.id, "failed");
        // A gate that fails after it has claimed leaves the Run holding the project,
        // and a failed Run never releases. Name the slug, or the operator is left
        // holding a claim nothing ever told them about.
        const held = run.record.helle;
        record.note = held
          ? `${gated.failure.message} — still holding ${held.slug} in helle`
          : gated.failure.message;
        yield* run.save();
        yield* out(`✗ ${step.id} — ${record.note}`);
        return yield* finish(o, ctx, "failed", viewSource);
      }
    }

    if ((step.choices?.length ?? 0) > 0) {
      yield* run.mark(step.id, "running");
      record.iteration = run.record.iteration;
      record.note = null;
      record.variants = [];
      yield* run.save();
      yield* out(`▶ ${step.id} — over to you`);
      const choiceResult = yield* runChoiceStep(o, step, ctx).pipe(Effect.result);
      if (Result.isFailure(choiceResult)) {
        yield* run.mark(step.id, "failed");
        record.note = herdrFailureReason(choiceResult.failure);
        yield* run.save();
        yield* out(`✗ ${step.id} — ${record.note}`);
        return yield* finish(o, ctx, "failed", viewSource);
      }
      const result: ChoiceResult = choiceResult.success;
      ctx.ran.add(step.id);
      yield* run.mark(step.id, result.status);
      record.note = result.note;
      yield* run.save();
      if (result.status !== "done") {
        // The note where the step wrote one: a fan-out that stopped because a repository
        // failed knows which, and a toast reading "next needs you" for a plan nobody has
        // to answer sends the operator looking for a question that is not there.
        return yield* finish(o, ctx, "blocked", viewSource, result.note ?? `${step.id} needs you`);
      }
      // A chained Run takes over from here, so the parent stops where it is.
      if (result.chained) {
        for (const s of wf.steps.slice(index + 1)) {
          const rec = run.step(s.id);
          if (rec.status === "pending") rec.note = `not run: ${result.note}`;
        }
        yield* run.save();
        return yield* finish(o, ctx, "done", viewSource, result.note ?? undefined);
      }
      index += 1;
      continue;
    }

    // Nothing to fan in: the one review that was written is already the review, and
    // `collect` held it to a synthesis's shape and wrote `review.md` from it. Starting a
    // model here to turn one file into one file is the pass this replaces.
    if (step.fanIn) {
      const source = ctx.outputs.get(step.fanIn) ?? [];
      if (source.length === 1) {
        const note = "skipped: one review, nothing to reconcile";
        yield* run.mark(step.id, "done");
        record.note = note;
        record.iteration = run.record.iteration;
        record.variants = [];
        ctx.outputs.set(step.id, source);
        yield* run.save();
        yield* out(`◦ ${step.id} — ${note}`);
        // Everything the fan-in step did besides run an agent still has to happen: the
        // review is printed where the human is looking, and asking for a review of a
        // merge request still makes whoever asked its reviewer.
        yield* printReview(o);
        yield* claimMrRole(o, parseMrTarget(run.record.inputs.target ?? ""), "reviewer");
        const next = yield* afterStep(o, ctx, viewSource, repeats, index, source);
        if (next.kind === "finish") return next.status;
        index = next.index;
        continue;
      }
    }

    const variants = stepVariants(step, o.defaults);
    const keys = variantKeys(variants);
    yield* run.mark(step.id, "running");
    record.iteration = run.record.iteration;
    // A step that failed and is being tried again must not keep the old note.
    record.note = null;
    yield* run.save();
    yield* out(
      `▶ ${step.id}${variants.length > 1 ? ` (${variants.length} in parallel)` : ""} — iteration ${run.record.iteration}`,
    );

    // A step that builds a plan builds it a ticket at a time, on the same agent, with a
    // few lines of fact between slices rather than one transcript that grows all run.
    if (step.each === "tickets") {
      const sliced = yield* runSlices(o, step, variants, ctx, extras);
      if (sliced !== null) {
        ctx.outputs.set(step.id, sliced.outcomes);
        ctx.ran.add(step.id);
        yield* run.mark(step.id, sliced.blocked ? "blocked" : "done");
        yield* run.save();
        if (sliced.blocked) {
          const why = `${step.id}: ${sliced.blocked}`;
          const announced = yield* notify(o, "output-unusable", why, {
            step: step.id,
            subject: step.id,
          });
          return yield* finish(o, ctx, "blocked", viewSource, why, announced);
        }
        const next = yield* afterStep(o, ctx, viewSource, repeats, index, sliced.outcomes);
        if (next.kind === "finish") return next.status;
        index = next.index;
        continue;
      }
    }

    const stepResult = yield* runStep(o, step, variants, keys, ctx, extras).pipe(Effect.result);
    if (Result.isFailure(stepResult)) {
      yield* run.mark(step.id, "failed");
      record.note = herdrFailureReason(stepResult.failure);
      yield* run.save();
      yield* out(`✗ ${step.id} — ${record.note}`);
      return yield* finish(o, ctx, "failed", viewSource);
    }
    const outcomes: VariantOutcome[] = stepResult.success;
    ctx.ran.add(step.id);
    yield* noteEvidence(o, step.id);

    record.variants = outcomes.map((v) => v.record);
    ctx.outputs.set(step.id, outcomes);

    const blocked = outcomes.filter((v) => v.record.status !== "done");
    yield* run.mark(step.id, blocked.length > 0 ? "blocked" : "done");
    yield* run.save();

    for (const v of outcomes) {
      const mark = v.record.status === "done" ? "✓" : v.record.status === "failed" ? "✗" : "⚠";
      yield* out(`  ${mark} ${v.record.label}${v.record.error ? ` — ${v.record.error}` : ""}`);
    }
    yield* markTab(
      o,
      ctx,
      outcomes.map((v) => v.record),
    );
    // The whole point of a synthesis is that a human can read it here.
    if (step.fanIn) yield* printReview(o);
    // A review of a merge request makes whoever asked for it its reviewer.
    if (step.fanIn && blocked.length === 0)
      yield* claimMrRole(o, parseMrTarget(run.record.inputs.target ?? ""), "reviewer");

    if (blocked.length > 0) {
      // The real reason, not "go and look": an unusable Output is often ten seconds
      // of work for whoever reads the toast, and they cannot know that from "needs you".
      const first = blocked[0]!.record;
      const why = first.error
        ? `${step.id}: ${first.error}${first.repairs.length > 0 ? " (asked once already)" : ""}`
        : `${step.id} needs you`;
      // One interrupt: where the step earns a specific toast, the ending must not
      // announce the same event again under its own key.
      const kind = blockedKind(blocked[0]!);
      // Whether it was *said*, not whether one was chosen: a kind turned off in
      // config must not take the ending's toast down with it and end a run silently.
      const announced = kind
        ? yield* notify(o, kind, why, { step: step.id, subject: step.id })
        : false;
      return yield* finish(o, ctx, "blocked", viewSource, why, announced);
    }

    const next = yield* afterStep(o, ctx, viewSource, repeats, index, outcomes);
    if (next.kind === "finish") return next.status;
    index = next.index;
  }

  return yield* finish(o, ctx, "done", viewSource);
});

interface Repeat {
  at: number;
  from: number;
  back: number;
  max: number;
  /** Only blocking findings drive the loop, and the last fix's own account decides. */
  converge: boolean;
}

type Next = { kind: "next"; index: number } | { kind: "finish"; status: RunStatus };

/**
 * What a step's Outcome decides about where the run goes next: the gate at a loop's
 * `from` step, and the repeat at its own. Separate from running the step so a resumed
 * run can decide again from Outputs it reloaded.
 */
const afterStep = Effect.fn("Engine.afterStep")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  viewSource: string,
  repeats: Repeat[],
  index: number,
  outcomes: VariantOutcome[],
) {
  const { run, wf, out } = o;
  const step = wf.steps[index]!;
  const next = (i: number): Next => ({ kind: "next", index: i });
  const finished = (status: RunStatus): Next => ({ kind: "finish", status });

  const gate = repeats.find((r) => r.from === index);
  if (gate) {
    const verdict = verdictOf(outcomes, run.record.disputed);
    // A reviewer that answered a dispute reopens it: the argument has moved on.
    if (verdict.rebutted.length > 0) {
      const answered = new Set(verdict.rebutted.map(findingKey));
      run.record.disputed = run.record.disputed.filter((d) => !answered.has(findingKey(d)));
      yield* run.save();
      yield* out(`  ${verdict.rebutted.length} disputed finding(s) answered by a reviewer`);
    }
    if (verdict.settled.length > 0) {
      yield* out(
        `  ${verdict.settled.length} finding(s) already disputed — your call, not the loop's`,
      );
    }
    const skipFix = Effect.fn("Engine.skipFix")(function* (note: string) {
      for (const s of wf.steps.slice(index + 1, gate.at + 1)) {
        yield* run.mark(s.id, "done");
        run.step(s.id).note = `skipped: ${note}`;
      }
      yield* run.save();
      return next(gate.at + 1);
    });
    if (!gate.converge) {
      if (verdict.clean) {
        yield* out(`  reviews clean — skipping ${wf.steps[gate.at]!.id}`);
        return yield* skipFix("reviews clean");
      }
      yield* out(`  ${verdict.findings.length} finding(s) to fix`);
    } else {
      if (!verdict.reviewed) {
        return finished(
          yield* halt(
            o,
            ctx,
            viewSource,
            gate,
            "fix_unverified",
            `${step.id} left no review verdict to decide on`,
            run.record.outstanding,
          ),
        );
      }
      const blocking = [...verdict.findings.filter(isBlocking), ...ctx.reopened];
      if (blocking.length === 0) {
        // A dispute the reviewers did not answer settles nothing serious, whether they
        // raised it again or left it out: the human decides it, not the merge request.
        // The record's severities are the reviewers' own — see the fix step below.
        const disputed = run.record.disputed.filter(isBlocking);
        if (disputed.length > 0) {
          return finished(
            yield* halt(
              o,
              ctx,
              viewSource,
              gate,
              "dispute_unresolved",
              `${disputed.length} disputed blocking finding(s) stand unanswered — your call, not the loop's`,
              [...disputed, ...verdict.findings],
            ),
          );
        }
        if (verdict.findings.length === 0) {
          yield* out(`  reviews clean — skipping ${wf.steps[gate.at]!.id}`);
          return yield* skipFix("reviews clean");
        }
        const remain = `${verdict.findings.length} non-blocking finding(s) remain`;
        yield* out(`  nothing blocking — ${remain}, skipping ${wf.steps[gate.at]!.id}`);
        return yield* skipFix(remain);
      }
      // The same blocking set as the last review, by identity rather than by count
      // or line: nothing the fix did reached it, and another round would not either.
      // A finding a reviewer answered a dispute on is the argument moving, not standing.
      const keys = [
        ...new Set(verdict.findings.filter((f) => isBlocking(f) && !f.rebuttal).map(findingKey)),
      ].sort();
      const seen = run.record.blocking_seen;
      if (
        seen &&
        seen.iteration < run.record.iteration &&
        keys.length > 0 &&
        keys.length === seen.keys.length &&
        keys.every((k, i) => k === seen.keys[i])
      ) {
        return finished(
          yield* halt(
            o,
            ctx,
            viewSource,
            gate,
            "no_progress",
            `no progress: review ${run.record.iteration} raised the same ${keys.length} blocking finding(s) as review ${seen.iteration}`,
            verdict.findings,
          ),
        );
      }
      run.record.blocking_seen = { iteration: run.record.iteration, keys };
      yield* run.save();
      yield* out(
        `  ${verdict.findings.length + ctx.reopened.length} finding(s) to fix, ${blocking.length} blocking`,
      );
    }
  }

  const mine = repeats.find((r) => r.at === index);
  if (mine) {
    const from = wf.steps[mine.from]!.id;
    const live = verdictOf(ctx.outputs.get(from) ?? [], run.record.disputed);
    if (mine.converge) {
      // Judged against everything the review raised, not against what is left once
      // this fix's own disputes are taken out: `collect` has already recorded those,
      // and a blocker disputed is a blocker unresolved, not one gone.
      const raised = [
        ...(ctx.outputs.get(from) ?? [])
          .map((v) => v.review)
          .filter((r): r is ReviewOutput => r !== null)
          .flatMap((r) => r.findings),
        ...ctx.reopened,
      ];
      ctx.reopened = [];
      if (raised.length === 0 && !live.reviewed) {
        return finished(
          yield* halt(
            o,
            ctx,
            viewSource,
            mine,
            "fix_unverified",
            `no review verdict from ${from} to check fix ${run.record.iteration} against`,
            run.record.outstanding,
          ),
        );
      }
      // The reviewers' severity is the one a dispute carries from here on: an
      // implementer cannot make a blocker minor by calling it so.
      const severity = new Map(raised.map((f) => [findingKey(f), f.severity]));
      run.record.disputed = run.record.disputed.map((d) => ({
        ...d,
        severity: severity.get(findingKey(d)) ?? d.severity,
      }));
      yield* run.save();
      // The fix's own account: read leniently between reviews, where the next review is
      // the check, and strictly at the end, where nothing else is.
      const raw = outcomes[0]?.output ?? null;
      const fix = parseFixOutput(raw, outcomes[0]?.record.output ?? step.id);
      const blocking = raised.filter(isBlocking);
      if (fix.ok && blocking.length > 0) {
        const disputed = new Set(run.record.disputed.map(findingKey));
        const fixed = new Set(fix.value.fixed.map(findingKey));
        if (blocking.every((f) => disputed.has(findingKey(f)) && !fixed.has(findingKey(f)))) {
          return finished(
            yield* halt(
              o,
              ctx,
              viewSource,
              mine,
              "dispute_unresolved",
              `fix ${run.record.iteration} disputed every blocking finding (${blocking.length}) — your call, not the loop's`,
              raised,
            ),
          );
        }
      }
      if (run.record.iteration >= mine.max) {
        if (!fix.ok) {
          return finished(
            yield* halt(o, ctx, viewSource, mine, "fix_unverified", fix.error, raised),
          );
        }
        // A dispute standing from an earlier round is still a dispute of this fix.
        const own = new Set(fix.value.disputed.map(findingKey));
        const standing = run.record.disputed.filter((d) => !own.has(findingKey(d)));
        const settled = settleFinalFix(
          raised,
          { ...fix.value, disputed: [...fix.value.disputed, ...standing] },
          yield* checkEvidence(o, fix.value.checks),
        );
        if (!settled.ok) {
          return finished(
            yield* halt(
              o,
              ctx,
              viewSource,
              mine,
              settled.halt,
              `last fix not enough: ${settled.reasons.join("; ")}`,
              settled.outstanding,
            ),
          );
        }
        // What the fix reported is what the run reports — not the review before it,
        // which is history now, and not a review either, which the words say.
        run.record.outstanding = settled.outstanding;
        run.record.unreviewed = settled.attestation;
        run.step(step.id).note = settled.attestation;
        yield* run.save();
        yield* out(`  ${settled.attestation}`);
        return next(index + 1);
      }
    }
    if (run.record.iteration < mine.max) {
      run.record.iteration += 1;
      for (const s of wf.steps.slice(mine.back, index + 1)) {
        yield* run.mark(s.id, "pending");
        run.step(s.id).note = null;
      }
      yield* run.save();
      yield* appendMetric(run.dir, {
        at: yield* nowIso(),
        kind: "round",
        subject: wf.steps[mine.back]!.id,
        value: run.record.iteration,
        note: "looping back",
      });
      yield* out(
        `  looping back to ${wf.steps[mine.back]!.id} (iteration ${run.record.iteration})`,
      );
      return next(mine.back);
    }
    // Committing work the reviewers still object to would be worse than stopping.
    run.record.outstanding = live.findings;
    run.step(step.id).note =
      `stopped at max_iterations ${mine.max} with ${live.findings.length} finding(s)`;
    yield* run.save();
    yield* out(`  max_iterations (${mine.max}) reached with ${live.findings.length} finding(s)`);
    return finished(
      yield* finish(o, ctx, "blocked", viewSource, `max_iterations reached with findings`),
    );
  }

  return next(index + 1);
});

/**
 * A converging loop stopping for the human. The loop's own step is what blocks, so a
 * resume runs it again and decides again; the reason is on the record for `attention`
 * and in the note for whoever reads the summary.
 */
const halt = Effect.fn("Engine.halt")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  viewSource: string,
  loop: Repeat,
  why: Halt,
  note: string,
  outstanding: Finding[],
) {
  const id = o.wf.steps[loop.at]!.id;
  yield* appendMetric(o.run.dir, {
    at: yield* nowIso(),
    kind: "halt",
    subject: id,
    value: o.run.record.iteration,
    note: why,
  });
  yield* o.run.mark(id, "blocked");
  o.run.step(id).note = note;
  o.run.record.halt = why;
  o.run.record.outstanding = outstanding;
  o.run.record.unreviewed = null;
  yield* o.run.save();
  yield* o.out(`  ${note}`);
  return yield* finish(o, ctx, "blocked", viewSource, note);
});

/**
 * A done step's Outcomes, read back from the Outputs it recorded. Only what a gate
 * needs — the parsed verdict — with none of `collect`'s side effects; null when any
 * variant's Output is gone or no longer parses.
 */
/** The set this Run may run itself: the Intent's grant, else what was seeded at start. */
const approvedOf = Effect.fn("Engine.approvedOf")(function* (o: EngineOptions) {
  return approvedFor(o.run.record.approved_verifications, yield* intentOf(o));
});

/**
 * Collie's own run of approved commands, now, on this tree. A refusal is recorded as
 * what it is rather than swallowed: a spec that cannot be run is a gap.
 */
const collectApproved = Effect.fn("Engine.collectApproved")(function* (
  o: EngineOptions,
  approved: ReadonlyArray<VerifySpec>,
  specs: ReadonlyArray<VerifySpec> = approved,
) {
  const { run, out } = o;
  for (const spec of specs) {
    const collected = yield* runApproved(
      run.dir,
      { id: run.id, cwd: run.record.cwd, worktree: run.record.worktree?.path ?? null },
      approved,
      spec,
    ).pipe(
      Effect.catchTag("VerifyRefused", (cause) =>
        run.log(`evidence: ${spec.name} refused: ${cause.why}`).pipe(Effect.as(null)),
      ),
      Effect.orDie,
    );
    if (collected !== null) yield* out(`  ${spec.name}: ${collected.result}`);
  }
});

/**
 * What the last fix's checks are read against. A check Collie is allowed to run and that
 * has no passing record on this tree is run now, once, rather than taken on the fix's
 * word — and one it may not run is whatever the agent recorded through the collector.
 */
const checkEvidence = Effect.fn("Engine.checkEvidence")(function* (
  o: EngineOptions,
  checks: ReadonlyArray<{ name: string }>,
) {
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const approved = yield* approvedOf(o);
  const before = yield* verificationsOf(o);
  const now = yield* fingerprint(cwd);
  const fresh = (name: string) =>
    before.some((v) => v.name === name && v.result === "pass" && !staleAgainst(v, now));
  const wanted = new Set(checks.map((check) => check.name));
  const due = approved.filter((spec) => wanted.has(spec.name) && !fresh(spec.name));
  yield* collectApproved(o, approved, due);
  return { verifications: yield* verificationsOf(o), final: yield* fingerprint(cwd) };
});

/**
 * What the Run has proved, checked before the merge request is opened, by the engine and
 * not by an agent. Collie runs the Run's own approved set itself at the tree as it stands
 * — nothing else, and nothing a prompt suggested — then the outcome table says what is
 * still missing.
 *
 * Null means carry on and open it. Otherwise the Run stops with `evidence_missing` and the
 * gaps on the record, or skips the merge request where an investigation legitimately has
 * no patch to open one for.
 */
const evidenceGate = Effect.fn("Engine.evidenceGate")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  viewSource: string,
  repeats: Repeat[],
  index: number,
  /** False where the step will be skipped anyway: record the gaps, stop nothing. */
  blocking: boolean,
) {
  const { run, wf, out } = o;
  const step = wf.steps[index]!;
  const carryOn = (at: number): Next => ({ kind: "next", index: at });
  const stop = (status: RunStatus): Next => ({ kind: "finish", status });
  // Only a workflow that declares an outcome is held to one. A fork with its own last
  // step is not silently given a gate it never asked for.
  if (wf.inputs.outcome === undefined) return null;

  const kind = outcomeOf(run.record.outcome);
  const approved = yield* approvedOf(o);
  const cwd = run.record.worktree?.path ?? run.record.cwd;

  // Collie's own run of every approved command, now, on this tree.
  yield* collectApproved(o, approved);

  // The gate has just collected results of its own, so this is a moment the journal
  // grew: record them, and say whether anything is identifiably in the way.
  yield* noteEvidence(o, step.id);

  const final = yield* fingerprint(cwd);
  const { outputs, reviewed } = outputsOf(o, ctx);
  const got: Collected = {
    verifications: yield* verificationsOf(o),
    final,
    approved,
    outputs,
    reviewed,
    insideRun: (ref) => refInside(o, ref),
    tickets: yield* ticketsOf(o),
  };

  const gaps = evidenceGaps(kind, got);
  run.record.evidence_gaps = gaps;
  yield* run.save();
  yield* appendMetric(run.dir, {
    at: yield* nowIso(),
    kind: "evidence",
    subject: kind,
    value: gaps.length,
    note: gaps.join("; "),
  });
  if (gaps.length > 0 && !blocking) {
    yield* run.log(`evidence gaps (${step.id} will be skipped anyway): ${gaps.join("; ")}`);
    return null;
  }

  if (gaps.length === 0) {
    // An investigation that concluded there is nothing to change has finished, and a
    // merge request would be an invention. Recorded as a skip, not as a failure.
    if (endsWithoutPatch(kind, got)) {
      const note = "skipped: investigation, no patch";
      yield* run.mark(step.id, "done");
      run.step(step.id).note = note;
      yield* run.save();
      yield* out(`◦ ${step.id} — ${note}`);
      return carryOn(index + 1);
    }
    return null;
  }

  const loop = repeats.find((r) => r.at < index) ?? repeats[repeats.length - 1];
  const note = `evidence missing for outcome ${kind}: ${gaps.join("; ")}`;
  if (loop) {
    return stop(
      yield* halt(o, ctx, viewSource, loop, "evidence_missing", note, run.record.outstanding),
    );
  }
  yield* run.mark(step.id, "blocked");
  run.step(step.id).note = note;
  run.record.halt = "evidence_missing";
  yield* run.save();
  yield* out(`  ${note}`);
  return stop(yield* finish(o, ctx, "blocked", viewSource, note));
});

/**
 * The first Output each step produced, and which of those a reviewer wrote.
 *
 * First rather than last because a step's variants are one answer to one question; a
 * later variant is another reviewer's take, not a correction of the first. "A reviewer
 * wrote it" is the same test the engine already uses to decide what a review is: the
 * synthesis, or the sole reviewer whose Output a fan-in would have reconciled.
 */
function outputsOf(o: EngineOptions, ctx: RunCtx) {
  const outputs = new Map<string, YamlValue>();
  const reviewed = new Set<string>();
  for (const [id, variants] of ctx.outputs) {
    for (const variant of variants) {
      if (variant.output !== null && !outputs.has(id)) outputs.set(id, variant.output);
    }
    const step = o.wf.steps.find((other) => other.id === id);
    if (step && (step.fanIn || soleReview(o, step))) reviewed.add(id);
  }
  return { outputs, reviewed };
}

/**
 * Every verification this Run has collected since the last time this looked, written to
 * the metrics journal, and the obstacle a repeated identical failure is.
 *
 * Called where a step has just produced something, because that is when the journal has
 * grown. It records; it never stops the Run. A command failing three times the same way
 * is a Run going round, and what that earns is a sentence the next prompt gets — not a
 * halt, which would be a limit nobody asked for.
 */
const noteEvidence = Effect.fn("Engine.noteEvidence")(function* (o: EngineOptions, step: string) {
  const records = yield* verificationsOf(o);
  const seen = yield* readMetrics(o.run.dir);
  const already = new Set(
    seen.filter((line) => line.kind === "verification").map((line) => line.subject),
  );
  for (const record of records) {
    if (already.has(record.id)) continue;
    yield* appendMetric(o.run.dir, {
      at: record.at,
      kind: "verification",
      subject: record.id,
      value: record.by === "collie" ? 1 : 0,
      note: record.result,
    });
  }

  const found = repeatedFailure(records, REPEATED_FAILURE);
  const obstacle = found === null ? null : obstacleOf(found);
  if (obstacle !== null && obstacle !== o.run.record.obstacle) {
    o.run.record.obstacle = obstacle;
    yield* o.run.save();
    yield* appendMetric(o.run.dir, {
      at: yield* nowIso(),
      kind: "checkpoint",
      subject: step,
      value: found!.times,
      note: obstacle,
    });
    yield* o.out(`  ⚠ ${obstacle}`);
  }
  // Cleared the moment it stops repeating: an obstacle that outlived its cause would
  // send the next prompt after a problem that is already gone.
  if (obstacle === null && o.run.record.obstacle !== null) {
    o.run.record.obstacle = null;
    yield* o.run.save();
  }
});

/**
 * How many identical failures of one command count as going round rather than working
 * through it. A proposal, not a user decision — and what it produces is a sentence, so
 * being wrong about the number costs a paragraph in a prompt rather than a stopped Run.
 */
const REPEATED_FAILURE = 3;

/**
 * A `plan` or `review` Run has an outcome it never chose and no merge request to gate, so
 * its row of the table is read here, once, when it has finished: what it left undone is
 * on the record for the board and `run show`, as a gated Run's gaps are. Recorded, not
 * halted — the human's Choice already closed the Run, and a plan that wrote no tickets is
 * a fact about it rather than a reason to stop it again.
 */
const recordFixedKindEvidence = Effect.fn("Engine.recordFixedKindEvidence")(function* (
  o: EngineOptions,
  ctx: RunCtx,
) {
  const kind = outcomeOf(o.run.record.outcome);
  if (kind !== "plan" && kind !== "review") return;
  const { outputs, reviewed } = outputsOf(o, ctx);
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const gaps = evidenceGaps(kind, {
    verifications: yield* verificationsOf(o),
    final: yield* fingerprint(cwd),
    approved: [],
    outputs,
    reviewed,
    insideRun: (ref) => refInside(o, ref),
    tickets: [],
  });
  o.run.record.evidence_gaps = gaps;
  yield* appendMetric(o.run.dir, {
    at: yield* nowIso(),
    kind: "evidence",
    subject: kind,
    value: gaps.length,
    note: gaps.join("; "),
  });
  if (gaps.length > 0) yield* o.run.log(`evidence gaps: ${gaps.join("; ")}`);
});

/**
 * The tickets this Run built from: the plan directory it was given, or the one its agent
 * wrote under the Run for a text, Linear, review or follow-up source. A source with no
 * tickets is no tickets, not a failure.
 */
const ticketsOf = Effect.fn("Engine.ticketsOf")(function* (o: EngineOptions) {
  const path = yield* Path.Path;
  const { inputs } = o.run.record;
  const planDir =
    (inputs.plan_kind ?? "") === "plan-dir" && (inputs.plan ?? "") !== ""
      ? inputs.plan!
      : path.join(o.run.dir, "plan");
  return yield* orderedTicketsOf(planDir, inputs.repo ?? "").pipe(
    Effect.catch(() => Effect.succeed([])),
  );
});

/** A Run's outcome kind, with an unrecorded or unknown one read as `unspecified`. */
function outcomeOf(recorded: string | null): Outcome {
  const value = (recorded ?? "").trim();
  return value !== "" && isOutcome(value) ? value : "unspecified";
}

/**
 * Whether a reference an agent wrote points inside this Run's own directory or checkout.
 * Lexical, and deliberately so: this decides whether a conclusion's evidence is evidence,
 * and a path that escapes with `..` is refused rather than resolved for it.
 */
function refInside(o: EngineOptions, ref: string): boolean {
  const value = ref.trim();
  if (value === "" || value.includes("..")) return false;
  if (!value.startsWith("/")) return true;
  const roots = [o.run.dir, o.run.record.cwd, o.run.record.worktree?.path ?? ""];
  return roots.some((root) => root !== "" && (value === root || value.startsWith(`${root}/`)));
}

const reloadOutcomes = Effect.fn("Engine.reloadOutcomes")(function* (
  o: EngineOptions,
  step: ResolvedStep,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const outcomes: VariantOutcome[] = [];
  // A fan-in that was skipped because there was only one review ran no agent of its own,
  // so its verdict is the review's Output. Without this a resumed Run would find the gate
  // step with no variants to reload and stop as if the evidence were gone.
  const own = o.run.step(step.id).variants;
  const variants = step.fanIn && own.length === 0 ? o.run.step(step.fanIn).variants : own;
  for (const record of variants) {
    if (!record.output) return null;
    const text = yield* fs
      .readFileString(pathService.join(o.run.dir, record.output))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (text === null) return null;
    let output: YamlValue;
    try {
      output = Schema.decodeUnknownSync(YamlValueJsonSchema)(text);
    } catch {
      return null;
    }
    let review: ReviewOutput | null = null;
    if (step.fanIn) {
      const parsed = parseSynthesis(text, record.output);
      if (!parsed.ok) return null;
      review = parsed.value;
    } else if (isYamlMap(output) && "verdict" in output) {
      const parsed = parseReviewOutput(text, record.output);
      if (!parsed.ok) return null;
      review = parsed.value;
    }
    outcomes.push({ record, output, review });
  }
  return outcomes.length > 0 ? outcomes : null;
});

/**
 * One ticket at a time, on one agent, in an order the plan's own `Blocked by` lines allow.
 *
 * The point is the hand-off, not the parallelism: one prompt that carries a whole plan
 * grows a transcript for the length of the run (the steering Run reached 552k tokens
 * before its first compaction), and every later ticket is built by an agent re-reading
 * work it did hours ago. A slice gets its ticket, and a few lines of fact about the ones
 * before it — their commits and their verifications, never their prompts.
 *
 * Null where this Run has no plan to slice: one ticket, or a work source that is a
 * sentence rather than a directory. Then the step runs once, exactly as it always did.
 */
const runSlices = Effect.fn("Engine.runSlices")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  variants: Variant[],
  ctx: RunCtx,
  extras: YamlMap | undefined,
) {
  const { run, out } = o;
  const source = run.record.inputs.plan ?? "";
  if ((run.record.inputs.plan_kind ?? "") !== "plan-dir" || source === "") return null;
  const tickets = yield* orderedTicketsOf(source, run.record.inputs.repo ?? "").pipe(
    Effect.catch(() => Effect.succeed([])),
  );
  // One ticket is not a plan to slice: the hand-off would be empty and the loop would be
  // a longer way of writing what the step already does.
  if (tickets.length < 2) return null;

  const record = run.step(step.id);
  const outcomes: VariantOutcome[] = [];
  let blocked: string | null = null;

  yield* out(`  ${tickets.length} tickets, one at a time`);
  for (const ticket of tickets) {
    const already = record.slices.find((entry) => entry.ticket === ticket.file);
    if (already?.status === "done") {
      yield* out(`  ✓ ${ticket.file} — already done, skipped`);
      continue;
    }
    const slice: SliceRecord = already ?? {
      ticket: ticket.file,
      title: ticket.title,
      status: "pending",
      output: null,
      started_at: null,
      finished_at: null,
      commits: [],
      head: null,
      verifications: [],
    };
    if (!already) record.slices.push(slice);
    slice.status = "running";
    slice.started_at = yield* nowIso();
    yield* run.save();
    yield* writeCheckpoint(o, slice, []);

    ctx.slice = { ticket, progress: renderProgress(record.slices, ticket.file) };
    yield* out(`  ▶ ${ticket.file} — ${ticket.title}`);
    // The slice's number keys its directory, so every slice keeps its own prompt and
    // Output under the step rather than overwriting the one before it.
    const result = yield* runStep(o, step, variants, [ticket.number], ctx, extras).pipe(
      Effect.result,
    );
    ctx.slice = null;
    slice.finished_at = yield* nowIso();

    if (Result.isFailure(result)) {
      slice.status = "failed";
      blocked = `${ticket.file}: ${herdrFailureReason(result.failure)}`;
      yield* run.save();
      break;
    }
    const [outcome] = result.success;
    if (outcome === undefined) {
      slice.status = "failed";
      blocked = `${ticket.file}: the slice produced no Outcome`;
      yield* run.save();
      break;
    }
    outcomes.push(outcome);
    // One agent for the whole plan: the next slice continues this one rather than
    // starting a process that has to read its way back in. `runStep` reuses the step's
    // recorded variant once the step counts as having run in this process.
    record.variants = [outcome.record];
    ctx.ran.add(step.id);
    slice.output = outcome.record.output;
    slice.status = outcome.record.status === "done" ? "done" : "blocked";
    const since = lastHead(record.slices, ticket.file);
    slice.head = yield* headOf(o);
    slice.commits = yield* commitsSince(o, since, slice.head);
    slice.verifications = verifiedDuring(yield* verificationsOf(o), slice);
    yield* run.save();
    yield* writeCheckpoint(o, slice, claimsOf(outcome.output, ticket.title));
    yield* appendMetric(run.dir, {
      at: slice.finished_at,
      kind: "slice",
      subject: slice.ticket,
      value: slice.commits.length,
      note: slice.status,
    });
    yield* noteEvidence(o, step.id);

    if (slice.status !== "done") {
      // A ticket that did not land stops the plan here: the next one is written against
      // work that is not there, and building it would be building on nothing.
      blocked = `${ticket.file}: ${outcome.record.error ?? "the slice needs a human"}`;
      break;
    }
  }
  return { outcomes, blocked };
});

/**
 * The slice's checkpoint under `steering/progress/`, in the shape an agent writes its own
 * and the cards read: `started` when the ticket is handed over, its status when it ends.
 * Collie writes it so a slice landing is a card whether or not the agent remembered to;
 * the same file name as the prompt asks the agent for, so the two are one checkpoint.
 */
const writeCheckpoint = Effect.fn("Engine.writeCheckpoint")(function* (
  o: EngineOptions,
  slice: SliceRecord,
  claims: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(o.run.dir, "steering", "progress");
  yield* fs.makeDirectory(dir, { recursive: true });
  const file = path.join(dir, `${slice.ticket.replace(/\.md$/, "")}.json`);
  // A slice that did not land is not a checkpoint anyone should read as one: the record
  // says it is blocked or failed, and a `done` that is not done would be a card.
  if (slice.status !== "done" && slice.status !== "running") return;
  yield* fs.writeFileString(
    file,
    encodeCheckpoint({
      ticket: slice.ticket,
      status: slice.status === "done" ? "done" : "started",
      claims: [...claims],
      at: yield* nowIso(),
    }),
  );
});

/** What the slice's Output claims it built, or the ticket's own name where it named nothing. */
function claimsOf(output: YamlValue | null, title: string): string[] {
  const done = isYamlMap(output) ? output.tickets_done : undefined;
  const named = Array.isArray(done) ? done.filter(isString) : [];
  return named.length > 0 ? named : [title];
}

/** What the slices before this one left behind: their tickets, commits and evidence. */
function renderProgress(slices: ReadonlyArray<SliceRecord>, upTo: string): string {
  const before = slices.slice(
    0,
    slices.findIndex((entry) => entry.ticket === upTo),
  );
  const done = before.filter((entry) => entry.status === "done");
  if (done.length === 0) return "(this is the first ticket)";
  return done
    .map((entry) => {
      const commits =
        entry.commits.length === 0
          ? "    (no commit)"
          : entry.commits.map((subject) => `    ${subject}`).join("\n");
      const verified =
        entry.verifications.length === 0
          ? "    verified: nothing"
          : `    verified: ${entry.verifications.join(", ")}`;
      return `- ${entry.ticket} — ${entry.title}\n${commits}\n${verified}`;
    })
    .join("\n");
}

/**
 * What was collected while a slice ran, by name and result, newest result per name. The
 * facts a hand-off carries about evidence: not the records, and never the output.
 */
function verifiedDuring(
  verifications: ReadonlyArray<Verification>,
  slice: { started_at: string | null; finished_at: string | null },
): string[] {
  const from = slice.started_at === null ? Number.NEGATIVE_INFINITY : Date.parse(slice.started_at);
  const to = slice.finished_at === null ? Number.POSITIVE_INFINITY : Date.parse(slice.finished_at);
  const latest = new Map<string, string>();
  for (const v of verifications) {
    const at = Date.parse(v.at);
    if (Number.isNaN(at) || at < from || at > to) continue;
    latest.set(v.name, v.result);
  }
  return [...latest].map(([name, result]) => `${name}: ${result}`);
}

/** The HEAD the slice before this one left, or empty where this is the first. */
function lastHead(slices: ReadonlyArray<SliceRecord>, upTo: string): string {
  const at = slices.findIndex((entry) => entry.ticket === upTo);
  for (let i = at - 1; i >= 0; i--) {
    const head = slices[i]!.head;
    if (head) return head;
  }
  return "";
}

const headOf = Effect.fn("Engine.headOf")(function* (o: EngineOptions) {
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const done = yield* shellRun("git", ["rev-parse", "HEAD"], cwd).pipe(
    Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })),
  );
  return done.code === 0 ? done.stdout.trim() : null;
});

/** Subjects only. A hand-off says what was done, not how much was written to do it. */
const commitsSince = Effect.fn("Engine.commitsSince")(function* (
  o: EngineOptions,
  since: string,
  head: string | null,
) {
  if (since === "" || head === null) return [];
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const done = yield* shellRun("git", ["log", "--format=%s", `${since}..${head}`], cwd).pipe(
    Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })),
  );
  if (done.code !== 0) return [];
  return done.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 20);
});

const runStep = Effect.fn("Engine.runStep")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  variants: Variant[],
  keys: (string | null)[],
  ctx: RunCtx,
  extraVars?: YamlMap,
) {
  const { herdr, run } = o;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // A step that has not run in this process gets fresh agents: a resumed Run
  // never reattaches, and the recorded panes may not exist any more.
  const previous = ctx.ran.has(step.id) ? run.step(step.id).variants : [];
  const fanIn = fanInPane(step, ctx);
  const records: VariantRecord[] = [];
  // Before any tab is created: the contract is that a mode Collie cannot resolve fails
  // before one opens, and a chained Run and a resumed Driver get here unvalidated.
  const modes = yield* Effect.forEach(variants, (variant) =>
    permissionMode(step, variant, o.defaults),
  );
  // Which agents this step keeps and which it starts, before it starts any of them:
  // the compaction gate is about the launches, and a harness Collie cannot manage has
  // to stop the step here rather than leave an empty tab behind.
  const priors = variants.map((_, i) => previous[i] ?? borrowedAgent(o, step, ctx));
  const reuses = priors.map((prior) => prior !== null && !step.fresh);
  yield* gateCompaction(
    o,
    step,
    variants.flatMap((variant, i) => (reuses[i] ? [] : [variant.harness])),
  );

  // Start (or reuse) every agent first, then prompt them all, so they work at once.
  for (const [i, variant] of variants.entries()) {
    const key = keys[i]!;
    const label = stepLabel(run.record.slug, step.id, key);
    const prior = priors[i]!;
    const reuse = reuses[i]!;
    const record: VariantRecord = {
      // A step that keeps an earlier agent runs on that agent's model, whatever its
      // own says: recording its own would name a model this step never ran on.
      harness: reuse ? prior!.harness : variant.harness,
      model: reuse ? prior!.model : variant.model,
      effort: (reuse ? prior!.effort : variant.effort) ?? null,
      // A continuation whose agent is gone — a Driver resumed after the head died —
      // starts a new process, and its own mode is unset, so it would otherwise open in
      // the Run default. The mode its chain was opened in is on the record.
      permissions: reuse ? prior!.permissions : (chainMode(o, step) ?? modes[i]!),
      agent: prior?.agent ?? agentName(run.record.slug, step.id, key, run.record.seq),
      label: prior?.label ?? label,
      tabId: prior?.tabId ?? null,
      paneId: prior?.paneId ?? null,
      status: "running",
      output: null,
      error: null,
      repairs: [],
      nudges: 0,
    };
    if (reuse && prior?.incarnation) record.incarnation = prior.incarnation;

    // A pane says only what its tab cannot; a lone pane in its own tab says nothing.
    const paneName = paneLabel(variant, step.id, variants.length, !!step.fanIn);
    if (reuse) {
      // An `agent:` step opens nothing, and renames nothing: the pane it inherited
      // is alone in its tab, and the tab already names the run.
      if (paneName && record.paneId && (yield* paneIsOurs(o, record.paneId)))
        yield* herdr.paneRename(record.paneId, paneName);
      if (record.tabId) yield* renameTab(o, ctx, record.tabId, runTab(o, GLYPH.running));
    } else {
      // Before any pane exists, because a harness Collie manages but cannot talk to
      // fails the step rather than leaving an agent unmanaged — and an endpoint that
      // never came up would otherwise fail it with an empty tab already open in the
      // human's session, which is the thing the gate exists to avoid.
      yield* withControlLock(
        o.env.stateDir,
        record.agent,
        Effect.gen(function* () {
          const controls = yield* installControls(yield* compactionDeps(o), {
            agent: record.agent,
            harness: variant.harness,
            cwd: run.record.cwd,
          });
          if (prior?.paneId) {
            // fresh: replace the pane so `agent start` sees a shell prompt again. The
            // replacement inherits the slot, so the step keeps its tab across iterations.
            const replacement = yield* herdr.paneSplit({
              paneId: prior.paneId,
              direction: "right",
              cwd: run.record.cwd,
            });
            yield* herdr.paneClose(prior.paneId);
            record.paneId = replacement;
            record.tabId = prior.tabId;
          } else if (i === 0 && fanIn) {
            // A fan-in step belongs with the Outputs it reconciles: under the last of
            // them, in their tab. A third column would only make all three unreadable.
            const source = fanIn;
            record.paneId = yield* herdr.paneSplit({
              paneId: source.paneId!,
              direction: "down",
              ratio: 0.5,
              cwd: run.record.cwd,
            });
            record.tabId = source.tabId;
          } else if (i > 0) {
            // Variants of one step sit side by side in that step's tab, evenly.
            record.paneId = yield* herdr.paneSplit({
              paneId: records[i - 1]!.paneId!,
              direction: "right",
              ratio: evenRatio(i, variants.length),
              cwd: run.record.cwd,
            });
            record.tabId = records[i - 1]!.tabId;
          } else if (ctx.launchPane) {
            record.paneId = ctx.launchPane.paneId;
            record.tabId = ctx.launchPane.tabId;
            ctx.launchPane = null;
          } else {
            const label = runTab(o, GLYPH.running);
            const tab = yield* herdr.tabCreate({ label, cwd: run.record.cwd });
            record.tabId = tab.tabId;
            record.paneId = tab.paneId;
            ctx.tabLabels.set(tab.tabId, label);
            yield* placeTab(o, ctx, tab.tabId);
          }
          if (record.tabId) yield* renameTab(o, ctx, record.tabId, runTab(o, GLYPH.running));
          if (paneName && record.paneId) yield* herdr.paneRename(record.paneId, paneName);

          // herdr 0.7.5 ignores --cwd on tab create and pane split, so cd explicitly.
          if (record.paneId)
            yield* herdr.paneRun(record.paneId, `cd ${shellQuote(run.record.cwd)}`);

          const adapter = HARNESSES[variant.harness]!;
          // The recorded mode wins where there is one — that is the chain's — and anything a
          // record cannot vouch for falls back to the mode resolved for this step.
          const recorded = record.permissions ?? undefined;
          const permissions = isPermissionMode(recorded) ? recorded : modes[i]!;
          // The controls are extra arguments to the same launch, so the agent keeps the
          // ordinary interactive interface in its pane.
          yield* startAgent(o, step, {
            name: record.agent,
            kind: adapter.kind,
            paneId: record.paneId!,
            args: [
              ...startArgs(
                adapter,
                variant.model,
                yield* personaFile(o, step, variant.harness, ctx.skills),
                variant.effort,
                permissions,
              ),
              ...controls,
            ],
          });
          // Recorded so a transcript full of prompts — or free of them — can be explained.
          yield* run.log(`${record.agent}: permissions ${permissions}`);
          if (record.paneId) {
            ctx.panes.push(record.paneId);
            yield* setView(o, ctx.viewSource, ctx.panes);
            // A group's first agent outlives its step, so the Session may hand it work.
            if (groupHead(o.wf, step.id)) yield* register(o, step, record);
          }
          // The first step of an `agent:` group lends its agent to the rest of it.
          if (step.agent && !ctx.groups.has(step.agent)) ctx.groups.set(step.agent, record);
        }),
      );
    }

    records.push(record);
  }

  // Recorded as soon as they exist, not when the step ends: the Control Plane reads
  // its agents out of the run record, and a step that is still working — or one that
  // failed on its way — would otherwise have started agents nothing knows about.
  // Appended, because a Choice step's rounds accumulate here across the whole step.
  const recorded = run.step(step.id).variants;
  for (const record of records) if (!recorded.includes(record)) recorded.push(record);
  yield* run.save();

  // Only when a body asks: this costs herdr a round trip, and most steps do not.
  const vars = /\{\{\s*session\./.test(`${step.preamble}\n${step.prompt}`)
    ? { ...extraVars, session: { ask: yield* askRoute(sessionOf(o)) } }
    : extraVars;

  // The work boundary for every agent this step reuses, resolved together and before
  // the prompts go out. Together, because each one can wait out a whole compaction and
  // a fan-out step's variants would otherwise compact one after another — the same
  // argument the watch loop below makes for its own phase. A freshly started agent has
  // no previous work behind it, so its first work is never held up by a threshold check.
  //
  // Set where a reused agent's compaction is still unresolved: no prompt goes out for
  // it, and the step ends blocked with that reason — the Run's existing way of
  // stopping for the human, in both front doors, rather than a second control plane.
  // The work boundary is where steering reaches a Run that is between pieces of work:
  // a hold takes effect here rather than mid-turn, and a message composed into the next
  // prompt has to arrive before the prompt is built.
  yield* takeSteering(o, ctx);
  yield* holdUntilReleased(o, ctx);
  yield* checkDrift(o, ctx, `boundary before ${step.id}`, "boundary");
  yield* standForElection(o, `boundary before ${step.id}`);

  const boundaryDeps = yield* compactionDeps(o);
  // One Dispatcher transaction per agent, holding its ledger lock across the compaction
  // decision, the composition of anything steering has queued for it, and the send —
  // so nothing else can slip a message into that pane between the three. Concurrent
  // across agents, as the boundary already was: the locks are per incarnation.
  //
  // The compaction decisions run together — each one can wait out a whole compaction, and
  // a fan-out step's variants must not do that one after another — but the sends go out in
  // the order the step declares its variants. A latch per variant buys both: the
  // transaction stays open across boundary, composition and send, and a log still reads
  // in the order a human would expect.
  //
  // What comes back per variant is why it was not given its work: a compaction of its
  // own still in the air, or a prompt that could not be delivered. One variant's problem
  // must not abandon the others, which are working.
  const sendTurn = yield* Effect.forEach(records, () => Deferred.make<void>());
  // The incarnation each prompt went to, so its delivery can be settled once the work
  // it asked for has been collected.
  const entries: (AgentEntry | undefined)[] = [];
  const withheld = yield* Effect.forEach(
    records,
    (record, i) =>
      Effect.gen(function* () {
        const variant = variants[i]!;
        const key = keys[i]!;
        // A multi-line prompt cannot be typed into a harness reliably, so the prompt
        // goes to a file in the run dir and the agent is pointed at it.
        const path = pathService.join(
          yield* run.stepDir(step.id, key),
          `prompt-${run.record.iteration}.md`,
        );
        const addressed = yield* agentEntry(o, record, step.persona ?? step.id);
        const entry = addressed.entry;
        if (entry === null) {
          yield* o.out(`  ⏸ ${addressed.reason}`);
          yield* run.log(addressed.reason);
          return addressed.reason;
        }
        entries[i] = entry;
        return yield* dispatch
          .transaction(dispatcherDeps(o), entry, (channel) =>
            Effect.gen(function* () {
              // Held by a compaction of its own that is still in the air: the prompt file
              // is written, because the step is resumable, but nothing is sent. The
              // variant's own error is how a blocked step already reaches a human — the
              // board draws the waiting glyph, the ending raises `needs-you` with this
              // reason, and `run resume` picks the Run back up. Not `awaiting`: that says
              // a Run is still going.
              const boundary = reuses[i]
                ? yield* atBoundary(
                    boundaryDeps,
                    { agent: record.agent, run: run.id, step: step.id },
                    channel,
                  )
                : { dispatch: true as const };
              const previous = sendTurn[i - 1];
              if (previous) yield* Deferred.await(previous);
              // Written whichever way the boundary went, so a held step is resumable.
              const steering = takeBoundaryFor(ctx, record.agent);
              const body = yield* buildPrompt(o, step, variant, key, ctx, vars);
              yield* fs.writeFileString(
                path,
                `${dispatch.steeringSection(run.dir, steering)}${body}\n`,
              );
              if (!boundary.dispatch) {
                yield* o.out(`  ⏸ ${boundary.reason}`);
                yield* run.log(boundary.reason);
                return boundary.reason;
              }
              yield* run.log(`prompt ${record.agent} -> ${pathService.relative(run.dir, path)}`);
              // A skill marked `disable-model-invocation` refuses an agent that invokes it
              // itself; `agent prompt` is the human's channel, so a slash command here runs.
              const command = step.skill
                ? `${skillCommandFor(variant.harness).call(null, step.skill)} `
                : "";
              const outcome = yield* channel.submit(
                `${command}Your task for this step is in ${path} — read it and follow it.`,
                {
                  run: run.id,
                  cause: stepCause(step, key, run),
                  mode: "boundary",
                  intentVersion: ctx.steering.intentVersion,
                  attempt: run.record.iteration,
                  requestId: `${run.id}-${step.id}-${key}-${run.record.iteration}`,
                },
              );
              // Each steering item composed into this prompt gets its own line, so the
              // ledger says which message reached the agent and inside what.
              for (const item of steering) yield* recordComposed(o, entry, item, outcome);
              if (outcome.ok) {
                // Written but unconfirmed is kept apart from delivered: what tells a
                // prompt that never arrived from one the agent ignored.
                if (outcome.submission === "unobserved")
                  yield* run.log(`${record.agent}: prompt written, no turn observed`);
                return null;
              }
              // A send herdr refused, or never answered, withholds this variant the way a
              // compaction in the air does: the reason reaches the human through the
              // variant's own error, and `run resume` is the recovery.
              const why = `${record.agent} was not given its prompt: ${outcome.reason} (${outcome.detail})`;
              yield* o.out(`  ⚠ ${why}`);
              yield* run.log(why);
              return why;
            }),
          )
          .pipe(
            Effect.ensuring(Deferred.done(sendTurn[i]!, Exit.void)),
            // A refusal to open the transaction at all — no incarnation, or a different
            // process in that pane — pauses the step for a human instead: `run resume`
            // starts a fresh agent, which is the recovery for it.
            Effect.catchTag("NotDeliverable", (cause) =>
              run
                .log(`dispatch to ${record.agent} refused: ${cause.reason}`)
                .pipe(Effect.as(`${record.agent} could not be sent to: ${cause.reason}`)),
            ),
          );
      }),
    { concurrency: "unbounded" },
  );

  // Watched together, because they were prompted together: a second reviewer that
  // hangs the moment it starts must not wait out the first one's whole turn before
  // its own quiet clock even begins. Reading what they wrote stays in order — that
  // part writes to the Run.
  const stuckReasons = yield* Effect.forEach(
    records,
    (record, i) =>
      // An agent that was never prompted has nothing to go quiet about.
      withheld[i] ? Effect.succeed(null) : awaitAgent(o, ctx, step, record),
    { concurrency: "unbounded" },
  );

  const outcomes: VariantOutcome[] = [];
  for (const [i, record] of records.entries()) {
    const key = keys[i]!;
    const why = withheld[i];
    if (why) {
      record.status = "blocked";
      record.error = why;
      outcomes.push({ record, output: null, review: null });
      continue;
    }
    const outcome = yield* collectWatched(o, ctx, step, record, key, stuckReasons[i] ?? null);
    // The agent went quiet and a usable Output was read, so the prompt's work is in the
    // Run and its delivery is over: a later prompt about this step is a new attempt, not
    // this one again. Not after a give-up, and not for an Output that is missing or
    // unusable — neither says the agent did this prompt's work — so the delivery stays
    // `submitted` and the same work is not sent to that agent twice. The Dispatcher adds
    // its own condition: a submission herdr never saw a turn come of stays in flight.
    const terminalId = entries[i]?.incarnation?.terminalId;
    if (terminalId !== undefined && stuckReasons[i] == null && outcome.problem === undefined) {
      yield* dispatch
        .settleCollected(
          o.env.stateDir,
          terminalId,
          causalKey(run.id, stepCause(step, key, run), ctx.steering.intentVersion),
        )
        .pipe(
          Effect.catch((cause) =>
            run.log(`could not settle ${record.agent}'s step delivery: ${reason(cause)}`),
          ),
        );
    }
    // An agent that was given up on is not going to answer a prompt, so the repair
    // round is not offered to one.
    if (stuckReasons[i]) {
      outcomes.push(outcome);
      continue;
    }
    // A round is worth several minutes and several agents; a write is worth one
    // prompt. Ask the agent that has the work to write its file again, once.
    outcomes.push(
      outcome.problem
        ? ((yield* repairOutput(o, ctx, step, record, key, outcome.problem)) ?? outcome)
        : outcome,
    );
  }
  return outcomes;
});

/**
 * A newly-created workspace starts with one numbered shell tab. When the workflow
 * was launched from that untouched tab, use it for the first agent instead of
 * leaving it behind beside the Control Plane and run tabs.
 *
 * A Run whose worktree Collie created owns a whole workspace herdr just made, and its
 * shell tab is that workspace's — not the launching pane's, which is in whatever
 * workspace the human started from. So the recorded root pane comes first; the checks
 * below are what keep a resumed Run from taking over a pane that now holds an agent.
 */
const reusableLaunchPane = Effect.fn("Engine.reusableLaunchPane")(function* (o: EngineOptions) {
  const launchId = o.run.record.worktree?.root_pane_id ?? o.env.paneId;
  if (!launchId) return null;
  const [tabs, panes] = yield* Effect.all([o.herdr.tabList(), o.herdr.paneList()]);
  const pane = panes.find((item) => item.paneId === launchId);
  if (!pane || pane.agent !== null) return null;
  const tab = tabs.find((item) => item.tabId === pane.tabId);
  if (!tab || !/^\d+$/.test(tab.label)) return null;
  if (panes.filter((item) => item.tabId === pane.tabId).length !== 1) return null;
  return { paneId: pane.paneId, tabId: pane.tabId };
});

interface ChoiceResult {
  status: StepStatus;
  note: string | null;
  /** True when a child Run took over, so the parent should stop. */
  chained?: boolean;
}

/**
 * A Choice step: a menu in the runner pane instead of an agent. A `prompt` choice
 * runs one agent round and offers the menu again; `run` and `stop` end the step.
 */
const runChoiceStep = Effect.fn("Engine.runChoiceStep")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  ctx: RunCtx,
) {
  const { run, out } = o;
  const prompts = o.prompts;
  if (!prompts) {
    return choiceResult({
      status: "failed",
      note: `${step.id} needs a menu, and this run has no terminal`,
    });
  }
  const choices = step.choices ?? [];
  // Said once, however many times the menu comes back around.
  const decidedSaid = new Set<string>();

  // A parent resumed mid-fan-out picks its waves back up rather than asking again: the
  // repositories it already started are the answer to this menu, and asking it a second
  // time would open a second set of merge requests.
  const unfinished = run.record.fanout;
  if (
    unfinished &&
    fanoutUnfinished(unfinished) &&
    (unfinished.step === "" || unfinished.step === step.id)
  ) {
    const choice = choices.find((c) => c.title === unfinished.title && c.run);
    if (choice) {
      const result = yield* fanOut(o, step, choice, prompts, ctx, {
        repos: [],
        waves: unfinished.waves,
        refusal: null,
      });
      return choiceResult({
        status: result.status,
        note: `resumed "${choice.title}" — ${result.note}`,
      });
    }
  }

  for (;;) {
    const taken = (title: string) =>
      run.record.choices.filter((c) => c.step === step.id && c.title === title).length;
    // What this Session and this environment can actually offer right now: a
    // hand-off needs its agent live, `unless:` needs it not to be, and `requires:`
    // is the same vocabulary a step uses.
    const offered: ChoiceDef[] = [];
    for (const choice of choices) {
      if (choice.max !== undefined && taken(choice.title) >= choice.max) continue;
      if (choice.handoff && !(yield* liveRole(sessionOf(o), choice.handoff))) continue;
      if (choice.unless && (yield* liveRole(sessionOf(o), choice.unless))) continue;
      if (choice.requires && (yield* unmetRequirement(o, choice.requires))) continue;
      offered.push(choice);
    }
    // Everything that could have done something is unavailable, so the only choices
    // left are endings: that is not a question worth asking. A menu authored as
    // endings — "stop here" or "carry on" — still is one.
    const lost = choices.filter((c) => !c.stop && !offered.includes(c));
    if (offered.every((c) => c.stop) && lost.length > 0) {
      const why = lost.map((c) => c.title).join(", ");
      yield* out(`◦ ${step.id} — nothing to decide (not available: ${why})`);
      return choiceResult({ status: "done", note: `skipped: nothing to decide (${why})` });
    }
    const items: PickItem[] = offered.map((c) => ({
      id: c.title,
      title: c.title,
      subtitle: choiceHint(c),
    }));

    // What the human already said, and what needs no saying. Both are once per step:
    // a `prompt:` round comes back to this menu, and re-taking itself would never
    // stop. The lookup runs against `offered`, so a decision can never make a choice
    // happen that this Session or this environment cannot do.
    const decided = run.record.decisions[step.id];
    const untaken = (c: ChoiceDef) => taken(c.title) === 0;
    const chosen =
      offered.find((c) => c.title === decided && untaken(c)) ??
      (offered.length === 1 && untaken(offered[0]!) ? offered[0] : undefined);
    // `taken(decided) === 0` is the difference between a decision this Session could
    // not offer and one whose round ran and failed: the second comes back here with
    // the choice already spent, and saying it was unavailable would send whoever is
    // called to look for the wrong thing.
    if (
      decided !== undefined &&
      chosen?.title !== decided &&
      taken(decided) === 0 &&
      !decidedSaid.has(step.id)
    ) {
      decidedSaid.add(step.id);
      yield* out(`  decided "${decided}", not available here`);
      yield* run.log(`${step.id}: decided "${decided}", not available here`);
      // The exact failure a decided, unattended Run has: it is asking after all, and
      // without this it stalls silently until someone happens to look. Only when it
      // really is asking, though — where one offered choice is taken instead, nothing
      // is pending and a `request` toast would call someone to a menu that is not there.
      if (!chosen) {
        yield* notify(o, "decision-lost", `${step.id}: "${decided}" was not available here`, {
          step: step.id,
        });
      }
    }

    const picked = chosen
      ? { id: chosen.title, title: chosen.title }
      : yield* Effect.gen(function* () {
          yield* callAttention(o, ctx, `${step.id}: pick what happens next`, step.id);
          const answer = yield* prompts.menu(items, {
            header: `${run.record.slug} — ${step.id}`,
            footer: "↑↓ move · Enter choose · Esc leave the run open",
          });
          run.record.awaiting = null;
          yield* run.save();
          // Off `asks you` the moment it is answered: the next step's own rename can
          // be a hand-off and a whole agent start away.
          yield* reconcileTabs(o, ctx, nothingLive);
          return answer;
        });
    if (!picked) return choiceResult({ status: "blocked", note: "no choice taken" });

    const choice = offered.find((c) => c.title === picked.id)!;
    run.record.choices.push({ step: step.id, title: choice.title, at: yield* nowIso() });
    yield* run.save();
    const why = !chosen ? "" : decided === chosen.title ? " (decided at launch)" : " (only option)";
    yield* out(`  ▸ ${choice.title}${why}`);

    if (choice.stop) return choiceResult({ status: "done", note: `chose "${choice.title}"` });

    if (choice.handoff) {
      const result = yield* handOff(o, choice.handoff);
      yield* out(`  ${result.message}`);
      yield* run.log(result.message);
      // A hand-off that did not land is not an answer, so the menu comes back.
      if (!result.ok) continue;
      return choiceResult({ status: "done", note: `chose "${choice.title}" — ${result.message}` });
    }

    if (choice.post) {
      const result = yield* postReview(o.run);
      yield* out(`  ${result.message}`);
      yield* run.log(result.message);
      // A note that did not land is not an answer, so the menu comes back.
      if (!result.ok) continue;
      return choiceResult({ status: "done", note: `chose "${choice.title}" — ${result.message}` });
    }

    if (choice.run) {
      // A plan that spans repositories is one run per repository rather than one run,
      // and a plan the fan-out cannot honestly run is refused here: the message is
      // shown, nothing is started, and the menu comes back for the human to pick again.
      const plan = yield* fanOutOf(o, choice, ctx);
      if (plan?.refusal) {
        yield* out(`  ${choice.title} cannot run here: ${plan.refusal.message}`);
        yield* run.log(`${step.id}: "${choice.title}" refused — ${plan.refusal.message}`);
        continue;
      }
      if (plan) {
        const result = yield* fanOut(o, step, choice, prompts, ctx, plan);
        return choiceResult({
          status: result.status,
          note: `chose "${choice.title}" — ${result.note}`,
        });
      }
      const child = yield* chain(o, choice, prompts, ctx);
      if (!child) continue;
      return choiceResult({
        status: "done",
        note: `chose "${choice.title}" → ${choice.run} run ${child}`,
        chained: true,
      });
    }

    if (choice.config) yield* ensureConfig(o, prompts, choice.config);

    const round = choice.round!;
    const key = `${slugify(choice.title)}-${taken(choice.title)}`;
    // A round that rewrites the plan has to tell whoever is building from it.
    const before = yield* snapshotPlan(o, key);
    const first = yield* runRound(o, step, round, key, ctx);
    if (first.record.status !== "done") {
      yield* out(`  ⚠ ${first.record.label} — ${first.record.error ?? "did not finish"}`);
      continue;
    }
    yield* reportPlanChange(o, before, first.output);
    const findings = first.review?.findings ?? [];
    if (choice.followUp && findings.length > 0) {
      const next = yield* runRound(o, step, choice.followUp, `${key}-then`, ctx, {
        findings: formatFindings(findings),
      });
      if (next.record.status !== "done") {
        yield* out(`  ⚠ ${next.record.label} — ${next.record.error ?? "did not finish"}`);
      }
    }
    // A decided round is the whole answer to this step. Coming back to the menu would
    // ask the human the question they already answered; a round they picked by hand
    // still gets it back.
    if (decided === choice.title) {
      return choiceResult({ status: "done", note: `decided at launch: "${choice.title}"` });
    }
  }
});

/**
 * What a forwarded Choice input renders against; `CHAIN_SUPPLIED` names its families.
 * One answer, because the fan-out reads the plan a choice names and `chain` forwards
 * that same value to the child — and rendering it two ways is a fan-out that reads one
 * plan directory while its children build another.
 */
function chainVars(run: Run, ctx: RunCtx) {
  return {
    run: { dir: run.dir, id: run.id, slug: run.record.slug },
    inputs: run.record.inputs,
    outputs: outputVars(ctx.outputs),
    cwd: run.record.cwd,
  };
}

/** Every Step's Output so far, as a prompt or a Choice's `inputs:` can address it. */
function outputVars(outputs: Map<string, VariantOutcome[]>): YamlMap {
  return Schema.decodeUnknownSync(YamlMapSchema)(
    Object.fromEntries(
      [...outputs.entries()].map(([id, list]) => [
        id,
        list.length === 1 ? list[0]!.output : list.map((v) => v.output),
      ]),
    ),
  );
}

/**
 * The child's Intent v1: its parent's constraints, re-sourced `parent`, with
 * `parent.applied` recording which version they came from. Authority is deliberately
 * not inherited — a grant is per Run (SPEC §7.1) and a child that silently arrived
 * with `auto_correct` would be a Run nobody granted anything.
 *
 * A parent with no Intent leaves the child with none, and an unreadable one is logged
 * on the child rather than stopping a chain that is otherwise ready to run.
 */
const inheritIntent = Effect.fn("Engine.inheritIntent")(function* (parent: Run, child: Run) {
  const intent = yield* readIntent(parent.dir).pipe(
    Effect.catch((cause) =>
      child.log(`parent intent unreadable: ${String(cause)}`).pipe(Effect.as(null)),
    ),
  );
  if (!intent) return;
  const { intent: seeded } = propagate(
    intent,
    seedIntent(child.id, { runVerification: child.record.approved_verifications }),
  );
  yield* writeIntent(child.dir, seeded).pipe(
    Effect.matchEffect({
      onFailure: (cause) => child.log(`intent v1 not written: ${String(cause)}`),
      onSuccess: () => child.log(`intent v1 written from ${parent.id} v${intent.version}`),
    }),
  );
});

/**
 * Starts the chosen Workflow as a child Run in this workspace and links it to this
 * one. Returns null when the human abandoned it at a question, so the menu comes back.
 */
const chain = Effect.fn("Engine.chain")(function* (
  o: EngineOptions,
  choice: ChoiceDef,
  prompts: EnginePrompts,
  ctx: RunCtx,
  /**
   * What the fan-out knows and the choice cannot say: which repository of the plan this
   * child owns, and the checkout to root it at. Absent for every ordinary chain.
   */
  override?: { inputs: Record<string, string>; cwd: string },
) {
  const { run, out } = o;
  const child = resolveWorkflow(choice.run!, o.defs, o.defaults);
  const vars = chainVars(run, ctx);
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(choice.inputs ?? {})) {
    forwarded[key] = renderTemplate(value, vars).text;
  }
  Object.assign(forwarded, override?.inputs ?? {});
  const cwd = override?.cwd ?? run.record.cwd;

  const inputs: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const r of yield* inferInputs(child.inputs, {
    cwd,
    stateDir: o.env.stateDir,
    task: run.record.task,
  })) {
    if (forwarded[r.name] !== undefined) {
      inputs[r.name] = forwarded[r.name]!;
      sources[r.name] = `chained from ${run.id}`;
      // A forwarded Input still owes the prompts its kind, exactly as the picker would
      // have recorded it: the child's own body branches on it.
      if (r.strategy === "work-source")
        inputs[`${r.name}_kind`] = (yield* classifyWorkSource(forwarded[r.name]!)).kind;
      if (r.strategy === "diff-target") inputs[`${r.name}_kind`] = targetKind(forwarded[r.name]!);
      continue;
    }
    if (r.needsAsking) {
      // A work-source is chosen from what this repo offers; everything else is typed.
      if (r.candidates) {
        if (!(yield* resolveCandidates(r, prompts))) {
          yield* out(`  ${choice.run} needs "${r.name}" — nothing started`);
          return null;
        }
      } else {
        const answer = yield* prompts.ask(r.question);
        if (answer === null || answer.trim() === "") {
          yield* out(`  ${choice.run} needs "${r.name}" — nothing started`);
          return null;
        }
        r.value = answer.trim();
        r.source = "asked";
      }
    }
    inputs[r.name] = r.value;
    sources[r.name] = r.source;
    if (r.kind) {
      inputs[`${r.name}_kind`] = r.kind;
      sources[`${r.name}_kind`] = r.source;
    }
  }

  // The parent already names the work, so the child inherits its name — the whole of
  // what the parent was called after where that is recorded, not the slug it was cut
  // to, because a name that was already clipped cannot be caught by slugging it again.
  const tail = run.record.named_after ?? runName(run.record.workflow, run.record.slug);
  // A chained Workflow that changes the repository owns its checkout too — this is
  // where `plan` and `architecture` get one, by chaining into `implement`. The branch
  // is resolved from the child's own inputs, so a fix round lands in the checkout the
  // reviewed branch already has.
  const where = {
    cwd,
    stateDir: o.env.stateDir,
    workflow: child.name,
    name: tail,
    inputs,
    sources,
    // The Task's workspace, as the parent recorded it — not whatever is focused now.
    workspaceId: run.record.workspace ?? o.env.workspaceId,
    workspaceLabel: run.record.workspace_label,
    login: o.env.gitlabLogin,
  };
  const checkout = yield* checkoutFor(o.herdr, where);
  // A child that must not share a checkout is not started at all, and the menu comes
  // back: sharing one is what swapped two Runs' uncommitted work in the first place.
  if (checkout.refused) {
    yield* out(`  ${child.name} has nowhere to work: ${checkout.refused} — nothing started`);
    return null;
  }
  const childRun = yield* new RunStore(o.env.stateDir).create({
    workflow: child.name,
    cwd: checkout.cwd,
    session: o.env.socketPath,
    workspace: checkout.workspaceId,
    // A chain is the same Task going on: a plan into its implementation, that into its
    // review. Inherited rather than resolved again, so no child opens a Task of its own.
    task: run.record.task,
    worktree: checkout.worktree,
    // A child starts where its parent is, so it inherits the workspace it recorded.
    workspaceLabel: checkout.workspaceLabel,
    workspaceWorktree: run.record.workspace_worktree,
    inputs,
    inputSources: sources,
    definition: child,
    approvedVerifications: yield* approvedFrom({ cwd, configDir: o.env.configDir }),
    stepIds: child.steps.map((s) => s.id),
    maxIterations: child.maxIterations,
    ...runNames(checkout, { value: tail, short: tail }),
    parent: run.id,
  });
  yield* childRun.log(`chained from ${run.id}`);
  yield* inheritIntent(run, childRun);
  if (checkout.note) yield* childRun.log(checkout.note);
  run.record.children.push(childRun.id);
  yield* run.save();
  yield* out(`  ▸ ${child.name} run ${childRun.id}`);

  // A Run is driven by a detached Driver with no pane of its own, so a child is handed
  // over exactly as `run start` hands over. This used to open a `runner` pane, which
  // herdr-plugin.toml has never declared and main.ts has never routed, so the child
  // was created, recorded `running`, listed as a child — and driven by nobody.
  const undriven = yield* handOver({ ...o.env, cwd: childRun.record.cwd }, childRun);
  if (undriven) yield* out(`  ${child.name} was created but no driver started: ${undriven.why}`);
  return childRun.id;
});

/**
 * Waits for another Run to reach a terminal status, and says which one it reached.
 *
 * The Driver's own Choice wait is the shape: events on the run directory invalidate a
 * re-read, and a tick rides alongside them so a watch the platform drops costs latency
 * rather than the answer.
 *
 * No timeout: a repository run takes as long as its work does. A child whose Driver was
 * killed outright leaves the record `running` and so is waited on for ever — the
 * parent's row says which repository it is waiting on, and `run stop` ends it.
 */
/**
 * The safety net, not the mechanism: the watch below is what makes this wait prompt, and
 * the tick only covers an event the platform dropped. Seconds rather than the Driver's
 * Choice wait's half-second, because that one is open while a human decides and this one
 * is open for the whole life of a repository run — every tick is a read and a schema
 * decode of the child's record.
 */
const WAIT_TICK_MS = 5000;

const waitOnRun = Effect.fn("Engine.waitOnRun")(function* (stateDir: string, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const store = new RunStore(stateDir);
  const check = Effect.gen(function* () {
    const child = yield* store.load(id);
    return { dir: child.dir, status: yield* runStatus(child) };
  }).pipe(
    // A child whose record will not read is not something to wait on for ever.
    Effect.catch(() => Effect.succeed({ dir: null, status: "failed" })),
  );

  const first = yield* check;
  if (first.dir === null || runSettled(first.status)) return first.status;
  const events = Stream.merge(
    fs.watch(first.dir).pipe(Stream.catchCause(() => Stream.empty)),
    Stream.tick(`${WAIT_TICK_MS} millis`),
  );
  const seen = yield* events.pipe(
    Stream.mapEffect(() => check),
    Stream.filter((event) => runSettled(event.status)),
    Stream.runHead,
  );
  return Option.match(seen, { onNone: () => "failed", onSome: (event) => event.status });
});

/**
 * The repositories a `run:` choice would fan out over, and `null` when it would chain
 * one run exactly as it always has: a plan whose tickets name one repository, and any
 * work source that is not a plan directory at all.
 *
 * Read here rather than trusted from the plan: the refusals are what stop a fan-out
 * that cannot be honest, so they have to be known before anything is started.
 */
const fanOutOf = Effect.fn("Engine.fanOutOf")(function* (
  o: EngineOptions,
  choice: ChoiceDef,
  ctx: RunCtx,
) {
  const template = choice.inputs?.plan;
  if (template === undefined) return null;
  // The same rendering `chain` will do with it, so the plan read here is the plan the
  // children are given.
  const planDir = renderTemplate(template, chainVars(o.run, ctx)).text;
  const plan = yield* planReposOf(planDir, o.run.record.cwd);
  return isSingleRepo(plan) ? null : plan;
});

/**
 * One `implement` run per repository the plan names, in waves: a repository starts when
 * every repository its tickets are blocked by has succeeded. The parent stays `running`
 * throughout, which is what makes it the one row that says whether the whole plan is
 * built.
 *
 * A child that fails or is stopped starts no further wave. The children already running
 * are left to finish — they are building their own repository and their work is worth
 * having — and the parent ends `blocked` naming the repository that stopped it.
 */
const fanOut = Effect.fn("Engine.fanOut")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  choice: ChoiceDef,
  prompts: EnginePrompts,
  ctx: RunCtx,
  plan: PlanRepos,
) {
  const { run, out } = o;
  const pathService = yield* Path.Path;
  const store = new RunStore(o.env.stateDir);
  const waves = plan.waves.map((wave) => [...wave]);
  run.record.fanout = {
    step: step.id,
    title: choice.title,
    waves,
    // A resumed fan-out keeps what it already started, and what those runs opened.
    runs: run.record.fanout?.runs ?? {},
    mrs: run.record.fanout?.mrs ?? {},
    wave: 0,
    blocked: null,
  };
  yield* run.save();

  /** The record as it stands, which is set from here down; `mark` is the only writer. */
  const fan = () => run.record.fanout!;
  const mark = (patch: Partial<FanoutRecord>) =>
    Effect.gen(function* () {
      run.record.fanout = { ...fan(), ...patch };
      yield* run.save();
    });

  // A child is created, given a Driver and pushed onto `children` before this record
  // learns which repository it is for, and an interrupt in that gap — a stop is a signal
  // that can land anywhere — would leave a repository run nothing here can see: not
  // stopped with the plan, not on the parent's row, and started a second time by a
  // resume, on the same branch. The child records its own `repo`, so a resumed parent
  // adopts what it already has before deciding what to start.
  const known = new Set(Object.values(fan().runs));
  for (const id of run.record.children) {
    if (known.has(id)) continue;
    const child = yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
    const repo = child?.record.inputs.repo ?? "";
    if (repo !== "" && waves.flat().includes(repo) && fan().runs[repo] === undefined) {
      yield* out(`  ${repo} was already started as ${id}`);
      yield* mark({ runs: { ...fan().runs, [repo]: id } });
    }
  }

  /**
   * The merge request a repository's run opened, kept on the parent. Called wherever a
   * child's end is observed and not only where the fan-out carries on, because the
   * parent is the one place the sibling merge requests are findable from: a repository
   * that was built has its merge request listed whatever became of its wave.
   */
  const recordMr = Effect.fn("Engine.fanOut.recordMr")(function* (repo: string, id: string) {
    const url = yield* store.load(id).pipe(
      Effect.map((child) => child.record.mr_url),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (url) yield* mark({ mrs: { ...fan().mrs, [repo]: url } });
  });

  for (const [index, wave] of waves.entries()) {
    yield* mark({ wave: index + 1 });
    const ids: Array<{ repo: string; id: string }> = [];
    /**
     * The repository this wave got no further than, and why. The loop below breaks
     * rather than returning: the siblings it has already started are building whether
     * or not this one could, so they are waited on and their merge requests recorded
     * before the fan-out says what stopped it. Returning here left a child orchestrating
     * agents with nobody waiting on it and its merge request listed nowhere.
     */
    let unstartable: { repo: string; status: string } | null = null;
    for (const repo of wave) {
      // A resumed parent does not start a repository twice. What it does with the child
      // it already has depends on how that child ended: one that succeeded is done with,
      // one that failed or was stopped is resumed as itself, and one still going is
      // waited on. This is what keeps a second attempt from opening second merge
      // requests.
      const already = fan().runs[repo];
      if (already !== undefined) {
        const child = yield* store.load(already).pipe(Effect.catch(() => Effect.succeed(null)));
        const status = child === null ? "failed" : yield* runStatus(child);
        if (status === "succeeded") {
          yield* out(`  ${repo} already succeeded`);
          // Including the one a previous attempt built while the fan-out was stopping:
          // this is the only pass that will look at it.
          yield* recordMr(repo, already);
          continue;
        }
        if (child !== null && (status === "failed" || status === "stopped")) {
          const requestId = yield* (yield* Crypto.Crypto).randomUUIDv4;
          const resumed = yield* resumeRun({ ...o.env, cwd: child.record.cwd }, child, requestId);
          yield* out(
            `  ${repo} ${resumed.ok ? "resumed" : `not resumed: ${resumed.error.message}`}`,
          );
          if (!resumed.ok) {
            unstartable = { repo, status: "not resumed" };
            break;
          }
        }
        ids.push({ repo, id: already });
        continue;
      }
      // No branch is named here on purpose: `branchFor` names a chained run after the
      // work its parent was named for, so every Repo run of one plan is handed the same
      // branch in its own repository — which is what makes the sibling merge requests
      // findable by name. Naming one here would be that decision made twice.
      const child = yield* chain(o, choice, prompts, ctx, {
        inputs: { repo },
        cwd: pathService.join(run.record.cwd, repo),
      });
      if (child === null) {
        unstartable = { repo, status: "not started" };
        break;
      }
      yield* mark({ runs: { ...fan().runs, [repo]: child } });
      ids.push({ repo, id: child });
    }

    yield* out(`  wave ${index + 1}/${waves.length}: ${wave.join(", ")}`);
    // Every repository of the wave, not up to the first failure: they are all already
    // started, they are all left to finish, and one that was built has a merge request
    // the parent has to list. Returning early skipped a sibling's for good.
    const ended: Array<{ repo: string; status: string }> = [];
    for (const { repo, id } of ids) {
      const status = yield* waitOnRun(o.env.stateDir, id);
      yield* out(`  ${repo} ${status}`);
      yield* run.log(`${repo}: run ${id} ${status}`);
      yield* recordMr(repo, id);
      ended.push({ repo, status });
    }
    // In wave order: what each repository that started ended as, and last the one that
    // never started, which the loop above broke on.
    if (unstartable !== null) ended.push(unstartable);
    // The first that did not succeed, which is the one the parent is blocked on and the
    // reason the waves after it are not run.
    const stopped = ended.find((entry) => entry.status !== "succeeded");
    if (stopped !== undefined) {
      yield* mark({ wave: 0, blocked: stopped });
      return {
        status: "blocked" as const,
        note: `${stopped.repo} ${stopped.status}; the repositories after it were not run`,
      };
    }
  }

  yield* mark({ wave: 0 });
  return {
    status: "done" as const,
    note: `${waves.flat().length} repo(s) built in ${waves.length} wave(s)`,
  };
});

/** One agent round inside a Choice: a Step in every way except its own id. */
const runRound = Effect.fn("Engine.runRound")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  round: RoundDef,
  key: string,
  ctx: RunCtx,
  extraVars?: YamlMap,
) {
  const synth: ResolvedStep = {
    ...round,
    id: step.id,
    persona: round.persona ?? step.persona,
    origin: step.origin,
    preamble: step.preamble,
    prompt: round.prompt,
    known: step.known,
    choices: undefined,
  };
  const variant = roundVariant(round, step, o.defaults);
  const outcomes = yield* runStep(o, synth, [variant], [key], ctx, extraVars);
  const outcome = outcomes[0]!;
  // runStep has already recorded it; a second push here would list it twice.
  ctx.outputs.set(step.id, [outcome]);
  yield* o.run.save();
  yield* markTab(o, ctx, [outcome.record]);
  return outcome;
});

/** What a choice does, one line, for the menu and for the launch decision. */
export function choiceHint(choice: ChoiceDef): string {
  if (choice.run) return `runs ${choice.run}`;
  if (choice.post) return "one note on the merge request";
  if (choice.handoff) return `to the ${choice.handoff} already working here`;
  if (choice.stop) return "ends here";
  return choice.round?.agent ? `prompts ${choice.round.agent}` : "a fresh agent";
}

const PLAN_DIR = "plan";
const PLAN_ISSUES = "issues";

/** The tickets a Run builds from, when its work source is a plan directory. */
const planTickets = Effect.fn("Engine.planTickets")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const plan = o.run.record.inputs.plan ?? "";
  if (o.run.record.inputs.plan_kind !== "plan-dir" || plan === "") return null;
  const dir = pathService.join(plan, PLAN_ISSUES);
  const there = yield* fs.exists(dir).pipe(Effect.catch(() => Effect.succeed(false)));
  return there ? dir : null;
});

/**
 * Every ticket by file name; null when any of it could not be read — unreadable is
 * not empty, and empty would read as requirements deleted.
 */
const readTickets = Effect.fn("Engine.readTickets")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed(null)));
  if (names === null) return null;
  const tickets = new Map<string, string>();
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const text = yield* fs
      .readFileString(pathService.join(dir, name))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (text === null) return null;
    tickets.set(name, text);
  }
  return tickets;
});

const CHECKBOX = /^[-*] \[[ xX]\]/;

/** A ticket's acceptance criteria: its checkbox lines, as written. */
function checkboxes(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CHECKBOX.test(line));
}

/** Which ticket moved, and the acceptance criteria that came and went. */
function ticketChangeNote(before: Map<string, string>, after: Map<string, string>): string | null {
  const parts: string[] = [];
  for (const [name, text] of after) {
    const old = before.get(name);
    if (old === text) continue;
    const was = checkboxes(old ?? "");
    const now = checkboxes(text);
    parts.push(
      [
        `${name} ${old === undefined ? "is new" : "changed"}:`,
        ...now.filter((line) => !was.includes(line)).map((line) => `  + ${line}`),
        ...was.filter((line) => !now.includes(line)).map((line) => `  - ${line}`),
      ].join("\n"),
    );
  }
  for (const name of before.keys()) if (!after.has(name)) parts.push(`${name} is gone.`);
  if (parts.length === 0) return null;
  return [
    [
      "The tickets you are building from have changed on disk. The files are the authority:",
      "an answer you were given in a pane is not, and may be narrower than what was written.",
      "Re-read the ones below.",
    ].join(" "),
    parts.join("\n"),
    [
      "Reconcile rather than restart: finish what the change does not affect, adjust what it",
      "does, and where it conflicts with work you have already committed or pushed, say so in",
      "your Output instead of quietly undoing either side.",
    ].join(" "),
  ].join("\n\n");
}

/**
 * A copy of the plan directory before a round touches it, so a change can be shown
 * as a diff afterwards. Null when this run has no plan of its own to change.
 */
const snapshotPlan = Effect.fn("Engine.snapshotPlan")(function* (o: EngineOptions, key: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const plan = pathService.join(o.run.dir, PLAN_DIR);
  if (!(yield* fs.exists(plan))) return null;
  const before = pathService.join(o.run.dir, "steps", "plan-before", key);
  return yield* Effect.gen(function* () {
    yield* fs.remove(before, { recursive: true, force: true });
    yield* fs.makeDirectory(before, { recursive: true });
    yield* fs.copy(plan, before);
    return before;
  }).pipe(Effect.catch((e) => o.run.log(`plan snapshot: ${reason(e)}`).pipe(Effect.as(null))));
});

/**
 * Once per change, and only when someone is building from this plan: the diff of
 * `plan/` and whatever the planner said it did.
 */
const reportPlanChange = Effect.fn("Engine.reportPlanChange")(function* (
  o: EngineOptions,
  before: string | null,
  output: YamlValue | null,
) {
  if (!before) return;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const plan = pathService.join(o.run.dir, PLAN_DIR);
  // `git diff --no-index` exits 1 when the two differ, which is how "changed" is read.
  const diff = yield* shellRun(
    "git",
    ["diff", "--no-index", "--no-color", "--", before, plan],
    o.run.record.cwd,
  );
  if (diff.code === 0 || diff.stdout.trim() === "") return;

  const path = pathService.join(before, "..", `${pathService.basename(before)}.patch`);
  yield* fs.writeFileString(path, diff.stdout);
  const changelog = isYamlMap(output) && isString(output.changelog) ? output.changelog : "";
  const result = handoffResult(
    yield* sendPlanChange(sessionOf(o), o.run, {
      planDir: plan,
      diff: path,
      changelog,
    }),
    "could not send the plan change",
  );
  yield* o.run.log(`plan changed: ${result.message}`);
  if (result.ok) yield* o.out(`  ▸ ${result.message}`);
  // A hand-off held by the receiver's own compaction is not the quiet "nobody to hand
  // to": no work went anywhere and the human is the one who decides what happens next,
  // so it says so here as well as in the audit trail.
  else if (result.held) yield* o.out(`  ⏸ ${result.message}`);
});

/** This Run's Session, as the register and the hand-offs key it. */
function sessionOf(o: EngineOptions): Session {
  return {
    herdr: o.herdr,
    stateDir: o.env.stateDir,
    // A hand-off is a work boundary too, so the Session carries what the shared
    // policy needs to read this Run's threshold and warn in its audit trail.
    configDir: o.env.configDir,
    compaction: compactionSettings(o),
    ...scopeFor(o.env, o.run.record.cwd),
  };
}

/** Gives this Run's review to the Session's live agent for that role. */
const handOff = Effect.fn("Engine.handOff")(function* (o: EngineOptions, role: string) {
  if (role !== "implementer") return { ok: false, message: `nothing to hand to a ${role}` };
  return handoffResult(yield* sendReview(sessionOf(o), o.run), "could not send the review");
});

/** A value the human is asked for once and that stays in config.json. */
const ensureConfig = Effect.fn("Engine.ensureConfig")(function* (
  o: EngineOptions,
  prompts: EnginePrompts,
  cfg: { key: string; question: string },
) {
  if (configValue(yield* readConfig(o.env.configDir), cfg.key) !== undefined) return;
  // The key is in the question, so what is on screen says it is a setting rather than a
  // menu — a question that reads like one is how a Choice title came to be saved as a
  // Linear team name.
  const answer = yield* prompts.ask(`${cfg.question}? (saved as ${cfg.key})`);
  if (answer === null || answer.trim() === "") return;
  yield* writeConfigValue(o.env.configDir, cfg.key, answer.trim());
  yield* o.out(`  saved ${cfg.key} in config.json`);
});

/** A step some later step continues, i.e. the one that starts a long-lived agent. */
function groupHead(wf: ResolvedWorkflow, stepId: string): boolean {
  return wf.steps.some((s) => s.agent === stepId);
}

/** Puts one long-lived agent on the Session's register, for a later Run to find. */
const register = Effect.fn("Engine.register")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  record: VariantRecord,
) {
  const path = yield* registryPath(o.env.stateDir, scopeFor(o.env, o.run.record.cwd));
  yield* Effect.gen(function* () {
    // herdr's own identity for the process that was just started, read back from the
    // listing rather than assumed: this is what later makes "the agent that was
    // registered" and "the agent in that pane now" two answerable questions. An agent
    // herdr does not name a `terminal_id` for is registered without one and is simply
    // never a delivery target — the entry is still worth having for stop and prune.
    const live: AgentInfo[] = yield* o.herdr
      .agentList()
      .pipe(Effect.catch(() => Effect.succeed([])));
    const info = live.find((a) => a.name === record.agent && a.paneId === record.paneId);
    const entry: AgentEntry = {
      role: step.persona ?? step.id,
      agent: record.agent,
      paneId: record.paneId!,
      workspaceId: o.env.workspaceId,
      runId: o.run.id,
      workflow: o.run.record.workflow,
      at: yield* nowIso(),
    };
    if (info?.terminalId) {
      entry.incarnation = { terminalId: info.terminalId, agentSession: info.agentSession };
      record.incarnation = entry.incarnation;
    }
    yield* registerAgent(path, entry);
    yield* o.run.log(
      info?.terminalId
        ? `registered ${record.agent} as ${step.persona ?? step.id}`
        : `registered ${record.agent} as ${step.persona ?? step.id} without an incarnation`,
    );
  }).pipe(
    // A register nobody can write is a hand-off nobody gets, not a failed run.
    Effect.catch((e) => o.run.log(`register ${record.agent} failed: ${reason(e)}`)),
  );
});

/**
 * Puts a tab where the strip says it belongs: Collie first, then plan, implement,
 * review, then anything else in start order. Rank comes from the *Run's* workflow —
 * `implement` embeds `review`, and those tabs belong to the implement run. Only a tab
 * Collie just created is placed, and never again, so a tab a human dragged stays
 * dragged. A herdr too old for `tab.move` gets a log line, never a failed Run.
 */
const placeTab = Effect.fn("Engine.placeTab")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  tabId: string,
) {
  // Asked again while there is no answer: the first tab Collie opens in a workspace is
  // the anchor for the ones after it, and a Run that resolved `null` once at its start
  // would then never order any of its own tabs. No anchor at all means no strip Collie
  // has any business reordering — the tab being placed is the only one it owns here.
  ctx.orderAnchorTabId ??= yield* orderAnchorOf(o);
  if (!ctx.orderAnchorTabId) return;
  yield* Effect.gen(function* () {
    const owners = new Map<string, number>();
    for (const run of yield* new RunStore(o.env.stateDir).list()) {
      if (run.record.workspace !== o.run.record.workspace) continue;
      const rank = rankOf(run.record.workflow);
      for (const step of run.record.steps) {
        for (const variant of step.variants) {
          if (variant.tabId) owners.set(variant.tabId, rank);
        }
      }
    }
    // This run's newest tabs are in the record already, but the one being placed may
    // not be saved yet; it is the tab being inserted, not an anchor.
    const tabs = (yield* o.herdr.tabList())
      .filter((tab) => tab.tabId !== tabId)
      .map((tab) => ({
        rank: owners.get(tab.tabId) ?? null,
        board: tab.tabId === ctx.orderAnchorTabId,
      }));
    yield* o.herdr.tabMove(tabId, insertIndexFor(tabs, rankOf(o.run.record.workflow)));
  }).pipe(Effect.catch((e) => o.run.log(`tab order: ${reason(e)}`)));
});

/**
 * The Home's tab, where a pending question goes. Never used to order anything: the Home
 * is one board for the whole Herd, and a Run in another workspace ordering that
 * workspace's strip was the board and the anchor being the same value.
 */
const homeTabOf = Effect.fn("Engine.homeTabOf")(function* (o: EngineOptions) {
  const ensured = yield* ensureHomeFor(o.herdr, o.env, (line) =>
    Effect.ignore(o.run.log(line)),
  ).pipe(Effect.catch((e) => o.run.log(`home: ${reason(e)}`).pipe(Effect.as(null))));
  if (ensured === null) return null;
  if (ensured.kind === "ownership_unknown") {
    yield* o.run.log(`home: ${ensured.why}; \`collie home reconcile\` settles it`);
    return null;
  }
  // Made but not opened: nothing to settle, and no tab to send a question to yet.
  if (ensured.kind === "incomplete") return null;
  return ensured.record.tabId;
});

/**
 * A tab in *this* Run's own workspace to order against: the first one in the strip that
 * any Run of this workspace opened. Null while Collie owns nothing here, which is a
 * strip it has no business reordering — the one tab it is about to open is the only one
 * there, and where that sits is herdr's answer, not Collie's.
 */
const orderAnchorOf = Effect.fn("Engine.orderAnchorOf")(function* (o: EngineOptions) {
  return yield* Effect.gen(function* () {
    const owned = new Set<string>();
    for (const run of yield* new RunStore(o.env.stateDir).list()) {
      if (run.record.workspace !== o.run.record.workspace) continue;
      for (const step of run.record.steps) {
        for (const variant of step.variants) if (variant.tabId) owned.add(variant.tabId);
      }
    }
    return (yield* o.herdr.tabList()).find((tab) => owned.has(tab.tabId))?.tabId ?? null;
  }).pipe(Effect.catch((e) => o.run.log(`tab anchor: ${reason(e)}`).pipe(Effect.as(null))));
});

/**
 * A question nobody sees is a run that has silently stopped, so it is said
 * twice: a toast, and the Session's tab brought to the front.
 *
 * The tab is the half a human can opt out of with `questions: notify`. The toast, the
 * recorded `awaiting` and the tab's `asks you` are not optional: suppressing the jump
 * must not make the question itself any quieter, or a Run stops in real silence.
 */
const callAttention = Effect.fn("Engine.callAttention")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  detail: string,
  stepId: string,
) {
  o.run.record.awaiting = stepId;
  yield* o.run.save();
  // The tab says what it is now waiting for, so the sidebar row reads `asks you`
  // rather than the step it stopped in the middle of.
  yield* reconcileTabs(o, ctx, nothingLive, true);
  yield* notify(o, "needs-you", detail, { step: stepId });
  if (o.defaults.questions === "notify" || !ctx.boardTabId) return;
  // The one thing that still takes focus, and only under `questions: focus`: a question
  // is the human being waited on. Cards, corrections and proposals never do this.
  // A tab that will not focus is still a tab the human can reach.
  yield* Effect.ignore(o.herdr.tabFocus(ctx.boardTabId));
});

/**
 * A harness that asks before it will work in a directory asks in its own pane, where
 * it is easy to miss and impossible to answer for someone else. So the question is put
 * here instead, once per directory, before a single tab opens.
 */
const ensureTrusted = Effect.fn("Engine.ensureTrusted")(function* (o: EngineOptions) {
  if (o.defaults.trust === "never") return;
  const cwd = o.run.record.cwd;
  const seen = new Set<string>();

  for (const step of o.wf.steps) {
    for (const variant of stepVariants(step, o.defaults)) {
      if (seen.has(variant.harness)) continue;
      seen.add(variant.harness);
      const trust = HARNESSES[variant.harness]?.trust?.(o.env.home, o.env.stateDir);
      if (!trust || (yield* trust.state(cwd)) !== "untrusted") continue;

      // A checkout Collie created a moment ago is not a directory the human has an
      // opinion about: they said yes to the Run, and the worktree is where it happens.
      if (o.defaults.trust === "ask" && !o.run.record.worktree?.created_by_collie) {
        if (!o.prompts) continue;
        const answer = yield* o.prompts!.menu(
          [
            {
              id: "trust",
              title: "Trust it now",
              subtitle: "records it where the harness looks",
            },
            {
              id: "ask",
              title: "Let claude ask me in its tab",
              subtitle: "the run waits for you",
            },
          ],
          {
            header: `${variant.harness} has not worked in ${cwd} before`,
            footer: "↑↓ move · Enter choose",
          },
        );
        if (answer?.id !== "trust") continue;
      }
      // A grant that cannot be written is not a reason to stop the run: with nothing
      // recorded, the harness falls back to asking in its own pane, which is exactly
      // where the question would have been without this.
      const result = yield* trust.grant(cwd).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            ok: false,
            message: `could not record trust for ${cwd} (${reason(cause)}); ${variant.harness} will ask in its own tab`,
          }),
        ),
      );
      yield* o.out(`  ${result.message}`);
      yield* o.run.log(`trust ${variant.harness}: ${result.message}`);
    }
  }
});

/** herdr says this when the harness stopped on a prompt before it was ready to work. */
function blockedAtStartup(e: HerdrError): boolean {
  return /agent_not_ready|blocked during startup/.test(e.detail);
}

/**
 * herdr says this when the pane exists but its shell has not come up yet. A pane
 * split and `cd`-ed a moment ago is sometimes still starting, which killed two live
 * runs at the fan-in step before this was here.
 */
function paneNotReady(e: HerdrError): boolean {
  return /agent_pane_busy|not an available shell/.test(e.detail);
}

/**
 * A harness may stop on a first-run prompt — claude asks before it will work in a
 * directory it has not been trusted with, and the dialog cannot be answered from here:
 * it shuffles its options, so there is no safe key to send. The agent exists and is
 * blocked, so this waits for the human exactly as a Step waits for an Output.
 */
/**
 * The mode the agent this step continues was started with, from the run record. Absent
 * when the chain's head never ran in this Run, or was recorded before the mode was.
 */
function chainMode(o: EngineOptions, step: ResolvedStep): string | null {
  if (!step.agent) return null;
  const seen = new Set<string>();
  let id: string | undefined = step.agent;
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const recorded = o.run.record.steps.find((s) => s.id === id)?.variants[0];
    if (recorded?.permissions) return recorded.permissions;
    id = o.wf.steps.find((s) => s.id === id)?.agent;
  }
  return null;
}

/**
 * The mode this agent starts in: the Step's own, else the Run's default. An unknown one
 * fails the step rather than falling back, because the fallback would be `bypass` and a
 * typo would then start an agent unattended. Validation normally catches it before a tab
 * opens, but a chained Run and a resumed Driver resolve a Workflow without validating it,
 * so this is the last place that can still refuse.
 */
const permissionMode = Effect.fn("Engine.permissionMode")(function* (
  step: ResolvedStep,
  variant: Variant,
  defaults: Defaults,
) {
  const named = variant.permissions ?? defaults.permissions;
  if (isPermissionMode(named)) return named;
  return yield* Effect.fail(
    new Error(`${step.id}: unknown permissions "${named}" (known: ${PERMISSION_MODES.join(", ")})`),
  );
});

/**
 * Refuses the step before a tab opens where compaction is on and one of the harnesses
 * about to be launched cannot be managed through the interface Collie verified. Warning
 * and starting the agent anyway is how a partial-harness feature ships: the whole point
 * of the gate is that an unmanaged agent is not a quiet telemetry problem.
 */
const gateCompaction = Effect.fn("Engine.gateCompaction")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  harnesses: ReadonlyArray<string>,
) {
  yield* gateHarnesses(yield* compactionDeps(o), harnesses).pipe(
    Effect.mapError((cause) => new Error(`${step.id}: ${reason(cause)}`)),
  );
});

const startAgent = Effect.fn("Engine.startAgent")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  opts: { name: string; kind: string; paneId: string; args: string[] },
) {
  const startError = yield* startWhenReady(o, opts).pipe(
    Effect.as(Option.none<HerdrError>()),
    Effect.catchTag("HerdrError", (error) => Effect.succeed(Option.some(error))),
  );
  if (Option.isNone(startError)) return;
  const error = startError.value;
  if (!blockedAtStartup(error)) return yield* Effect.fail(error);

  const budget = o.handoffTimeoutMs ?? 0;
  yield* o.out(`  ⏸ ${opts.name} is waiting for you in its pane — answer the prompt there`);
  yield* o.run.log(`${opts.name}: blocked at startup, waiting for the human`);
  o.run.record.awaiting = step.id;
  yield* o.run.save();
  yield* notify(o, "needs-you", `${step.id}: answer the prompt in its pane`, { step: step.id });

  const deadline = (yield* Clock.currentTimeMillis) + budget;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(
      Math.min(o.outputPollMs ?? 2000, Math.max(1, deadline - (yield* Clock.currentTimeMillis))),
    );
    if ((yield* o.herdr.agentStatus(opts.name)) !== "blocked") {
      yield* o.out(`  ▸ ${opts.name} is ready`);
      o.run.record.awaiting = null;
      yield* o.run.save();
      return;
    }
  }
  return yield* Effect.fail(error);
});

/** `agent start`, waiting out a pane whose shell is still coming up. */
const startWhenReady = Effect.fn("Engine.startWhenReady")(function* (
  o: EngineOptions,
  opts: { name: string; kind: string; paneId: string; args: string[] },
) {
  const tries = 6;
  for (let attempt = 1; ; attempt++) {
    const failure = yield* o.herdr.agentStart(opts).pipe(
      Effect.as(Option.none<HerdrError>()),
      Effect.catchTag("HerdrError", (error) => Effect.succeed(Option.some(error))),
    );
    if (Option.isNone(failure)) return;
    const error = failure.value;
    if (!paneNotReady(error) || attempt === tries) return yield* Effect.fail(error);
    yield* o.run.log(
      `${opts.name}: pane ${opts.paneId} is not a shell yet, retrying (${attempt}/${tries})`,
    );
    yield* Effect.sleep(Math.min(o.outputPollMs ?? 1000, 1000));
  }
});

/**
 * A settled agent does not mean a finished Step: an interviewing agent goes idle
 * waiting for the human. The Output file is the completion signal, so keep
 * waiting for it and toast once so the human knows they are needed.
 */
/**
 * Has the agent written anything? A file that exists but is blank is a write that
 * has not happened — or one caught half-done — not an empty answer.
 */
const written = Effect.fn("Engine.written")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path))) return false;
  return (yield* fs.readFileString(path)).trim() !== "";
});

const awaitOutput = Effect.fn("Engine.awaitOutput")(function* (
  o: EngineOptions,
  agent: string,
  stepId: string,
  path: string,
) {
  if (yield* written(path)) return;
  const budget = o.handoffTimeoutMs ?? 0;
  if (budget <= 0) return;

  yield* o.out(`  ⏸ ${agent} is waiting for you in its tab`);
  o.run.record.awaiting = stepId;
  yield* o.run.save();
  yield* notify(o, "needs-you", `${stepId}: answer the agent in its tab`, { step: stepId });
  const poll = o.outputPollMs ?? 2000;
  const deadline = (yield* Clock.currentTimeMillis) + budget;
  while (!(yield* written(path)) && (yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(Math.min(poll, Math.max(1, deadline - (yield* Clock.currentTimeMillis))));
  }
  if (yield* written(path)) yield* o.out(`  ▸ ${agent} produced its Output`);
  o.run.record.awaiting = null;
  yield* o.run.save();
});

/**
 * One Output the agent could not write correctly, handed back to that same agent with
 * the reason. It is still in its pane holding the work; re-running the step from
 * scratch would throw a whole round away over a write. Once per variant per
 * iteration, and never to a fresh agent — a new one has none of the context and
 * would write a plausible, empty-headed file.
 */
const repairOutput = Effect.fn("Engine.repairOutput")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  step: ResolvedStep,
  record: VariantRecord,
  variantKey: string | null,
  problem: string,
) {
  const pathService = yield* Path.Path;
  if (!step.output || record.repairs.length > 0) return null;
  const status = yield* o.herdr
    .agentStatus(record.agent)
    .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));
  if (status !== "idle" && status !== "done") return null;

  const path = pathService.join(yield* o.run.stepDir(step.id, variantKey), step.output);
  const relative = pathService.relative(o.run.record.cwd, path);
  yield* o.out(`  ↻ ${record.label} — asking it to write ${step.output} again`);
  yield* o.run.log(`${step.id}: repairing ${record.output ?? step.output}: ${problem}`);
  // A prompt that cannot be delivered — the agent is gone, the socket is not there —
  // is a repair that did not happen, not a Run that failed: the step still has the
  // Output problem it had, and that is what the human needs to be told about.
  const asked = yield* sendTo(o, record, {
    text: `Your Output file is not usable: ${problem}. Write ${relative} again — the JSON your step described, nothing else. Do not redo the work, do not explain, do not write anything outside that file. It is the only thing missing.\nOUTPUT_PATH: ${path}`,
    cause: { kind: "repair", ref: `${step.id}#${o.run.record.iteration}` },
    requestId: `${o.run.id}-repair-${step.id}-${variantKey ?? ""}-${o.run.record.iteration}`,
    attempt: record.repairs.length + 1,
    intentVersion: ctx.steering.intentVersion,
  });
  if (!asked) return null;
  // Recorded once it has actually been asked: a repair that was never delivered must
  // not make the summary say the Output was rewritten, or the toast say the agent was
  // asked already.
  record.repairs.push(problem);
  record.status = "running";
  record.error = null;
  // An agent that goes quiet writing one file is as stuck as one that goes quiet
  // doing the work, and the Driver holds it to the same bound.
  const stuck = yield* awaitAgent(o, ctx, step, record);
  return yield* collectWatched(o, ctx, step, record, variantKey, stuck);
});

/**
 * Read what an agent produced, given how its turn ended. An agent can write its Output
 * and then sit on a background process that never returns: the work is done, only the
 * process is stuck. So a give-up still reads what is there — without waiting, since
 * nobody is coming — and blocks only when there is nothing.
 */
const collectWatched = Effect.fn("Engine.collectWatched")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  step: ResolvedStep,
  record: VariantRecord,
  variantKey: string | null,
  stuck: string | null,
) {
  const outcome: VariantOutcome = yield* collect(o, step, record, variantKey, !stuck);
  if (stuck && outcome.record.status !== "done") {
    outcome.record.status = "blocked";
    outcome.record.error = stuck;
    outcome.stuck = true;
  }
  // The Run has just produced something, which is the moment its rules can be checked
  // against what is actually there. Rules only: a judgement costs money and belongs at a
  // boundary, and a fact Collie can check itself is one it should never pay to have judged.
  yield* checkDrift(o, ctx, `${step.id} collected`);
  yield* writeCard(o, ctx, {
    kind: step.id.startsWith("review") ? "review" : "slice",
    step: step.id,
    claims: outcome.record.output === null ? [] : [`wrote ${outcome.record.output}`],
  });
  return outcome;
});

/**
 * The review this target already had, for the prompts that are about to look at it
 * again. Read once per run: reviewing is a rally, and the second review's job is to
 * say what happened to the first one's findings, not to write them again.
 */
const previousReviewVars = Effect.fn("Engine.previousReviewVars")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // Empty, not "(none)": a first review should not read a heading for a review that
  // does not exist, and a template has no way to leave the section out itself.
  const none = { review: "", when: "never", run: "" };
  const target = o.run.record.inputs.target ?? "";
  if (target === "") return none;
  const store = new RunStore(o.env.stateDir);
  const named = o.run.record.inputs.previous;
  // `worktree` names no change: every review of this checkout's working tree carries
  // it, so matching on it would hand this review an unrelated branch's findings. Only
  // a target that identifies the change is looked up; a run named by hand still is.
  if (!named && target === "worktree") return none;
  const previous = named
    ? yield* store.load(named).pipe(Effect.catch(() => Effect.succeed(null)))
    : yield* store.previousReview(o.run.record.cwd, target, o.run.id, o.run.record.task);
  if (!previous) return none;
  const file = pathService.join(previous.dir, REVIEW_FILE);
  const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  if (text.trim() === "") return none;
  o.run.record.previous_review = previous.id;
  yield* o.run.save();
  const when = ago(
    previous.record.finished_at ?? previous.record.created_at,
    yield* Clock.currentTimeMillis,
  );
  return {
    // The heading travels with the review, so the section disappears with it. The
    // instructions about what to do with it stay in the workflow, where a fork can
    // change them.
    review: `Earlier review of this target (${when}):\n\n${text.trim()}`,
    when,
    run: previous.id,
  };
});

/**
 * The Run's own steering journals, read the way a Driver has to read them: a file it
 * cannot read says nothing, and nothing is not a reason to fail the work. Every caller
 * below wants that, so it is one name rather than a `catch` at each of them.
 */
const intentOf = (o: EngineOptions) =>
  readIntent(o.run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
const driftOf = (o: EngineOptions) =>
  readDrift(o.run.dir).pipe(Effect.catch(() => Effect.succeed([])));
const verificationsOf = (o: EngineOptions) =>
  readVerifications(o.run.dir).pipe(Effect.catch(() => Effect.succeed([])));
const electionsOf = (file: string) =>
  readElections(file).pipe(Effect.catch(() => Effect.succeed([])));
/** The Herd this Run is in, or none: no socket is a Driver with no Herd to write to. */
const herdKeyOf = (o: EngineOptions) =>
  herdOf(o.env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));

/**
 * One message to one of this Run's agents, through its own Dispatcher transaction.
 * `false` where nothing was sent, whatever the reason — the caller records that as its
 * own kind of failure, and none of them is a reason for the Run to end.
 */
/**
 * What a step prompt is about, for the ledger. The variant as well as the step: a Choice
 * step's rounds are separate pieces of work in one step, and a key that could not tell
 * them apart would read the second round as a repeat of the first.
 */
const stepCause = (step: ResolvedStep, key: string | null, run: Run): Cause => ({
  kind: "step",
  ref: `${step.id}/${key ?? ""}#${run.record.iteration}`,
});

const sendTo = Effect.fn("Engine.sendTo")(function* (
  o: EngineOptions,
  record: VariantRecord,
  draft: {
    readonly text: string;
    readonly cause: Cause;
    readonly requestId: string;
    readonly attempt: number;
    readonly intentVersion: number;
    /** Default `boundary`; anything else is gated on what this harness has been shown to do. */
    readonly mode?: "boundary" | "now" | "interrupt";
  },
) {
  const deps = dispatcherDeps(o);
  const entry = yield* agentEntry(o, record);
  if (entry.entry === null) {
    yield* o.run.log(`${draft.cause.kind} to ${record.agent}: ${entry.reason}`);
    return false;
  }
  const addressed = entry.entry;
  const mode = draft.mode ?? "boundary";
  const carried = {
    run: o.run.id,
    harness: record.harness,
    cause: draft.cause,
    mode,
    intentVersion: draft.intentVersion,
    attempt: draft.attempt,
    requestId: draft.requestId,
  };
  return yield* dispatch
    .transaction(deps, addressed, (channel) =>
      // An interrupt is keys and then the text; the text alone is a `now` under
      // an interrupt's name.
      mode === "interrupt"
        ? dispatch.interrupt(
            {
              ...deps,
              status: (agent) =>
                o.herdr.agentStatus(agent).pipe(Effect.catch(() => Effect.succeed("unknown"))),
            },
            channel,
            addressed,
            draft.text,
            carried,
          )
        : channel.submit(draft.text, carried),
    )
    .pipe(
      Effect.flatMap((outcome) =>
        outcome.ok
          ? Effect.succeed(true)
          : o.run
              .log(`${draft.cause.kind} to ${record.agent} not sent: ${outcome.reason}`)
              .pipe(Effect.as(false)),
      ),
      Effect.catch((cause) =>
        o.run
          .log(`${draft.cause.kind} to ${record.agent} refused: ${reason(cause)}`)
          .pipe(Effect.as(false)),
      ),
    );
});

/**
 * Whether anyone has typed into one of this Run's agents. A submission Collie did not
 * make means a human is steering that pane directly, and automatic corrections to it
 * stop until someone explicitly clears the override — Collie never argues with a human
 * through the same keyboard.
 *
 * The count is compared against what was seen last time rather than the file being
 * consumed: the telemetry belongs to the compaction controls, and two readers deleting
 * from it would be two owners of one journal.
 */
const noticeOverrides = Effect.fn("Engine.noticeOverrides")(function* (
  o: EngineOptions,
  ctx: RunCtx,
) {
  for (const record of ctx.groups.values()) {
    const dir = yield* controlDir(o.env.stateDir, record.agent);
    const seen = yield* externalSubmissions(dir).pipe(Effect.catch(() => Effect.succeed(0)));
    if (seen <= (ctx.steering.externals.get(record.agent) ?? 0)) continue;
    ctx.steering.externals.set(record.agent, seen);
    const addressed = yield* agentEntry(o, record);
    const terminalId = addressed.entry?.incarnation?.terminalId;
    if (terminalId === undefined) continue;
    yield* appendLine(yield* ledgerPath(o.env.stateDir, terminalId), {
      kind: "manual_override",
      at: yield* nowIso(),
      incarnation: terminalId,
      by: "hook:UserPromptSubmit",
    });
    yield* o.run.log(`${record.agent}: manual_override — someone typed into its pane`);
  }
});

/**
 * Every rule constraint this Run has, checked against what is actually there, and any new
 * breach written down. Called wherever the Run has just produced something and at the
 * boundary before it takes on more, because those are the two moments the answer can
 * change.
 *
 * Never fatal, and never blocking: a check that could not read the tree says nothing,
 * which is what "no evidence" looks like.
 */
/**
 * What a Judgement is made with, and where its call is written down. `evaluationDeps` is
 * where the execution bounds are decided, so the CLI and the Driver call alike.
 */
const judgementDeps = Effect.fn("Engine.judgementDeps")(function* (o: EngineOptions) {
  const key = yield* herdKeyOf(o);
  if (key === null) return null;
  const built = yield* evaluationDeps(o.env);
  return {
    evaluator: built.evaluator,
    budgetFile: yield* budgetPath(o.env.stateDir, key),
    limits: built.limits,
    newId: newRequestId().pipe(Effect.orDie),
    // A journal write that will not happen must not be what stops a judgement.
    log: (line: string) => Effect.ignore(o.run.log(line)),
  } satisfies JudgementDeps;
});

/**
 * The semantic half of a drift check: one Judgement at a boundary and at `finish`, never
 * at `collect` (SPEC §7.9). A fact Collie can check itself is never paid for; a judgement
 * that could not be made is recorded as skipped, which keeps the Run `unverified` rather
 * than letting it read as checked.
 */
const judgeDrift = Effect.fn("Engine.judgeDrift")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  intent: Intent,
  at: string,
  final: boolean,
) {
  // A goal is judged once, at `finish`. It is what `aligned` needs and there is nothing
  // to correct from it mid-Run, so judging it at every boundary would spend a Run's whole
  // grant on the same question. Semantic constraints are different: a correction can go
  // out about one, so they are judged at every boundary as SPEC §7.9 asks.
  const semantic = intent.constraints.some((constraint) => constraint.kind === "semantic");
  if (!final && !semantic) return;
  const deps = yield* judgementDeps(o);
  if (deps === null) {
    yield* recordSkipped(o.run.dir, o.run.id, "there is no Herd to charge a judgement to");
    return;
  }
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const outcome = yield* judge(deps, intent, {
    runDir: o.run.dir,
    worktree: cwd,
    base: yield* baseOf(cwd),
    at: yield* nowIso(),
  }).pipe(
    // A judgement that fell over is a judgement that did not happen, and no Driver stops
    // a Run over one (SPEC §9.3). The skipped line is what keeps the Run honest.
    Effect.catch((cause) =>
      Effect.gen(function* () {
        yield* recordSkipped(o.run.dir, o.run.id, `the judgement failed: ${reason(cause)}`);
        return { judged: NOT_JUDGED, reports: [] } satisfies Judgement;
      }),
    ),
  );
  ctx.judged = outcome.judged;

  const before = yield* driftOf(o);
  for (const report of newReports(outcome.reports, before)) {
    yield* appendDrift(o.run.dir, report);
    yield* o.run.log(
      `drift at ${at}: ${report.constraint} (${report.severity}) — judged against ${
        report.evidence.length
      } piece(s) of evidence`,
    );
  }
});

const checkDrift = Effect.fn("Engine.checkDrift")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  at: string,
  /** Whether to judge what Collie cannot check by itself. `collect` never does. */
  judging: "none" | "boundary" | "finish" = "none",
) {
  const intent = yield* intentOf(o);
  if (intent === null) return;
  if (judging !== "none") yield* judgeDrift(o, ctx, intent, at, judging === "finish");
  const rules = intent.constraints.some((constraint) => constraint.kind === "rule");
  if (rules) yield* checkRuleDrift(o, intent, at);
  // With no rule to check there may still be something to correct, from the judgement.
  if (rules || judging !== "none") yield* correctDrift(o, ctx, intent);
});

/** The half Collie establishes itself: what the rules say about the evidence, recorded. */
const checkRuleDrift = Effect.fn("Engine.checkRuleDrift")(function* (
  o: EngineOptions,
  intent: Intent,
  at: string,
) {
  const facts = yield* ruleFacts(o);
  const now = yield* nowIso();
  const found = checkRules(intent, facts, now);
  const before = yield* driftOf(o);
  const fresh = newReports(found, before);
  for (const report of fresh) {
    yield* appendDrift(o.run.dir, report);
    yield* o.run.log(
      `drift at ${at}: ${report.constraint} (${report.severity}) — ${report.evidence
        .map((ref) => ref.path ?? ref.excerpt ?? ref.kind)
        .join(", ")}`,
    );
  }
  // A report that was open and is no longer found is one the work came back from — but
  // only where the check actually found fewer things. Re-checking an unchanged tree finds
  // the same ones, and calling that a fix would clear a report nobody acted on.
  for (const report of openReports(before))
    if (!found.some((still) => still.constraint === report.constraint)) {
      yield* appendDrift(o.run.dir, { ...report, at: now, resolution: "verified" });
      yield* o.run.log(`drift ${report.constraint} cleared at ${at}`);
    }
});

/**
 * Send what this Run's own authority lets Collie send about its open drift, and give up
 * where it does not. Every refusal is somebody being deferred to: the human at that
 * keyboard, the human who held the Run, the human who never granted this.
 *
 * A correction is `correction_submitted`, never `corrected` and never `verified`. Sending
 * text is not the same as the work changing, and only new evidence settles that.
 */
const correctDrift = Effect.fn("Engine.correctDrift")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  intent: Intent,
) {
  if (!intent.authority.auto_correct) return;
  const lines = yield* driftOf(o);
  const open = openReports(lines);
  if (open.length === 0) return;

  for (const record of ctx.groups.values()) {
    const addressed = yield* agentEntry(o, record);
    const entry = addressed.entry;
    const terminalId = entry?.incarnation?.terminalId;
    if (!entry || terminalId === undefined) continue;

    const ledger = yield* readLedger(yield* ledgerPath(o.env.stateDir, terminalId));
    const deliveries = [...newestById(ledger).values()];
    const sentSoFar = correctionsSent(deliveries);
    const decided = decideCorrections(intent, open, {
      overridden: overrideActive(ledger),
      attributable: capabilitiesOf(record.harness)?.attribution.status === "proven",
      held: ctx.steering.held !== null,
      sent: sentSoFar,
      inFlight: new Set(
        deliveries
          .filter((entry) => entry.cause.kind === "correction" && !SETTLED.has(entry.state))
          .map((entry) => entry.cause.ref),
      ),
      nowProven: capabilitiesOf(record.harness)?.now.status === "proven",
    });

    for (const { report, mode } of decided) {
      const constraint = intent.constraints.find((entry) => entry.id === report.constraint);
      if (!constraint) continue;
      const requestId = `${o.run.id}-correction-${report.constraint}-${intent.version}`;
      const sent = yield* sendTo(o, record, {
        text: correctionText(requestId, constraint, report),
        cause: correctionCause(report),
        requestId,
        attempt: (sentSoFar[report.constraint] ?? 0) + 1,
        intentVersion: intent.version,
        mode,
      });
      if (!sent) continue;
      yield* appendDrift(o.run.dir, {
        ...report,
        at: yield* nowIso(),
        resolution: "correction_submitted",
        correction: requestId,
      });
      yield* notify(o, "correction-sent", report.constraint, { step: report.constraint });
      yield* o.run.log(`correction sent for ${report.constraint} (${mode})`);
    }

    // The bound is spent and it is still open: nothing else Collie can do about it.
    for (const report of open) {
      if (report.resolution === "escalated") continue;
      if ((sentSoFar[report.constraint] ?? 0) < intent.authority.max_corrections_per_constraint)
        continue;
      if (decided.some((entry) => entry.report.constraint === report.constraint)) continue;
      yield* appendDrift(o.run.dir, { ...report, at: yield* nowIso(), resolution: "escalated" });
      yield* notify(o, "drift-unresolved", report.constraint, { step: report.constraint });
      yield* o.run.log(`drift ${report.constraint} escalated: the correction bound is spent`);
    }
  }
});

/**
 * What a finished Run leaves behind: nothing queued that will never go out, an honest
 * answer about whether the work is what was asked for, and — where something is still
 * open and blocking — a proposal for the human rather than another prompt to an agent.
 *
 * A finished Run is immutable. Nothing here re-prompts anybody; the follow-up is a
 * proposal for a *child* Run, and it waits for a yes like everything else.
 */
const settleAtFinish = Effect.fn("Engine.settleAtFinish")(function* (
  o: EngineOptions,
  ctx: RunCtx,
) {
  // A boundary delivery is composed into the next piece of work. There is no next piece
  // of work, so saying so is better than leaving it looking pending for ever.
  for (const command of ctx.steering.deliveries) {
    const deliver = command.deliver;
    if (!deliver) continue;
    const cause = { kind: "steer" as const, ref: deliver.deliveryId };
    yield* appendLine(yield* ledgerPath(o.env.stateDir, deliver.incarnation), {
      id: deliver.deliveryId,
      at: yield* nowIso(),
      run: o.run.id,
      incarnation: deliver.incarnation,
      agent: deliver.agent,
      causal_key: causalKey(o.run.id, cause, deliver.intentVersion),
      request_id: command.requestId,
      cause,
      mode: deliver.mode,
      text_hash: textHash(deliver.text),
      intent_version: deliver.intentVersion,
      attempt: deliver.attempt,
      state: "expired",
      note: "the Run finished before there was any work to compose it into",
    }).pipe(Effect.ignore);
  }
  ctx.steering.deliveries = [];

  const intent = yield* intentOf(o);
  const lines = yield* driftOf(o);
  // What the Judgement at `finish` actually got to, not an assumption about it: a
  // skipped or refused judgement leaves these false and the verdict `unverified`.
  const verdict = alignment(intent, lines, ctx.judged);
  yield* o.run.log(`aligned: ${verdict.aligned} — ${verdict.why}`);

  const blocking = openReports(lines).filter((report) => report.severity === "block");
  if (blocking.length === 0) return;
  yield* proposeFollowup(o, blocking);
});

/**
 * A finished Run with open blocking drift, offered as a child Run rather than acted on.
 * `origin: driver`, so every action in it is pending however much authority the Run had:
 * starting work is a decision, and a Run that has ended is not one Collie may extend.
 */
const proposeFollowup = Effect.fn("Engine.proposeFollowup")(function* (
  o: EngineOptions,
  blocking: ReadonlyArray<{ readonly constraint: string; readonly evidence: ReadonlyArray<Ref> }>,
) {
  const key = yield* herdKeyOf(o);
  if (key === null) {
    yield* o.run.log("no Herd to record a follow-up proposal in; drift is on the Run's journal");
    return;
  }
  const text = blocking
    .map(
      (report) =>
        `${report.constraint}: ${report.evidence.map((ref) => ref.path ?? ref.excerpt ?? ref.kind).join(", ")}`,
    )
    .join("\n");
  yield* recordProposal(yield* proposalsPath(o.env.stateDir, key), {
    interpretation: `${o.run.id} finished with ${blocking.length} blocking constraint(s) still open`,
    targets: [{ run: o.run.id }],
    actions: [{ kind: "followup", run: o.run.id, text }],
    allowedNow: [],
    intentVersions: {},
    by: `driver:${o.run.id}`,
  }).pipe(
    Effect.tap((recorded) => notify(o, "proposal-pending", o.run.id, { step: recorded.id })),
    Effect.catch((cause) => o.run.log(`could not record a follow-up proposal: ${reason(cause)}`)),
  );
});

/**
 * Whether this Driver takes the Herd's cross-run check this time. Why the Drivers elect
 * one at all, and what a loser's `dirty` line is for, is in `src/drift.ts`.
 *
 * The wake rule is the last clause: a `pending` evaluation makes *every* Driver in the
 * Herd a candidate, not only ones with siblings. Without it an evaluation nobody could
 * finish would wait for a Driver that may never run again.
 *
 * The judgement itself is a model call and no Driver has a grant to spend on one, so a
 * winner at a boundary can snapshot but not evaluate, and it records nothing: saying an
 * evaluation is owed at every boundary would be a mark no later boundary could clear.
 *
 * `pending` is written at `finish` and only there, by a Driver that is leaving and cannot
 * clear what it stood for — the durable unevaluated state §9.6 defines, which the wake
 * rule, the final card's `cross_run` and the attention all read.
 */
const standForElection = Effect.fn("Engine.standForElection")(function* (
  o: EngineOptions,
  at: string,
  leaving = false,
) {
  const key = yield* herdKeyOf(o);
  if (key === null) return;
  const file = yield* electionsPath(o.env.stateDir, key);
  const intent = yield* intentOf(o);
  // `?? null` because a Run with no Intent has `undefined` here, and `undefined !== null`
  // made every Run a candidate for a check about siblings it does not have.
  const related = (intent?.parent ?? null) !== null || o.run.record.children.length > 0;
  const standing = yield* electionsOf(file);
  if (!shouldStand(standing, related)) return;
  const now = yield* nowIso();
  // Standing again at every boundary is the wake rule; saying so again is an unbounded
  // journal. One candidate line per Run per pending.
  if (!alreadyStood(standing, o.run.id))
    yield* appendElection(file, { kind: "candidate", at: now, by: at, run: o.run.id }).pipe(
      Effect.ignore,
    );

  const lock = `${file}.evaluator.lock`;
  yield* withLock(
    lock,
    // Somebody else is doing it. Saying so is not a formality: it is what tells the
    // winner that its snapshot was already out of date.
    appendElection(file, { kind: "dirty", at: now, by: at, run: o.run.id }).pipe(Effect.ignore),
    Effect.gen(function* () {
      // Won it, so this Driver is the one caller. The vector is the snapshot the
      // judgement is made from and written down either way, because an election that
      // recorded a check without looking would be the worst of both. Standing under a
      // `pending`, the Runs it names are in the snapshot too — that is what the wake
      // rule is for — so the Judgement made here is the one the Herd owed.
      const owed = pendingEvaluation(standing)?.runs ?? [];
      let snapshotAt = now;
      let passes = 0;
      while (true) {
        const targets = yield* versionVector(o, owed);
        yield* o.run.log(
          `cross-run vector at ${snapshotAt}: ${targets.map((t) => t.line).join("; ")}`,
        );
        const why = yield* judgeCrossRun(o, targets, snapshotAt).pipe(
          // A judgement that fell over never stops a worker (SPEC §9.3): it becomes the
          // reason a `pending` is written instead.
          Effect.catch((cause) => Effect.succeed(`the judgement failed: ${reason(cause)}`)),
        );
        if (why !== null) {
          yield* o.run.log(`cross-run judgement not made at ${snapshotAt}: ${why}`);
          // Not leaving: the next boundary stands again, and a mark at every boundary
          // nobody could pay for would be a mark no later boundary could clear.
          if (!leaving) return;
          const pending = pendingEvaluation(yield* readElections(file));
          if (pending !== null) {
            yield* o.run.log(`cross-run evaluation still pending since ${pending.since}`);
            return;
          }
          yield* markPending(o, file, now, "nobody could make it");
          return;
        }
        // Answered — for the snapshot it was made from. A loser's `dirty` newer than that
        // snapshot means something moved while the call was out, so what was judged is
        // already behind: snapshot again and judge once more, a bounded number of times.
        const lines = yield* readElections(file);
        if (!staleSince(lines, snapshotAt)) {
          if (pendingEvaluation(lines) === null && owed.length > 0)
            yield* o.run.log(`cross-run evaluation owed for ${owed.join(", ")} was made`);
          return;
        }
        if (passes >= EXTRA_PASSES) {
          // Still moving after the extra passes: durable, unevaluated state, which the
          // wake rule hands to the next Driver event anywhere in the Herd.
          yield* markPending(o, file, yield* nowIso(), "the Herd kept moving through the passes");
          return;
        }
        passes += 1;
        snapshotAt = yield* nowIso();
        yield* o.run.log(`cross-run snapshot went stale; judging again (extra pass ${passes})`);
      }
    }),
  ).pipe(Effect.ignore);
});

/**
 * The `pending` line §9.6 defines. Everything the relationship spans is named, not just
 * this Run's own side of it: a parent that only named its children would leave each
 * sibling's final card saying nothing is owed.
 */
const markPending = Effect.fn("Engine.markPending")(function* (
  o: EngineOptions,
  file: string,
  since: string,
  why: string,
) {
  const runs = yield* relatedRuns(o);
  yield* appendElection(file, { kind: "pending", since, runs }).pipe(Effect.ignore);
  yield* o.run.log(`cross-run evaluation pending for ${runs.join(", ")}: ${why}`);
});

/**
 * Every Run the cross-run question is about: this one, its children, its parent and that
 * parent's other children. A relationship has more than one side, and a `pending` naming
 * one side leaves the others reporting that nothing is owed.
 */
const relatedRuns = Effect.fn("Engine.relatedRuns")(function* (o: EngineOptions) {
  const store = new RunStore(o.env.stateDir);
  const ids = new Set([o.run.id, ...o.run.record.children]);
  const parentId = o.run.record.parent;
  if (parentId !== null) {
    ids.add(parentId);
    const parent = yield* store.load(parentId).pipe(Effect.catch(() => Effect.succeed(null)));
    for (const sibling of parent?.record.children ?? []) ids.add(sibling);
  }
  return [...ids];
});

/** What one approved verification may take before the finish stops waiting for it. */
const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;

/** One related Run as the cross-run question sees it: the vector, and what it is about. */
interface CrossRunTarget {
  readonly id: string;
  readonly dir: string;
  readonly intentVersion: number;
  readonly cardId: string | null;
  readonly goal: string | null;
  readonly constraints: ReadonlyArray<string>;
  readonly open: number;
  /** The vector as one line, which is what the log and the pack both show. */
  readonly line: string;
}

/**
 * What a Judgement is given: every related Run's current Intent version, its newest card
 * and how much drift is open on it. Read whether or not anyone can judge it, because the
 * alternative is an election that says a check happened without ever looking.
 */
const versionVector = Effect.fn("Engine.versionVector")(function* (
  o: EngineOptions,
  /** Runs a `pending` evaluation named, which this snapshot is answering for as well. */
  owed: ReadonlyArray<string> = [],
) {
  const store = new RunStore(o.env.stateDir);
  const targets: CrossRunTarget[] = [];
  for (const id of new Set([...(yield* relatedRuns(o)), ...owed])) {
    const run = yield* store.load(id).pipe(Effect.catch(() => Effect.succeed(null)));
    if (run === null) continue;
    const intent = yield* readIntent(run.dir).pipe(Effect.catch(() => Effect.succeed(null)));
    const cards = yield* readCards(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
    const open = openReports(
      yield* readDrift(run.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    const card = cards.at(-1);
    targets.push({
      id,
      dir: run.dir,
      intentVersion: intent?.version ?? 0,
      cardId: card?.id ?? null,
      goal: intent?.goal ?? null,
      constraints: (intent?.constraints ?? []).map(
        (constraint) =>
          `${constraint.id} (${constraint.kind}/${constraint.severity}): ${constraint.text}`,
      ),
      open: open.length,
      line: `${id} v${intent?.version ?? 0} ${card === undefined ? "no card" : `${card.id}@${card.revision.head_sha.slice(0, 8)}`} drift ${open.length}`,
    });
  }
  return targets;
});

/**
 * The cross-run question, as the one thing the model is asked: what each related Run was
 * for, what bounds it, and where each has got to. No diff and no transcript — this is a
 * judgement about how Runs relate, not about anybody's code.
 */
function crossRunPack(targets: ReadonlyArray<CrossRunTarget>): string {
  return [
    "These Runs are related — a parent and its children, or siblings of one parent.",
    "Report only where one Run's work breaks what another Run was told to respect.",
    "",
    ...targets.flatMap((target) => [
      `run: ${target.id}`,
      `  vector: ${target.line}`,
      `  goal: ${target.goal ?? "(none stated)"}`,
      ...target.constraints.map((constraint) => `  constraint: ${constraint}`),
    ]),
  ].join("\n");
}

/**
 * The Judgement the election exists to make: one call over the version vector, and a
 * `drift_report` into each target Run's **own** inbox, because that Run's Driver is the
 * only writer of its drift journal and the only thing that can revalidate the vector the
 * report was judged against (SPEC §9.6).
 *
 * Recorded against the electing Run rather than the Herd alone: the Run whose boundary
 * triggered this is the one the call was for, and usage is shown per Run.
 */
const judgeCrossRun = Effect.fn("Engine.judgeCrossRun")(function* (
  o: EngineOptions,
  targets: ReadonlyArray<CrossRunTarget>,
  at: string,
) {
  const intent = yield* intentOf(o);
  if (intent === null) return "no Intent to charge a cross-run judgement to";
  const key = yield* herdKeyOf(o);
  const deps = key === null ? null : yield* judgementDeps(o);
  if (key === null || deps === null) return "no Herd to charge a cross-run judgement to";

  const asked = yield* askJudgement(deps, o.run.id, crossRunPack(targets));
  if (asked.refused !== null) return asked.refused;

  const byId = new Map(targets.map((target) => [target.id, target]));
  let written = 0;
  for (const report of asked.reports) {
    // Only a Run this question was actually about: a report naming anything else is a
    // model reaching outside what it was shown, and it is dropped rather than delivered.
    const target = byId.get(report.run);
    if (target === undefined) {
      yield* o.run.log(`cross-run report about "${report.run}", which is not related; dropped`);
      continue;
    }
    yield* writeInbox(target.dir, {
      type: "drift_report",
      requestId: yield* newRequestId().pipe(Effect.orDie),
      report: { ...report, at, intent_version: target.intentVersion, resolution: "open" },
      vector: { intentVersion: target.intentVersion, cardId: target.cardId },
    }).pipe(Effect.ignore);
    written += 1;
  }
  yield* o.run.log(`cross-run judged at ${at}: ${written} report(s) delivered`);
  // Written down, so every target's final card can say the question was answered rather
  // than that there never was one. A later `dirty` makes it stale again.
  const elections = yield* electionsPath(o.env.stateDir, key);
  yield* appendElection(elections, {
    kind: "evaluated",
    at,
    by: o.run.id,
    runs: targets.map((target) => target.id),
  }).pipe(Effect.ignore);
  return null;
});

/**
 * The verifications the human granted, run once at the end for the rules that need one.
 * At finish and nowhere else: a `command_exit` rule is checked at every boundary, and
 * running a test suite each time would be a Run that spends its life verifying itself.
 */
const runGrantedVerifications = Effect.fn("Engine.runGrantedVerifications")(function* (
  o: EngineOptions,
) {
  const intent = yield* intentOf(o);
  const approved = intent?.authority.run_verification ?? [];
  if (approved.length === 0) return;
  const wanted = new Set(
    (intent?.constraints ?? []).flatMap((constraint) =>
      constraint.rule?.kind === "command_exit" ? [constraint.rule.name] : [],
    ),
  );
  const already = new Set((yield* verificationsOf(o)).map((record) => record.name));
  const run = {
    id: o.run.id,
    cwd: o.run.record.cwd,
    worktree: o.run.record.worktree?.path ?? null,
  };
  for (const spec of approved) {
    if (!wanted.has(spec.name) || already.has(spec.name)) continue;
    // Bounded, because this runs while the Run is finishing: an approved command that
    // hangs would hold the final card, the status and the worktree release behind it for
    // ever, and one permitted verification cannot be allowed to do that.
    const outcome = yield* runApproved(o.run.dir, run, approved, spec).pipe(
      Effect.map((record) => `${record.result} (exit ${record.exit})`),
      Effect.catch((cause) => Effect.succeed(`refused — ${cause.why}`)),
      Effect.timeoutOption(VERIFICATION_TIMEOUT_MS),
    );
    yield* o.run.log(
      `verification ${spec.name}: ${
        outcome._tag === "Some" ? outcome.value : `gave up after ${VERIFICATION_TIMEOUT_MS / 1000}s`
      }`,
    );
  }
});

/**
 * What the Herd's elections say about this Run: `pending` when an evaluation names it and
 * nobody has made it, `evaluated` only where a Judgement was actually written down —
 * being elected is not a check, which is the claim §9.6 exists to avoid.
 *
 * The final card only. A slice written mid-run is about work in progress, and a Run whose
 * Driver is still going has not yet failed to make the check.
 */
const crossRunState = Effect.fn("Engine.crossRunState")(function* (
  o: EngineOptions,
  kind: Card["kind"],
) {
  if (kind !== "final") return "none";
  const key = yield* herdKeyOf(o);
  if (key === null) return "none";
  const file = yield* electionsPath(o.env.stateDir, key);
  const lines = yield* electionsOf(file);
  const pending = pendingEvaluation(lines);
  if (pending !== null && pending.runs.includes(o.run.id)) return "pending" as const;
  // `none` is "there was nothing to check", so a Judgement that was made has to say so.
  return evaluatedFor(lines, o.run.id) ? ("evaluated" as const) : ("none" as const);
});

/**
 * One card for one slice of work, from what is already recorded. Everything here is a
 * view of evidence that exists: a card that said something nothing else recorded would be
 * a claim nobody can check.
 *
 * Never fatal. A card is how a human learns what happened; failing a Run because it could
 * not be written would be losing the work to protect the report of it.
 */
const writeCard = Effect.fn("Engine.writeCard")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  what: {
    readonly kind: Card["kind"];
    readonly step: string;
    readonly claims: ReadonlyArray<string>;
  },
) {
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  const base = yield* baseOf(cwd);
  const crossRun = yield* crossRunState(o, what.kind);
  const snapshot = yield* fingerprint(cwd);
  const intent = yield* intentOf(o);
  const lines = yield* driftOf(o);
  const open = openReports(lines);
  const files = yield* shell("git", ["diff", "--name-only", `${base}..HEAD`], cwd);
  const commits = yield* shell("git", ["log", "--oneline", `${base}..HEAD`], cwd);
  const dirty = yield* shell("git", ["status", "--porcelain"], cwd);
  const branch = yield* shell("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const verifications = yield* verificationsOf(o);

  const revision = {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    head_sha: snapshot.head_sha,
    fingerprint: snapshot.fingerprint,
    dirty: dirty.stdout.trim() !== "",
  };
  const links: Card["links"] = o.run.record.mr_url === null ? {} : { mr: o.run.record.mr_url };
  const missing: string[] = [];
  for (const constraint of intent?.constraints ?? []) {
    const rule = constraint.rule;
    if (rule?.kind !== "command_exit") continue;
    if (!verifications.some((entry) => entry.name === rule.name))
      missing.push(`no verification named ${rule.name}`);
  }
  for (const step of o.run.record.steps)
    if (step.status === "done" && step.variants.every((variant) => variant.output === null))
      missing.push(`${step.id} wrote no Output`);
  for (const line of lines)
    if (line.kind === "skipped") missing.push(`a judgement was skipped: ${line.reason}`);

  const card = buildCard({
    run: o.run.id,
    kind: what.kind,
    step: what.step,
    iteration: o.run.record.iteration,
    at: yield* nowIso(),
    intentVersion: intent?.version ?? 0,
    revision,
    changes: {
      files: files.stdout.split("\n").filter((line) => line.trim() !== ""),
      commits: commits.stdout.split("\n").filter((line) => line.trim() !== ""),
    },
    requested: {
      goal: intent?.goal ?? null,
      constraints: (intent?.constraints ?? []).map((constraint) => constraint.text),
    },
    verifications,
    claims: what.claims.map((text) => ({ text, ref: `${o.run.id}:${what.step}` })),
    missing,
    inspect: inspectFor({
      worktree: o.run.record.worktree?.path ?? null,
      base,
      mr: o.run.record.mr_url,
    }),
    links,
    drift: open.map((report) => report.id),
    deliveries: (yield* deliveriesOf(o.env.stateDir, o.run.id).pipe(
      Effect.catch(() => Effect.succeed([])),
    )).map((entry) => entry.delivery.id),
    aligned: alignment(intent, lines, ctx.judged).aligned,
    crossRun,
    significance: {
      readiness: "claimed",
      mrTouched: what.kind === "mr",
      pendingChoice:
        (yield* readChoice(o.run.dir).pipe(Effect.catch(() => Effect.succeed(null)))) !== null,
      driftUnresolved: open.some((report) => report.resolution === "escalated"),
      pendingProposal: (yield* pendingProposalsFor(o)).length > 0,
      correctionUnacknowledged: open.some((r) => r.resolution === "correction_submitted"),
      blockingDrift: open.some((report) => report.severity === "block"),
      correctionSent: open.some((report) => report.correction !== undefined),
      intentChanged: (intent?.version ?? 1) > 1,
      ended: null,
    },
    narrative: null,
  });
  yield* appendCard(o.run.dir, card).pipe(Effect.ignore);
  // Only something a human could act on: a routine card is the ordinary case, and a toast
  // for every one of those is a toast nobody reads.
  if (card.significance === "try-it")
    yield* notify(o, "slice-ready", card.readiness, { step: card.id });
  void ctx;
  return card;
});

/** Proposals about this Run nobody has answered: a card written now is a `decision`. */
const pendingProposalsFor = Effect.fn("Engine.pendingProposalsFor")(function* (o: EngineOptions) {
  const key = yield* herdKeyOf(o);
  if (key === null) return [];
  const file = yield* proposalsPath(o.env.stateDir, key);
  const lines = yield* readProposals(file).pipe(Effect.catch(() => Effect.succeed([])));
  return pendingFor(lines, o.run.id, yield* Clock.currentTimeMillis);
});

/**
 * A card per finished ticket, while the step is still running. That is the point of the
 * checkpoint: a human sees a slice land without waiting for the whole step, and the
 * agent's own words for it are carried as claims and labelled as claims.
 */
const cardsForCheckpoints = Effect.fn("Engine.cardsForCheckpoints")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  step: string,
) {
  for (const { file, checkpoint } of yield* readCheckpoints(o.run.dir).pipe(
    Effect.catch(() => Effect.succeed([])),
  )) {
    if (checkpoint.status !== "done") continue;
    if (ctx.steering.checkpointed.has(file)) continue;
    ctx.steering.checkpointed.add(file);
    yield* writeCard(o, ctx, { kind: "slice", step, claims: checkpoint.claims });
    yield* o.run.log(`card for ${checkpoint.ticket} (${checkpoint.claims.length} claim(s))`);
  }
});

/** Delivery states nothing follows, so a correction with one is not in flight. */
const SETTLED: ReadonlySet<string> = new Set(["verified", "failed", "superseded", "expired"]);

/** What a rule check compares against: the tree, the record, and what has been verified. */
const ruleFacts = Effect.fn("Engine.ruleFacts")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = o.run.record.worktree?.path ?? o.run.record.cwd;
  // What the change is measured against. A worktree Collie made records no base of its
  // own, so the merge-base with the default branch is what "since this work started"
  // means; a repository that cannot answer leaves the comparison at HEAD, which reports
  // only what is uncommitted rather than reporting nothing.
  const base = yield* baseOf(cwd);
  const committed = yield* shell("git", ["diff", "--name-only", `${base}..HEAD`], cwd);
  const dirty = yield* shell("git", ["diff", "--name-only", "HEAD"], cwd);
  // Untracked too: a file an agent created is exactly the case a `protected_paths` rule
  // exists for, and it is in no diff until somebody commits it.
  const untracked = yield* shell("git", ["ls-files", "--others", "--exclude-standard"], cwd);
  const branch = yield* shell("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);

  const outputs: Record<string, Record<string, string>> = {};
  for (const step of o.run.record.steps)
    for (const variant of step.variants) {
      if (!variant.output) continue;
      const file = path.resolve(o.run.dir, variant.output);
      const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
      if (text !== "") outputs[step.id] = flattenOutput(text);
    }

  const verifications: Record<string, { exit: number; ref: string }> = {};
  for (const record of yield* verificationsOf(o))
    verifications[record.name] = { exit: record.exit, ref: record.id };

  return {
    changedFiles: [
      ...new Set(
        `${committed.stdout}\n${dirty.stdout}\n${untracked.stdout}`
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      ),
    ],
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    mrTarget: mrTargetOf(o.run.record.mr_url),
    outputs,
    verifications,
  };
});

/** The commit this Run's changes are measured from, or HEAD where nothing else answers. */
const baseOf = Effect.fn("Engine.baseOf")(function* (cwd: string) {
  const head = yield* shell("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  const upstream = head.code === 0 ? head.stdout.trim() : "origin/main";
  const merged = yield* shell("git", ["merge-base", upstream, "HEAD"], cwd);
  return merged.code === 0 && merged.stdout.trim() !== "" ? merged.stdout.trim() : "HEAD";
});

/** A recorded merge request URL as the project and iid a rule compares against. */
function mrTargetOf(url: string | null): { project: string; iid: string | null } | null {
  if (url === null) return null;
  const found = /https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url);
  return found ? { project: found[1]!, iid: found[2]! } : null;
}

/** What every send from this Driver is made with. One shape, one place it is built. */
function dispatcherDeps(o: EngineOptions): dispatch.DispatcherDeps {
  return {
    stateDir: o.env.stateDir,
    herdr: o.herdr,
    log: (line: string) => o.run.log(line).pipe(Effect.ignore),
  };
}

/**
 * The saved binding for one of this Run's agents wins over the role registry, which
 * another Run can replace. Without either, capture the initial named incarnation:
 * rederiving it on every delivery would compare a restarted agent with itself.
 *
 * An entry with no incarnation is not an answer — herdr had not named a `terminal_id`
 * yet when the agent started, and taking that as final would make a moment's gap in one
 * listing an unsteerable Run for ever. That one is read live and written back, so the
 * next delivery has something to check a restart against. Fan-out variants are never
 * registered and take the same live path.
 */
const agentEntry = Effect.fn("Engine.agentEntry")(function* (
  o: EngineOptions,
  record: VariantRecord,
  role = record.label,
) {
  // A different Run can replace this role's registry entry while this agent is working.
  if (record.incarnation && record.paneId) {
    return {
      entry: {
        role,
        agent: record.agent,
        paneId: record.paneId,
        workspaceId: o.env.workspaceId,
        runId: o.run.id,
        workflow: o.run.record.workflow,
        at: yield* nowIso(),
        incarnation: record.incarnation,
      } satisfies AgentEntry,
      reason: null,
    };
  }
  const file = yield* registryPath(o.env.stateDir, scopeFor(o.env, o.run.record.cwd)).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  const registered =
    file === null
      ? null
      : yield* readRegistry(file).pipe(
          Effect.map((entries) => entries.find((entry) => entry.agent === record.agent) ?? null),
          Effect.catch(() => Effect.succeed(null)),
        );
  if (registered !== null && deliverable(registered)) {
    record.incarnation = registered.incarnation;
    yield* o.run.save();
    return { entry: registered, reason: null };
  }

  const live = yield* dispatch.entryFromLive(dispatcherDeps(o), {
    role,
    agent: record.agent,
    paneId: record.paneId,
    workspaceId: o.env.workspaceId,
    runId: o.run.id,
    workflow: o.run.record.workflow,
  });
  if (live.entry?.incarnation) {
    record.incarnation = live.entry.incarnation;
    yield* o.run.save();
  }
  // Healed on the register, so the incarnation this delivery goes to is the one the next
  // one is checked against.
  if (registered !== null && live.entry !== null && file !== null)
    yield* registerAgent(file, live.entry).pipe(Effect.ignore);
  return live;
});

/** The boundary deliveries queued for this agent, taken off the queue as they are used. */
function takeBoundaryFor(ctx: RunCtx, agent: string) {
  const mine = ctx.steering.deliveries.filter(
    (command) => command.deliver?.agent === agent && command.deliver.mode === "boundary",
  );
  ctx.steering.deliveries = ctx.steering.deliveries.filter((command) => !mine.includes(command));
  // By the ordering rule, not by when the inbox happened to receive them: two messages
  // due for one agent go into the prompt worst-waited first (SPEC §7.4).
  return dispatch
    .dispatchOrder(mine.flatMap((command) => (command.deliver ? [command.deliver] : [])))
    .map((deliver) => ({
      id: deliver.deliveryId,
      text: deliver.text,
      intentVersion: deliver.intentVersion,
      attempt: deliver.attempt,
    }));
}

/**
 * A delivery that does not wait for the next prompt. Queuing one would leave it pending
 * until `finish` expired it, which is neither the delivery the human confirmed nor the
 * capability refusal that would have told them why it could not go.
 */
const deliverOutOfBand = Effect.fn("Engine.deliverOutOfBand")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  deliver: NonNullable<InboxCommandValue["deliver"]>,
  requestId: string,
) {
  const record = [...ctx.groups.values()].find((entry) => entry.agent === deliver.agent);
  if (record === undefined) {
    yield* o.run.log(
      `${deliver.mode} delivery for ${deliver.agent}, which this Run is not driving`,
    );
    return;
  }
  const sent = yield* sendTo(o, record, {
    text: deliver.text,
    cause: { kind: "steer", ref: deliver.deliveryId },
    requestId,
    attempt: deliver.attempt,
    intentVersion: deliver.intentVersion,
    mode: deliver.mode,
  });
  yield* o.run.log(`${deliver.mode} delivery ${deliver.deliveryId}: ${sent ? "sent" : "not sent"}`);
});

/**
 * A steering item that travelled inside a step's prompt. It is its own delivery — it has
 * its own id, its own acknowledgement and its own place in the ledger — and the note
 * says which prompt carried it, because "sent" for a composed item means that prompt
 * went out.
 */
const recordComposed = Effect.fn("Engine.recordComposed")(function* (
  o: EngineOptions,
  entry: AgentEntry,
  item: { readonly id: string; readonly text: string; readonly intentVersion: number },
  carriedBy: SubmitOutcome,
) {
  const terminalId = entry.incarnation?.terminalId;
  if (terminalId === undefined) return;
  const file = yield* ledgerPath(o.env.stateDir, terminalId);
  const at = yield* nowIso();
  const cause = { kind: "steer" as const, ref: item.id };
  yield* appendLine(file, {
    id: item.id,
    at,
    run: o.run.id,
    incarnation: terminalId,
    agent: entry.agent,
    // The key the Dispatcher would compute: a delivery id cannot block a dispatched
    // entry about the same work.
    causal_key: causalKey(o.run.id, cause, item.intentVersion),
    request_id: item.id,
    cause,
    mode: "boundary",
    text_hash: textHash(item.text),
    intent_version: item.intentVersion,
    attempt: 1,
    state: carriedBy.ok ? "submitted" : "failed",
    // What is known of the carrier is all that is known of this: a prompt herdr saw no
    // turn come of carried this item into the same uncertainty.
    note: !carriedBy.ok
      ? "the prompt it was composed into was not sent"
      : carriedBy.submission === "unobserved"
        ? `composed into ${carriedBy.id}; unobserved`
        : `composed into ${carriedBy.id}`,
  });
});

/**
 * Everything the inbox has to say, folded into the Run's steering state. Called at the
 * work boundary and once per poll while an agent works; a `stop` has already raised its
 * own signal by the time this returns.
 */
const takeSteering = Effect.fn("Engine.takeSteering")(function* (o: EngineOptions, ctx: RunCtx) {
  // What the agents have said they understood, before what anyone else has asked of
  // them: an ack is about a delivery that has already gone, and reading it first keeps
  // the ledger's account of one message in order.
  yield* dispatch.readAcks(o.env.stateDir, o.run.dir, (line) =>
    o.run.log(`ack: ${line}`).pipe(Effect.ignore),
  );
  yield* noticeOverrides(o, ctx);
  const { taken, unreadable } = yield* readInboxMidStep(o.run.dir);
  for (const file of unreadable) yield* o.run.log(`inbox: unreadable command ${file}`);
  for (const command of taken) {
    switch (command.type) {
      case "hold": {
        const why = command.reason ?? "no reason given";
        ctx.steering.held = { reason: why };
        yield* o.run.log(`held: ${why}`);
        yield* o.out(`  ⏸ held: ${why}`);
        break;
      }
      case "release": {
        ctx.steering.held = null;
        yield* o.run.log(`released: ${command.reason ?? "no reason given"}`);
        yield* o.out(`  ▶ released`);
        break;
      }
      case "intent_changed": {
        const intent = yield* intentOf(o);
        ctx.steering.intentVersion = intent?.version ?? command.version ?? 0;
        yield* o.run.log(`intent v${ctx.steering.intentVersion} loaded`);
        yield* supersedeOlderDrift(o, intent);
        // Silent, but said: the board may not be open. Keyed by version, so a later
        // change says so again.
        yield* notify(o, "intent-changed", `now at v${ctx.steering.intentVersion}`, {
          step: `v${ctx.steering.intentVersion}`,
        });
        break;
      }
      case "deliver":
        if (command.deliver && command.deliver.mode !== "boundary") {
          yield* deliverOutOfBand(o, ctx, command.deliver, command.requestId);
          break;
        }
        // Queued, not sent: the Dispatcher is the only thing that sends.
        ctx.steering.deliveries.push(command);
        yield* o.run.log(`delivery queued for ${command.deliver?.agent ?? "an agent"}`);
        break;
      case "drift_report":
        yield* recordDriftReport(o, ctx, command);
        break;
      default:
        break;
    }
  }
});

/** Settles what `supersededBy` names: the Driver is the only writer of its own journal. */
const supersedeOlderDrift = Effect.fn("Engine.supersedeOlderDrift")(function* (
  o: EngineOptions,
  intent: Intent | null,
) {
  if (intent === null) return;
  const at = yield* nowIso();
  for (const report of supersededBy(openReports(yield* driftOf(o)), intent)) {
    yield* appendDrift(o.run.dir, { ...report, at, resolution: "superseded" }).pipe(Effect.ignore);
    yield* o.run.log(
      `drift ${report.constraint} superseded: judged at v${report.intent_version}, intent is v${intent.version}`,
    );
  }
});

/**
 * A report another process judged, appended to this Run's drift journal — but only if it
 * is still about this Run as it is now. The Driver is the only writer of its own drift
 * journal precisely so that this check happens somewhere: a report judged against an
 * older Intent or an older card is evidence about work that has moved on.
 */
const recordDriftReport = Effect.fn("Engine.recordDriftReport")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  command: InboxCommandValue,
) {
  const vector = command.vector;
  if (!vector || command.report === undefined) {
    yield* o.run.log("drift_report without a report or a vector, ignored");
    return;
  }
  const intent = yield* intentOf(o);
  const version = intent?.version ?? ctx.steering.intentVersion;
  if (vector.intentVersion !== version) {
    yield* o.run.log(
      `drift_report_stale: judged at intent v${vector.intentVersion}, now v${version}`,
    );
    return;
  }
  // A report about an earlier card is evidence about work this Run has moved past.
  if (vector.cardId !== null) {
    const newest = (yield* readCards(o.run.dir).pipe(Effect.catch(() => Effect.succeed([])))).at(
      -1,
    );
    if (newest?.id !== vector.cardId) {
      yield* o.run.log(
        `drift_report_stale: judged against card ${vector.cardId}, now ${newest?.id ?? "none"}`,
      );
      return;
    }
  }
  const decoded = Schema.decodeUnknownOption(DriftReportSchema)(command.report);
  if (decoded._tag === "None") {
    yield* o.run.log("drift_report that is not a report, ignored");
    return;
  }
  const report = decoded.value;
  const lines = yield* driftOf(o);
  const already = new Set(
    openReports(lines).map((entry) => driftFindingKey(entry.constraint, entry.evidence)),
  );
  if (already.has(driftFindingKey(report.constraint, report.evidence))) {
    yield* o.run.log(`drift_report duplicate of an open finding on ${report.constraint}, ignored`);
    return;
  }
  yield* appendDrift(o.run.dir, report);
  yield* o.run.log(`drift report recorded at intent v${version}`);
});

/**
 * Nothing new goes out while a Run is held. The current step's agents have already been
 * waited on by the time this is reached, so what is held is the *next* piece of work —
 * the Driver is not interrupting anyone, it is declining to start anything.
 */
const holdUntilReleased = Effect.fn("Engine.holdUntilReleased")(function* (
  o: EngineOptions,
  ctx: RunCtx,
) {
  if (!ctx.steering.held) return;
  o.run.record.awaiting = "hold";
  yield* o.run.save();
  while (ctx.steering.held) {
    yield* Effect.sleep(o.outputPollMs ?? 2000);
    yield* takeSteering(o, ctx);
  }
  o.run.record.awaiting = null;
  yield* o.run.save();
});

/**
 * Waits for an agent by watching it, not by blocking on it. Quiet — neither its
 * status nor its pane's tail changing for `quiet_ms` — earns a nudge, a second at
 * double, and is given up on at triple, which is what this returns. A step that is
 * still producing output is never nudged, however long it takes: quiet is the
 * signal, duration never is.
 */
const awaitAgent = Effect.fn("Engine.awaitAgent")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  step: ResolvedStep,
  record: VariantRecord,
) {
  const over: AgentStatus[] = ["idle", "done", "blocked"];
  // ponytail: the whole `issues/` dir, not the one ticket this step is on — knowing
  // which would need the implementer to say so. A fresh agent is skipped: it started
  // after the edit and read the new ticket already.
  const tickets = step.fresh ? null : yield* planTickets(o);
  const budget = o.defaults.quietMs;
  // Nothing to give up on and nothing to watch: wait, rather than poll for nothing.
  if (budget <= 0 && !tickets) {
    yield* o.herdr.agentWait(record.agent, { until: over });
    return null;
  }
  // No budget is no nudge and no giving up, but a step with tickets still has to poll,
  // so the deadlines go out of reach rather than away.
  const quiet = budget > 0 ? budget : Infinity;

  // Liveness is sampled against a budget measured in minutes, so there is nothing to
  // learn every two seconds — and each sample costs two herdr subprocesses per agent.
  // Never slower than a tenth of the budget, so the give-up stays close to its time.
  const poll = o.outputPollMs ?? 2000;
  const beat = Math.max(poll, Math.min(quiet / 10, 30_000));
  const minutes = (ms: number) => Math.round(ms / 60_000);
  let sample = "";
  let quietSince = yield* Clock.currentTimeMillis;
  // Nudges within the current quiet spell; `record.nudges` counts them for the whole
  // turn, and two is all an agent gets however often it stirs in between.
  let spell = 0;
  let silentSince: number | null = null;
  let tail = "";
  let sampled = 0;
  for (;;) {
    // Told apart on purpose: herdr answering "I do not have that agent" is the answer
    // — a closed tab, a killed pane — and waiting out a quiet budget it will never
    // break is half an hour of nothing. Herdr not answering at all is a hiccup, and
    // discarding a live step over a few seconds of socket noise is worse than waiting.
    const status = yield* o.herdr
      .agentStatus(record.agent)
      .pipe(
        Effect.catch((cause) =>
          cause.code === "agent_not_found" ? Effect.succeed("gone" as const) : Effect.succeed(null),
        ),
      );
    const now = yield* Clock.currentTimeMillis;
    // Once per poll, so a hold or a message written while an agent works is seen within
    // seconds rather than at the next question. It is two directory reads against the
    // Run's own inbox — cheaper than the herdr round trip already made above.
    yield* takeSteering(o, ctx);
    // A slice a human can look at, while the step is still running. That is the whole
    // point of a checkpoint: without this they wait for the step, which can be an hour.
    yield* cardsForCheckpoints(o, ctx, record.label);
    if (status === "gone") return `${record.agent} is gone — herdr no longer has it`;
    if (status === null) {
      silentSince ??= now;
      // A whole quiet period of herdr saying nothing at all is its own answer.
      if (now - silentSince >= quiet) {
        return `${record.agent} could not be reached for ${minutes(now - silentSince)} minutes`;
      }
      yield* Effect.sleep(poll);
      continue;
    }
    silentSince = null;
    // What this poll learned, on the tab: an agent herdr calls `blocked` is a human
    // being waited on, and until this the tab still said ⚙ and the sidebar with it.
    yield* reconcileTabs(o, ctx, (agent) => (agent === record.agent ? status : undefined));
    // `blocked` is herdr saying a human is needed; that path has its own wait and its
    // own toast, and a nudge there would answer a permission dialog with prose.
    if (over.includes(status)) return null;

    // Status is what says the turn is over, so it is asked at the polling cadence;
    // the pane is only the quiet signal, and it is the expensive half.
    if (now - sampled >= beat) {
      sampled = now;
      tail = yield* paneTail(o, ctx, record);
      if (tickets) {
        const current = yield* readTickets(tickets);
        const note = current && ctx.tickets ? ticketChangeNote(ctx.tickets, current) : null;
        // A change nobody was told about is not one to move the baseline past. The hash
        // is the cause's own name: two different edits are two pieces of work, and the
        // same edit re-read is not.
        const told =
          note === null ||
          (yield* sendTo(o, record, {
            text: note,
            cause: { kind: "steer", ref: `tickets#${textHash(note)}` },
            requestId: `${o.run.id}-tickets-${record.agent}-${textHash(note)}`,
            attempt: 1,
            intentVersion: ctx.steering.intentVersion,
          }));
        if (current && told) ctx.tickets = current;
        if (note !== null && told) {
          // Re-baselined on our own writing, as a nudge is: only the agent's next
          // output counts as it having stirred.
          tail = yield* paneTail(o, ctx, record);
          sample = `${status}\n${tail}`;
          yield* o.out(`  ▸ ${record.label} — the plan's tickets changed, told it to reconcile`);
          yield* o.run.log(`${record.label}: the plan's tickets changed under it`);
        }
      }
    }
    const next = `${status}\n${tail}`;
    if (next !== sample) {
      sample = next;
      quietSince = now;
      spell = 0;
    }
    const quietFor = now - quietSince;
    if (quietFor >= quiet * 3) {
      return `${record.agent} produced no output for ${minutes(quietFor)} minutes and did not respond to two nudges`;
    }
    // An agent that answers each nudge with a line and then goes quiet again would
    // otherwise reset the clock forever and never be given up on. Two nudges is what
    // a step gets for its whole turn; stirring and then going quiet again once both
    // are spent — `spell` back to nothing — is the same answer as never moving.
    if (record.nudges >= 2 && spell === 0 && quietFor >= quiet) {
      return `${record.agent} went quiet again after two nudges and produced nothing usable`;
    }
    // Whole quiet periods elapsed, and so how many nudges are owed: 0, 1 or 2, since
    // the third is the give-up above.
    const due = Math.floor(quietFor / quiet);
    if (due > spell && record.nudges < 2) {
      spell = due;
      yield* sendTo(o, record, {
        text: nudgeText(record.harness, minutes(quietFor), record.nudges >= 1),
        cause: { kind: "nudge", ref: `${record.agent}#${record.nudges + 1}` },
        requestId: `${o.run.id}-nudge-${record.agent}-${record.nudges + 1}`,
        attempt: record.nudges + 1,
        intentVersion: ctx.steering.intentVersion,
      });
      // The nudge is typed into the agent's own pane, so the next poll would read it
      // as activity, reset the deadline it is counting against, and nudge forever.
      // Re-baseline on our own writing; only the agent's next output counts.
      sample = `${status}\n${yield* paneTail(o, ctx, record)}`;
      record.nudges += 1;
      yield* o.out(`  ⏱ ${record.label} — quiet for ${minutes(quietFor)} minutes, nudged`);
      yield* o.run.log(`${record.label}: quiet for ${minutes(quietFor)} minutes, nudged`);
      yield* o.run.save();
    }
    yield* Effect.sleep(poll);
  }
});

/**
 * What a quiet agent is told. "Do not restart the task" is not politeness: an agent
 * that re-runs its whole step after a nudge is a worse outcome than the hang, because
 * it looks like progress.
 */
function nudgeText(harness: string, minutes: number, last: boolean): string {
  const hint = HARNESSES[harness]?.stuckHint;
  return [
    `You have produced no output for ${minutes} minutes. If you are waiting on something`,
    ` that will never finish, stop waiting and carry on${hint ? `: ${hint}` : "."}`,
    last ? " This is the last nudge before this step is given up on." : "",
    "\n\nIf you are working normally, ignore this and continue. Do not restart the task",
    " and do not redo work you have already done.",
  ].join("");
}

/** The pane's tail, or nothing: a herdr that will not read it is not a failure. */
const paneTail = Effect.fn("Engine.paneTail")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  record: VariantRecord,
) {
  if (!record.paneId) return "";
  const tail = yield* o.herdr
    .paneRead(record.paneId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (tail === null) {
    // Said once, not latched: a read that failed on one poll says nothing about the
    // next one, and treating a transient failure as permanent would leave every later
    // agent judged on its status alone — nudged and given up on while its pane is
    // still filling.
    if (!ctx.paneReadFailed) {
      ctx.paneReadFailed = true;
      yield* o.run.log(`pane read failed; liveness is agent status alone until it answers`);
    }
    return "";
  }
  ctx.paneReadFailed = false;
  return tail;
});

/**
 * Whether the tickets this Output points at could actually be handed out, or the reason
 * they could not. Keyed on `issues_dir` rather than on a step id, because what makes this
 * check apply is that the step wrote a plan — a fork that renames the step still gets it,
 * and one that writes no plan is never asked.
 *
 * The same reading the fan-out does, and deliberately not a second copy of it: a plan the
 * planner is told is fine here and refused there would be worse than no check at all.
 */
/**
 * Whether this step is the only review of the change: one variant, and a later step that
 * fans in on it. Then there is nothing to reconcile, and the fan-in step is skipped — a
 * model rewriting one file into one file adds no judgement, and every Run was paying for
 * it. A layer that keeps two reviewers keeps the fan-in exactly as it was.
 */
function soleReview(o: EngineOptions, step: ResolvedStep): boolean {
  if (step.fanIn) return false;
  if (!feedsFanIn(o, step)) return false;
  return stepVariants(step, o.defaults).length === 1;
}

/** Whether a later step reconciles this one's Outputs — i.e. whether this step reviews. */
function feedsFanIn(o: EngineOptions, step: ResolvedStep): boolean {
  return o.wf.steps.some((other) => other.fanIn === step.id);
}

const planRefusal = Effect.fn("Engine.planRefusal")(function* (
  o: EngineOptions,
  parsed: YamlValue,
) {
  const pathService = yield* Path.Path;
  if (!isYamlMap(parsed)) return null;
  const dir = parsed.issues_dir;
  if (!isString(dir) || dir.trim() === "") return null;
  // The prompt asks for `{{run.dir}}/plan/issues`; a planner that wrote it relative
  // meant the same place, and refusing to look would be reading the Output pedantically
  // rather than reading the plan.
  const issues = pathService.resolve(o.run.dir, dir.trim());
  const plan = yield* planReposOf(pathService.dirname(issues), o.run.record.cwd).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  return plan?.refusal?.message ?? null;
});

const collect = Effect.fn("Engine.collect")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  record: VariantRecord,
  variantKey: string | null,
  /** False after a give-up: read what is there, do not wait on an agent that is gone. */
  wait = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (!step.output) {
    const status = yield* o.herdr.agentStatus(record.agent);
    record.status = status === "blocked" ? "blocked" : "done";
    if (record.status === "blocked") record.error = "agent is blocked and needs input";
    return { record, output: null, review: null };
  }

  const path = yield* o.run.outputPath(step.id, variantKey, step.output);
  record.output = pathService.relative(o.run.dir, path);
  if (wait) yield* awaitOutput(o, record.agent, step.id, path);
  if (!(yield* written(path))) {
    record.status = "blocked";
    record.error = `no Output at ${record.output}`;
    return { record, output: null, review: null, problem: record.error };
  }

  const text = yield* fs.readFileString(path);
  let parsed: YamlValue;
  try {
    parsed = Schema.decodeUnknownSync(YamlValueJsonSchema)(text);
  } catch (e) {
    record.status = "failed";
    record.error = `${record.output}: not valid JSON (${reason(e)})`;
    return { record, output: null, review: null, problem: record.error };
  }

  // A plan whose tickets nobody can run is not a finished plan. These refusals used to
  // run only when someone picked "Implement now", so a `plan` Run could end `done` with
  // tickets that name a repository nobody checked out, or block each other in a cycle —
  // and the human found out a workflow later, from a hand-off that would not start.
  const refusal = yield* planRefusal(o, parsed);
  if (refusal !== null) {
    record.status = "failed";
    record.error = refusal;
    return { record, output: parsed, review: null, problem: refusal };
  }

  const hasVerdict = isYamlMap(parsed) && "verdict" in parsed;
  if (step.fanIn && !hasVerdict) {
    record.status = "failed";
    record.error = `${record.output}: a fan-in Output needs a verdict`;
    return { record, output: parsed, review: null, problem: record.error };
  }

  // A review nobody else is reviewing beside is already the review the human reads, so
  // it is held to the shape of one — a `summary`, and nothing dropped silently. Asking
  // for that here rather than at the fan-in is what lets the reviewer itself be sent
  // back to fix its Output; a model rewriting the file afterwards is the ceremony this
  // is replacing, not a way of getting a summary.
  const sole = soleReview(o, step);
  let review: ReviewOutput | null = null;
  if (hasVerdict && (step.fanIn || sole)) {
    const result = parseSynthesis(text, record.output);
    if (!result.ok) {
      record.status = "failed";
      record.error = result.error;
      return { record, output: parsed, review: null, problem: result.error };
    }
    const vague = unsubstantiated(result.value.findings);
    if (vague !== null) {
      record.status = "failed";
      record.error = `${record.output}: ${vague}`;
      return { record, output: parsed, review: null, problem: record.error };
    }
    review = result.value;
    yield* fs.writeFileString(pathService.join(o.run.dir, REVIEW_FILE), renderReview(result.value));
    // A hand-off gives the implementer both the prose and the findings it came from.
    o.run.record.synthesis = record.output;
    // What this review leaves open, and what it found already fixed, so a Run that
    // ends here says so. A loop that runs out of iterations narrows `outstanding` to
    // what is still disputed; a standalone review has no such step, and used to
    // finish announcing itself as clean whatever the review said.
    o.run.record.outstanding = result.value.findings;
    o.run.record.fixed = result.value.fixed.length;
    // This verdict supersedes the previous review of the same target, so that run
    // stops reporting findings this one no longer holds open. Best-effort: the old
    // record staying stale must not fail the step that produced a good synthesis.
    const superseded = o.run.record.previous_review;
    if (superseded) {
      yield* new RunStore(o.env.stateDir)
        .supersedeOutstanding(superseded, result.value.findings)
        .pipe(
          Effect.tap(() =>
            o.run.log(
              `narrowed run ${superseded}'s outstanding to ${result.value.findings.length} finding(s), superseded by this review`,
            ),
          ),
          Effect.catch((e) => o.run.log(`could not narrow run ${superseded}: ${String(e)}`)),
        );
    }
  } else if (hasVerdict) {
    const result = parseReviewOutput(text, record.output);
    if (!result.ok) {
      record.status = "failed";
      record.error = result.error;
      return { record, output: parsed, review: null, problem: result.error };
    }
    // Only a step that reviews: these are the findings that drive a fix loop and land in
    // front of an implementer. A build's Output has a verdict too, and so does a plan
    // round's — holding those to a reviewer's standard would refuse work for the wrong
    // reason, and a plan finding has no file to point at.
    if (feedsFanIn(o, step)) {
      const vague = unsubstantiated(result.value.findings);
      if (vague !== null) {
        record.status = "failed";
        record.error = `${record.output}: ${vague}`;
        return { record, output: parsed, review: null, problem: record.error };
      }
    }
    review = result.value;
  }
  if (review) {
    // The shape of a review is the engine's to decide, so every one reads alike.
    collectList(o, "deferred", parsed);
    const hadMr = o.run.record.mr_url;
    collectMr(o, parsed);
    // The merge request is the thing the human was waiting for; the Run finishing is
    // only how they find out about it, and that can be a step or two later.
    if (o.run.record.mr_url && o.run.record.mr_url !== hadMr) {
      const iid = /\/merge_requests\/(\d+)/.exec(o.run.record.mr_url)?.[1];
      yield* notify(o, "mr-opened", o.run.record.mr_url, { subject: iid ? `!${iid}` : undefined });
      yield* claimMrRole(o, parseMrUrl(o.run.record.mr_url), "assignee");
    }
    // A re-run step must not double-report what it disputed last time.
    for (const finding of review.disputed) {
      const key = findingKey(finding);
      if (!o.run.record.disputed.some((d) => findingKey(d) === key)) {
        o.run.record.disputed.push(finding);
      }
    }
  }

  record.status = "done";
  return { record, output: parsed, review };
});

/**
 * Every tab of this run says the same thing: which run it is and which step it is on.
 * The glyph is the caller's, because that is the one part that is about the tab rather
 * than about the run — see `tabGlyph`.
 */
function runTab(o: EngineOptions, glyph: string): string {
  return runTabLabel(glyph, o.run.record, false);
}

/**
 * Every name Collie could have put on one of this Run's panes: the step each pane is
 * for, and the model or harness a parallel variant is named by.
 */
function ourPaneNames(record: RunRecord): Set<string> {
  const names = new Set<string>();
  for (const step of record.steps) {
    names.add(displayName(step.id.slice(step.id.lastIndexOf(".") + 1)));
    for (const variant of step.variants) names.add(paneLabel(variant, step.id, 2, true)!);
  }
  return names;
}

/**
 * Whether a pane is still Collie's to rename. A pane nobody has named is, and so is one
 * wearing a name Collie itself wrote — a step that continues an agent renames its pane
 * from `Build` to `Simplify`. Anything else was typed by a human and stays theirs.
 */
const paneIsOurs = Effect.fn("Engine.paneIsOurs")(function* (o: EngineOptions, paneId: string) {
  const current = (yield* o.herdr.paneList()).find((pane) => pane.paneId === paneId)?.label ?? null;
  if (current === null || current.trim() === "") return true;
  return ourPaneNames(o.run.record).has(current);
});

/**
 * One tab renamed, and remembered. Nothing is sent for a label herdr already has: the
 * reconcile below runs on every status poll, and a rename per poll per tab would be
 * herdr redrawing its sidebar a few times a second for no news at all.
 */
const renameTab = Effect.fn("Engine.renameTab")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  tabId: string,
  label: string,
) {
  if (ctx.tabLabels.get(tabId) === label || ctx.manualTabs.has(tabId)) return;
  // Asked only when the label has actually moved on, which is rare: a human who renamed
  // this tab keeps their name, through every later update and every continuation.
  const current = (yield* o.herdr.tabList()).find((tab) => tab.tabId === tabId)?.label;
  if (!collieOwns(current, o.run.record)) {
    ctx.manualTabs.add(tabId);
    return;
  }
  // Remembered before the call, not after it: the variants of a parallel step poll at
  // the same time, and two fibers that both read an empty memo before either wrote it
  // sent the same rename twice. A rename that fails is not retried — a tab that will
  // not take one has almost always been closed.
  ctx.tabLabels.set(tabId, label);
  yield* o.herdr.tabRename(tabId, label);
});

/**
 * Nothing live is known about any agent, so the label comes off the record alone: what
 * a step start, a Choice and the run's end each know about their own tabs.
 */
const nothingLive = () => undefined;

/**
 * The run's tabs, brought up to date. Called where the Driver already learns something
 * about a pane — the status poll while it waits on an agent — so a tab that goes
 * `blocked` says so without the engine renaming anything by hand. Only what changed:
 * the poll is every couple of seconds and the label is the same string nearly always.
 */
const reconcileTabs = Effect.fn("Engine.reconcileTabs")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  live: (agent: string) => string | undefined,
  asking = false,
) {
  // A tab that will not rename is not worth failing a live step over.
  for (const [tabId, label] of tabLabelsFor(o.run.record, live, asking)) {
    yield* Effect.ignore(renameTab(o, ctx, tabId, label));
  }
});

/**
 * A target names the run only where the workflow owns it. `implement` inherits
 * `target` from the review it embeds, and is not "implement · worktree" — it is
 * whatever it is building.
 */
export function runTarget(
  wf: { name: string; embeddedInputs: string[] },
  record: { workflow: string; slug: string; inputs: Record<string, string> },
): string {
  const own = !wf.embeddedInputs.includes("target");
  return targetLabel(record.workflow, record.slug, own ? record.inputs : {});
}

/** The MR step reports what it opened; the summary is where the human looks for it. */
function collectMr(o: EngineOptions, parsed: YamlValue): void {
  if (!isYamlMap(parsed)) return;
  // A step that committed and deliberately did not push — `review`'s fix round works
  // on someone else's branch — has to be able to say so at the end. A result that
  // looks like it landed and did not is worse than either outcome.
  if (parsed.pushed === false && isString(parsed.branch) && parsed.branch.trim() !== "") {
    o.run.record.unpushed = parsed.branch.trim();
  } else if (parsed.pushed === true) {
    o.run.record.unpushed = null;
  }
  if (isString(parsed.mr_url) && parsed.mr_url.trim() !== "")
    o.run.record.mr_url = parsed.mr_url.trim();
  if (Array.isArray(parsed.linear_issues)) {
    for (const id of parsed.linear_issues) {
      if (isString(id) && id !== "" && !o.run.record.linear_issues.includes(id)) {
        o.run.record.linear_issues.push(id);
      }
    }
  }
}

/**
 * The human on the merge request in that role: `gitlab.assignee` from config for the
 * assignee, else whoever glab is logged in as. Nothing to do where glab or the login is
 * missing — the step that got this far said what it could not do already.
 *
 * A merge request already assigned to that person is left alone. One name in both roles
 * is one person reviewing their own change, and GitLab shows it as a review that has
 * happened; what actually happened is that Collie read it and the human has the findings.
 */
const claimMrRole = Effect.fn("Engine.claimMrRole")(function* (
  o: EngineOptions,
  mr: MrRef | null,
  role: MrRole,
) {
  if (!mr) return;
  const cwd = o.run.record.cwd;
  const configured =
    role === "assignee"
      ? configValue(yield* readConfig(o.env.configDir), "gitlab.assignee")
      : undefined;
  const who = yield* resolveAssignee(cwd, configured, runShell);
  if (!who) return;
  if (role === "reviewer" && (yield* assignedTo(mr, who, cwd, runShell))) {
    yield* o.out(`  ▸ ${who} already has ${mr.project ? `${mr.project}!` : "!"}${mr.iid}`);
    return;
  }
  const res = yield* addMrRole(mr, role, who, cwd, runShell);
  const where = mr.project ? `${mr.project}!${mr.iid}` : `!${mr.iid}`;
  yield* o.out(
    res.code === 0
      ? `  ▸ ${who} is ${role} on ${where}`
      : `  glab mr update ${where} --${role} failed (exit ${res.code})`,
  );
});

/** What the MR prompt is given: never null, so a missing value reads as a gap, not "undefined". */
function mrVars(facts: MrFacts): YamlMap {
  return {
    mr: {
      assignee: facts.assignee ?? "",
      template: facts.template ?? "",
      issues: facts.issues.join(", "),
      has_issues: facts.issues.length > 0 ? "yes" : "no",
    },
  };
}

/** Appends an Output's `deferred` entries to the run, without repeating one. */
function collectList(o: EngineOptions, key: "deferred", parsed: YamlValue): void {
  if (!isYamlMap(parsed)) return;
  const raw = parsed[key];
  if (!Array.isArray(raw)) return;
  const result = parseFindings(raw, `${key}`);
  if (!result.ok) return;
  for (const finding of result.value) {
    const id = findingKey(finding);
    if (!o.run.record[key].some((f) => findingKey(f) === id)) o.run.record[key].push(finding);
  }
}

/** Whether this run can give a step what it declared it needs, and why not. */
/**
 * Why a Step or a Choice cannot be done here, or null. Takes the run's facts rather
 * than the run, so the launch menu can ask about exactly the steps that will run.
 */
export const unmetRequirementFor = Effect.fn("Engine.unmetRequirementFor")(function* (
  where: { cwd: string; inputs: Record<string, string> },
  requires: StepRequirement[],
) {
  const target = where.inputs.target ?? "";
  for (const need of requires) {
    if (need === "gitlab") {
      // A step pointed at a merge request needs glab for that project; a step that
      // pushes needs this directory to be the checkout. `mr-target` says which.
      const mr = requires.includes("mr-target") ? parseMrTarget(target) : null;
      const ready = yield* mr
        ? gitlabForProject(mr.project, where.cwd, runShell)
        : gitlabReadiness(where.cwd, runShell);
      if (!ready.ok) return ready.reason;
    }
    if (need === "mr-target" && where.inputs.target_kind !== "mr") {
      return `${target || "this run"} is not a merge request`;
    }
    if (need === "someone-elses-mr") {
      const mr = parseMrTarget(target);
      const me = mr ? yield* glabLogin(where.cwd, runShell) : null;
      if (mr && me && (yield* assignedTo(mr, me, where.cwd, runShell))) {
        return `${target} is assigned to you, so its findings are yours to fix rather than to post`;
      }
    }
  }
  return null;
});

const unmetRequirement = (o: EngineOptions, requires: StepRequirement[]) =>
  unmetRequirementFor({ cwd: o.run.record.cwd, inputs: o.run.record.inputs }, requires);

/** Where Helle's credentials are read from, when a machine keeps them off the default. */
const helleEnvFile = (o: EngineOptions) => o.env.raw.HELLE_ENV_FILE ?? null;

/**
 * Blocks until this Run holds the Helle project of the repository it is working in.
 * A repository with no Helle project is not a gate at all; anything that stops Helle
 * from answering fails, and the step that declared the wait says so.
 */
const helleGate = Effect.fn("Engine.helleGate")(function* (o: EngineOptions) {
  const { run } = o;
  const pathService = yield* Path.Path;
  const gitlabPath = yield* projectHere(run.record.cwd, runShell);
  return yield* waitForHelle({
    home: o.env.home,
    envFile: helleEnvFile(o),
    gitlabPath,
    // git's repository, never the cwd's basename: a Run's checkout is named after its
    // branch, and a roaming one after nothing but `renovate`, so the fallback slug
    // match would look for a Helle project called "renovate" and find none — which
    // reads as "no Helle project" for a repository that has one.
    repoName:
      gitlabPath?.split("/").at(-1) ??
      (yield* repositoryName(runShell, run.record.cwd)) ??
      pathService.basename(run.record.cwd),
    claimed: run.record.helle,
    record: (claim) =>
      Effect.gen(function* () {
        run.record.helle = claim;
        yield* run.save();
      }),
    out: o.out,
    ask: (question) => (o.prompts ? o.prompts.ask(question) : Effect.succeed(null)),
  });
});

/**
 * Gives the Helle claim back, once and only once the Run has succeeded. A Run that
 * failed or is waiting on the operator keeps it: that is the whole point of holding it
 * across a consultation, and nobody may deploy on top of a half-finished renovation.
 */
const releaseHelle = Effect.fn("Engine.releaseHelle")(function* (o: EngineOptions) {
  const claim = o.run.record.helle;
  if (!claim) return;
  const released = yield* credentials({ home: o.env.home, envFile: helleEnvFile(o) }).pipe(
    Effect.flatMap((creds) => releaseClaim(creds, claim.slug)),
    Effect.result,
  );
  if (Result.isFailure(released)) {
    yield* o.out(`  helle: ${claim.slug} could not be released — ${released.failure.message}`);
    return;
  }
  o.run.record.helle = null;
  yield* o.out(`  helle: released ${claim.slug}`);
});

/** The pane a fan-in step splits from: the last of the Outputs it reconciles. */
function fanInPane(step: ResolvedStep, ctx: RunCtx): VariantRecord | null {
  if (!step.fanIn) return null;
  const source = ctx.outputs.get(step.fanIn)?.at(-1)?.record;
  return source?.paneId ? source : null;
}

/** The Output files a fan-in step reconciles, for its own prompt to read. */
const fanInFiles = Effect.fn("Engine.fanInFiles")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  outputs: Map<string, VariantOutcome[]>,
) {
  if (!step.fanIn) return "";
  const pathService = yield* Path.Path;
  return (outputs.get(step.fanIn) ?? [])
    .map((v) => (v.record.output ? `- ${pathService.join(o.run.dir, v.record.output)}` : null))
    .filter((line): line is string => line !== null)
    .join("\n");
});

/** The synthesised review, in the run's own pane, where the human is already looking. */
const printReview = Effect.fn("Engine.printReview")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(o.run.dir, REVIEW_FILE);
  if (!(yield* fs.exists(path))) return;
  yield* o.out("");
  yield* o.out((yield* fs.readFileString(path)).trimEnd());
  yield* o.out("");
});

/** The agent of an earlier step, but only one this process actually started. */
function borrowedAgent(o: EngineOptions, step: ResolvedStep, ctx: RunCtx): VariantRecord | null {
  if (!step.agent) return null;
  if (ctx.ran.has(step.agent)) return o.run.step(step.agent).variants[0] ?? null;
  // On a resumed run the named step is long gone; the group's first agent stands in.
  return ctx.groups.get(step.agent) ?? null;
}

/** A Persona as the harness that will read it sees it, skills and all. */
function personaBody(o: EngineOptions, step: ResolvedStep, skills: SkillPaths): string {
  const raw = step.persona ? (o.defs.personas.get(step.persona)?.body ?? "") : "";
  if (raw === "") return "";
  return renderTemplate(raw, {}, { skill: skillMention(skills) }).text;
}

/**
 * The Persona as a file, since herdr will not pass multi-line agent arguments. One
 * file per harness: the same persona asks for its skills in that harness's syntax,
 * and the run dir should show what each agent was actually given.
 */
const personaFile = Effect.fn("Engine.personaFile")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  harness: string,
  skills: SkillPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* o.run.personaPath(step.persona ?? "none", harness);
  yield* fs.writeFileString(path, `${personaBody(o, step, skills)}\n`);
  return path;
});

/**
 * What the human channel types to start a Step's `skill:`; unknown harnesses fall
 * back to claude's. A skill *mentioned* in a body is a path, not a command — see
 * `skillMention`.
 */
function skillCommandFor(harness: string): (name: string) => string {
  const adapter = HARNESSES[harness];
  return (name) => (adapter ? adapter.skillCommand(name) : `/${name}`);
}

/**
 * Where each skill this run mentions lives, resolved once. A mention renders the
 * path validation found rather than a guess, and a skill that is not installed is
 * said so once in the log instead of on every render.
 */
const resolveSkills = Effect.fn("Engine.resolveSkills")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const dirs = yield* skillDirs(o.env);
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const name of skillMentions(o.wf, o.defs).keys()) {
    let file: string | null = null;
    for (const dir of dirs) {
      const candidate = pathService.join(dir, name, "SKILL.md");
      if (yield* fs.exists(candidate)) {
        file = candidate;
        break;
      }
    }
    if (file) found.set(name, file);
    else missing.push(name);
  }
  if (missing.length > 0) yield* o.run.log(`skills not installed here: ${missing.join(", ")}`);
  return found;
});

/**
 * What `chain` renders a forwarded Choice input with — and nothing else. A value
 * naming anything outside this renders empty and is then forwarded as a settled
 * input, so the child never asks for what it needed.
 *
 * `outputs` among them: a child is handed what its parent worked out, which is how the
 * short name of the task reaches the branch the child builds.
 */
export const CHAIN_SUPPLIED: ReadonlySet<string> = new Set(["run", "cwd", "outputs"]);

/**
 * The variable families `buildPrompt` supplies at step time, named where they are
 * built. A checker rendering a step ahead of a Run cannot know these and must not
 * report them as unresolvable — and it can only stay right about that if the list
 * lives beside the code that decides it.
 */
export const ENGINE_SUPPLIED: ReadonlySet<string> = new Set([
  "outputs",
  "findings",
  "fan_in",
  "disputed",
  "previous",
  "session",
  "config",
  "mr",
  "run",
  "cwd",
  "step",
  "harness",
  "model",
  "effort",
  "iteration",
  "max_iterations",
  "output_path",
  "target_repo",
  "unreviewed",
  "verify",
  "risks",
  "evidence",
  "ticket",
  "progress",
  "obstacle",
]);

/** The extra axes a human asked for, as a paragraph, or nothing where they asked for none. */
function riskLine(risks: string): string {
  const asked = risks.trim();
  if (asked === "") return "";
  return (
    `Additional axes requested for this change: ${asked}. Apply the matching skill where ` +
    `one is installed (\`security-and-hardening\`, \`performance-optimization\`) and say in ` +
    `your review which of them you applied. These are on top of the complete review, not ` +
    `instead of it.`
  );
}

const buildPrompt = Effect.fn("Engine.buildPrompt")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  variant: Variant,
  variantKey: string | null,
  ctx: RunCtx,
  extraVars?: YamlMap,
) {
  const { outputs, skills, previous } = ctx;
  const adapter = HARNESSES[variant.harness]!;
  const outputPath = step.output ? yield* o.run.outputPath(step.id, variantKey, step.output) : "";
  const vars: YamlMap = {
    inputs: o.run.record.inputs,
    outputs: outputVars(outputs),
    findings: formatFindings(lastFindings(o, step, ctx)),
    // `--repo <project>` for an MR target, so a prompt can be followed from anywhere.
    target_repo: repoArgs(parseMrTarget(o.run.record.inputs.target ?? "")?.project ?? null).join(
      " ",
    ),
    fan_in: yield* fanInFiles(o, step, outputs),
    disputed: formatFindings(o.run.record.disputed),
    previous: { ...previous },
    run: { dir: o.run.dir, id: o.run.id, slug: o.run.record.slug },
    output_path: outputPath,
    iteration: String(o.run.record.iteration),
    max_iterations: String(o.run.record.max_iterations),
    // Empty until a last fix went unreviewed; the mr prompt says it where it is not.
    unreviewed: o.run.record.unreviewed ?? "",
    // What Collie will run itself at the gate, named so an agent knows what its work is
    // going to be held to rather than guessing which commands count.
    verify: renderApproved(approvedFor(o.run.record.approved_verifications, yield* intentOf(o))),
    // Empty unless the human asked for an extra axis, so an ordinary review renders
    // nothing at all rather than a paragraph saying no specialist was wanted.
    risks: riskLine(o.run.record.inputs.risks ?? ""),
    // The one ticket this slice is for, and what the slices before it left behind. Empty
    // for every step that is not sliced, so a prompt that names them renders nothing.
    ticket: ctx.slice
      ? {
          file: ctx.slice.ticket.file,
          number: ctx.slice.ticket.number,
          title: ctx.slice.ticket.title,
        }
      : { file: "", number: "", title: "" },
    progress: ctx.slice?.progress ?? "",
    // Empty until something is identifiably in the way, so an ordinary prompt says
    // nothing about obstacles at all.
    obstacle: o.run.record.obstacle ?? "",
    // What was actually collected, so the merge request says what was proved rather than
    // what an Output claimed. Rendered from the journal, never from a step's own words.
    evidence: renderEvidence({
      verifications: yield* verificationsOf(o),
      final: yield* fingerprint(o.run.record.worktree?.path ?? o.run.record.cwd),
    }),
    cwd: o.run.record.cwd,
    step: step.id,
    harness: variant.harness,
    model: variant.model,
    effort: variant.effort ?? "",
    config: yield* readConfig(o.env.configDir),
    ...extraVars,
  };

  const parts: string[] = [];
  const prefix = personaPrefix(adapter, personaBody(o, step, skills));
  if (prefix) parts.push(prefix);
  const rendered = renderTemplate(
    [step.preamble, step.prompt].filter((p) => p.trim()).join("\n\n"),
    vars,
    { skill: skillMention(skills) },
  );
  if (rendered.missing.length > 0) {
    yield* o.run.log(`unknown template keys in ${step.id}: ${rendered.missing.join(", ")}`);
  }
  parts.push(rendered.text);
  if (outputPath) {
    parts.push(
      `When you are done, write your result as JSON to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${outputPath}`,
    );
  }
  return parts.join("\n\n");
});

function lastFindings(o: EngineOptions, step: ResolvedStep, ctx: RunCtx): Finding[] {
  const from = step.repeat?.from;
  const source = from ? ctx.outputs.get(from) : undefined;
  if (!source) return [];
  const findings = verdictOf(source, o.run.record.disputed).findings;
  return step.repeat?.converge ? [...findings, ...ctx.reopened] : findings;
}

interface Verdict {
  /** False when no variant wrote a review at all — which is not the same as clean. */
  reviewed: boolean;
  clean: boolean;
  /** What the fix step gets: everything except what is already settled. */
  findings: Finding[];
  settled: Finding[];
  rebutted: Finding[];
}

function verdictOf(outcomes: VariantOutcome[], disputed: Finding[]): Verdict {
  const reviews = outcomes.map((v) => v.review).filter((r): r is ReviewOutput => r !== null);
  // The gate reads one synthesised review: reconciling several reviewers is the
  // synthesiser's job now, not a union taken here.
  const split = splitDisputed(
    reviews.flatMap((r) => r.findings),
    disputed,
  );
  // Clean means "nothing left for the implementer", not "nobody said anything":
  // a finding the implementer already rejected with a reason is the human's call.
  return {
    reviewed: reviews.length > 0,
    clean: reviews.length > 0 && split.live.length === 0,
    findings: split.live,
    settled: split.settled,
    rebutted: split.rebutted,
  };
}

/**
 * A step that has just stopped, on the tabs of the run. One glyph rule, `tabGlyph`'s:
 * a step's own tab used to go ✓ the moment its variants were done, and the next
 * reconcile put it back to ⚙ because the run was still going — the flicker was the
 * two writers disagreeing about what ✓ means. It means nothing is working.
 */
const markTab = Effect.fn("Engine.markTab")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  records: VariantRecord[],
) {
  yield* reconcileTabs(o, ctx, (agent) => {
    const record = records.find((r) => r.agent === agent);
    if (!record) return undefined;
    // A variant's own word for itself, as herdr would have put it.
    if (record.status === "running") return "working";
    return record.status === "blocked" ? "blocked" : "idle";
  });
});

const setView = Effect.fn("Engine.setView")(function* (
  o: EngineOptions,
  source: string,
  panes: string[],
) {
  // A filtered sidebar is a nicety; losing it must not fail the run.
  yield* o.herdr
    .agentViewSet(source, o.run.record.slug, panes)
    .pipe(Effect.catch((e) => o.run.log(`agent.view.set failed: ${reason(e)}`)));
});

const finish = Effect.fn("Engine.finish")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  status: RunStatus,
  viewSource: string,
  detail?: string,
  /** True when this ending has already been announced by the step that caused it. */
  announced = false,
) {
  const { run, out } = o;
  // Before the Run is closed: whatever it ended up doing is what it will be read as
  // having done, and this is the last moment the rules can be checked against it. The
  // granted verifications run first, so a rule about one is checked against a result.
  yield* runGrantedVerifications(o).pipe(Effect.ignore);
  yield* checkDrift(o, ctx, "finish", "finish");
  yield* standForElection(o, "finish", true);
  yield* settleAtFinish(o, ctx);
  if (status === "done") yield* recordFixedKindEvidence(o, ctx);
  const final = yield* writeCard(o, ctx, { kind: "final", step: "finish", claims: [] });
  // Once, here: the finish is the only moment at which nobody is left to make it, which
  // is what turns an owed evaluation into something a human has to know about (§9.6).
  if (final?.cross_run === "pending")
    yield* notify(o, "drift-unresolved", "cross_run_pending", { step: "cross_run" }).pipe(
      Effect.ignore,
    );
  // Last, and only on success: the claim is what stops anyone deploying on top of a
  // half-finished renovation, so it outlives every check above it.
  if (status === "done") yield* releaseHelle(o);
  run.record.status = status;
  run.record.finished_at = yield* nowIso();
  run.record.awaiting = null;
  run.record.summary = summarise(o, status);
  yield* run.save();
  // Every tab of it, once, now that there is no step to name and nothing of this run's
  // is going to work again: a tab left saying `⚙ … · review 2/5` outlives the run.
  yield* reconcileTabs(o, ctx, nothingLive);
  yield* out("");
  yield* out(run.record.summary);
  // The sidebar filter is a nicety.
  yield* Effect.ignore(o.herdr.agentViewClear(viewSource));
  if (!announced) {
    yield* notify(o, endingKind(o, status), detail ?? outcomeLine(o.run.record, status));
  }
  return status;
});

/** Which of the three endings this is, so the toast's sound and title fit it. */
function endingKind(o: EngineOptions, status: RunStatus): NotificationKind {
  if (status === "done") return "run-done";
  if (status === "blocked" && o.run.record.outstanding.length > 0) return "run-stuck";
  return status === "failed" ? "run-failed" : "needs-you";
}

/**
 * The one line an unattended human gets: what came of the Run, not that it ended.
 * The same information `summarise` writes at length, in the shape a toast can hold.
 */
export function outcomeLine(record: RunRecord, status: RunStatus): string {
  // Whatever else came of it, work that did not land is said: a result that looks
  // like it shipped and did not is worse than either outcome.
  const local = record.unpushed ? ` — commits on ${record.unpushed} are not pushed` : "";
  if (record.mr_url) return `merge request: ${record.mr_url}${local}`;
  const open = record.outstanding.length;
  // A last fix nobody reviewed is not "clean": it is what the implementer said, and
  // the line says exactly that, plus what it left open.
  if (status === "done" && record.unreviewed) {
    return `${record.unreviewed}${open > 0 ? `; ${open} non-blocking finding(s) open` : ""}${local}`;
  }
  if (open > 0) {
    const counts = new Map<string, number>();
    for (const finding of record.outstanding) {
      counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
    }
    const bySeverity = [...counts].map(([severity, n]) => `${n} ${severity}`).join(", ");
    return `${record.iteration} iteration(s), ${open} finding(s) still open — ${bySeverity}${local}`;
  }
  // "clean" alone undersells the rally: a re-review that found the last round's
  // findings gone is the good ending, and the count is what says so.
  if (status === "done") {
    return `${record.fixed > 0 ? `clean — ${record.fixed} fixed` : "clean"}${local}`;
  }
  return `${record.summary?.split("\n")[0] ?? status}${local}`;
}

export function summarise(o: EngineOptions, status: RunStatus): string {
  const { run } = o;
  const lines = [`Run ${run.id} — ${status} after ${run.record.iteration} iteration(s)`];
  for (const step of run.record.steps) {
    const marks = {
      pending: "·",
      running: "…",
      done: "✓",
      blocked: "⚠",
      failed: "✗",
    } satisfies Record<StepStatus, string>;
    const detail = step.note ? ` (${step.note})` : "";
    const errors = step.variants
      .filter((v) => v.error)
      .map((v) => `\n    ${v.label}: ${v.error}`)
      .join("");
    // One line per ticket for a sliced step: which landed, and what each left.
    const slices = step.slices
      .map(
        (slice) =>
          `\n    ${marks[slice.status]} ${slice.ticket} — ${slice.title}` +
          (slice.status === "done"
            ? ` (${slice.commits.length} commit(s), verified: ${slice.verifications.join(", ") || "nothing"})`
            : ""),
      )
      .join("");
    lines.push(`  ${marks[step.status]} ${step.id}${detail}${errors}${slices}`);
  }
  if (run.record.unreviewed) {
    lines.push("", `Not re-reviewed: ${run.record.unreviewed}`);
  }
  if (run.record.outstanding.length > 0) {
    lines.push("", "Findings still open:", formatFindings(run.record.outstanding));
  }
  if (run.record.choices.length > 0) {
    lines.push("", "Choices:", ...run.record.choices.map((c) => `  ${c.step}: ${c.title}`));
  }
  if (run.record.fanout) {
    const blocked = run.record.fanout.blocked?.repo ?? "an earlier repo";
    lines.push(
      "",
      "Repository runs:",
      ...fanoutRepos(run.record.fanout).map((entry) =>
        entry.run === null
          ? `  ${entry.repo}: not run: waiting on ${blocked}`
          : `  ${entry.repo}: ${entry.run}${entry.mr ? ` — ${entry.mr}` : ""}`,
      ),
    );
  } else if (run.record.children.length > 0) {
    lines.push("", `Chained: ${run.record.children.join(", ")}`);
  }
  if (run.record.unpushed) {
    lines.push("", `Committed on ${run.record.unpushed}, not pushed.`);
  }
  if (run.record.mr_url) {
    const tickets =
      run.record.linear_issues.length > 0 ? ` (${run.record.linear_issues.join(", ")})` : "";
    lines.push("", `Merge request: ${run.record.mr_url}${tickets}`);
  }
  if (run.record.deferred.length > 0) {
    lines.push(
      "",
      "Deferred (the architect did not apply these):",
      formatFindings(run.record.deferred),
    );
  }
  if (run.record.disputed.length > 0) {
    lines.push(
      "",
      "Disputed findings (the implementer did not apply these; the loop stopped arguing about them):",
      formatFindings(run.record.disputed),
    );
  }
  return lines.join("\n");
}
