// Hand-offs between Runs in one Session: a Run that produced something a live
// agent from another Run should act on prompts that agent directly, instead of
// starting a second one that knows none of the history.

import { Crypto, Effect, FileSystem, Path, Result } from "effect";
import { nowIso } from "./time";
import { atBoundary, type CompactionSettings } from "./compaction";
import { compactionFor } from "./compactors";
import type { Herdr } from "./herdr";
import { STOPPED } from "./driver";
import { REVIEW_FILE } from "./output";
import { liveAgent, registryPath, type AgentEntry, type RegistryScope } from "./registry";
import { RunStore, type HandoffRecord, type Run } from "./run";

export interface Session extends RegistryScope {
  herdr: Pick<Herdr, "agentList" | "agentPrompt">;
  stateDir: string;
  /** The Control Plane's own pane, which is what a temporary pane splits off. */
  paneId?: string | null;
  /**
   * Where the user-wide compaction threshold is read from. A hand-off is a work
   * boundary — the receiving agent has finished its previous work and is being given
   * the next piece — so it goes through the same policy a Workflow's next step does.
   * Absent for a caller that only reads the register, which sends nothing.
   */
  configDir?: string;
  /**
   * What this caller already knows about compaction: the Run's own threshold where it
   * has one, and the test seam. Absent falls back to the config file.
   */
  compaction?: CompactionSettings;
}

/**
 * The compaction policy at a hand-off, or `null` where the caller supplied no config
 * directory to read the threshold from. The sending Run's audit trail takes the
 * warnings: a hand-off has no progress channel of its own, and its result message is
 * what both front doors show.
 */
const boundary = Effect.fn("Handoff.boundary")(function* (
  session: Session,
  from: Run,
  target: AgentEntry,
) {
  if (!session.configDir) return null;
  const deps = yield* compactionFor({
    herdr: session.herdr,
    stateDir: session.stateDir,
    configDir: session.configDir,
    log: (line: string) => from.log(line),
    known: session.compaction,
  });
  const decided = yield* atBoundary(deps, {
    agent: target.agent,
    run: from.id,
    step: `hand-off to the ${target.role}`,
  });
  return decided.dispatch ? null : held(decided.reason);
});

export interface HandoffResult {
  ok: boolean;
  message: string;
  /**
   * True where the hand-off did not happen because the receiving agent's own
   * compaction is unresolved. Not the same as having nobody to hand to, which is
   * ordinary and quiet: this one has to reach the human, because the spec asks both
   * front doors to say why work is being held.
   */
  held?: true;
}

/** Said where herdr saw no turn come of a hand-off: written, but not known read. */
const UNOBSERVED = " — herdr saw no turn start; check its pane";

function failed(message: string): HandoffResult {
  return { ok: false, message };
}

/** A hand-off that is being held by a compaction, which is a thing to say out loud. */
function held(message: string): HandoffResult {
  return { ok: false, message, held: true };
}

/**
 * Writes the exchange to both Runs: the one that sent it, because that is where the
 * thing being handed over came from, and the receiver's, because a prompt that
 * arrived from somewhere else is otherwise invisible in its audit trail.
 */
export const record = Effect.fn("Handoff.record")(function* (
  session: Session,
  from: Run,
  target: AgentEntry,
  note: string,
) {
  // One identity and one timestamp for the exchange, so either side's audit
  // trail correlates to the other and a merge can deduplicate a retried write.
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv4;
  const at = yield* nowIso();
  const store = new RunStore(session.stateDir);

  // The sender may be a snapshot the Control Plane loaded while that Run's own
  // Driver is still saving, so its entry also goes through the merge-safe append
  // rather than a whole-Run save that would revert the Driver's newer state. The
  // in-memory record keeps it too, for the sender's own later saves.
  const sent = {
    id,
    direction: "sent",
    role: target.role,
    agent: target.agent,
    run: target.runId,
    at,
    note,
  } satisfies HandoffRecord;
  from.record.handoffs.push(sent);
  yield* store.appendHandoff(from.id, sent).pipe(
    Effect.catch((error) =>
      // The prompt has already landed, so a persistence failure here must not
      // unwind the caller — the board would die mid-keypress, or the step would
      // fail a Run whose exchange really happened. The in-memory entry stands and
      // the sender's next save merges it in.
      from.log(`handoff sent but not yet persisted: ${String(error)}`).pipe(Effect.ignore),
    ),
  );
  yield* from.log(`handoff sent: ${note} -> ${target.agent}`).pipe(Effect.ignore);
  yield* Effect.gen(function* () {
    // Appended under the run lock to a freshly loaded record, so the receiving
    // Run's active Driver can neither erase this entry with a later save nor
    // have its own state rolled back by this write.
    const to = yield* store.appendHandoff(target.runId, {
      id,
      direction: "received",
      role: target.role,
      agent: target.agent,
      run: from.id,
      at,
      note,
    });
    yield* to.log(`handoff received: ${note} from run ${from.id}`).pipe(Effect.ignore);
  }).pipe(
    Effect.catch((error) =>
      // The other run's dir may be gone; the sender's record is the one that matters.
      from.log(`handoff not recorded on run ${target.runId}: ${String(error)}`).pipe(Effect.ignore),
    ),
  );
});

/**
 * The live agent for a role in this Session, or null. Stale entries are dropped, and
 * so is an agent whose Run has failed or been stopped: its pane is a transcript, not
 * a worker, and a hand-off it takes happens outside any Run's accounting. With no
 * live agent the caller falls back to chaining a fresh Run, which accounts properly.
 */
export const liveRole = Effect.fn("Handoff.liveRole")(function* (session: Session, role: string) {
  const alive = yield* session.herdr.agentList();
  const file = yield* registryPath(session.stateDir, session);
  const entry = yield* liveAgent(file, alive, role);
  if (!entry) return null;
  const run = yield* new RunStore(session.stateDir)
    .load(entry.runId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  // Its run dir is gone: nothing can be said about what the agent is doing, and a
  // hand-off into the unknown records nowhere.
  if (!run) return null;
  if (run.record.status === "failed") return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stopped = yield* fs.exists(path.join(run.dir, STOPPED));
  return stopped ? null : entry;
});

/** The newest Run in this Session that rendered a review. */
export const lastReviewRun = Effect.fn("Handoff.lastReviewRun")(function* (session: Session) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runs = yield* new RunStore(session.stateDir).list();
  for (const run of runs) {
    if (
      run.record.cwd === session.cwd &&
      (run.record.workspace === null || run.record.workspace === session.workspaceId) &&
      (yield* fs.exists(path.join(run.dir, REVIEW_FILE)))
    ) {
      return run;
    }
  }
  return null;
});

/** What the implementer is told: the paths, and that this is a fix round. */
export const reviewPrompt = Effect.fn("Handoff.reviewPrompt")(function* (run: Run) {
  const path = yield* Path.Path;
  const review = path.join(run.dir, REVIEW_FILE);
  const synthesis = run.record.synthesis ? path.join(run.dir, run.record.synthesis) : null;
  return [
    `A review of this branch is ready in ${review}`,
    synthesis ? `and its findings as JSON in ${synthesis}.` : "(there is no JSON alongside it).",
    "Read it and apply it as a fix round: fix what it found, commit as you go, and where you",
    "disagree with a finding say so with a reason rather than dropping it silently.",
  ].join(" ");
});

/**
 * Sends one Run's review to the Session's live implementer. Both sides record it:
 * the review run because that is where the review came from, and the implementer's
 * because a prompt that arrived from somewhere else is otherwise invisible in its
 * own audit trail.
 */
export const sendReview = Effect.fn("Handoff.sendReview")(function* (session: Session, run: Run) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(path.join(run.dir, REVIEW_FILE)))) {
    return { ok: false, message: `${run.record.slug} has no ${REVIEW_FILE} to send` };
  }
  const target = yield* liveRole(session, "implementer");
  if (!target) return { ok: false, message: "no implementer is live in this workspace" };
  const held = yield* boundary(session, run, target);
  if (held) return held;

  const prompt = yield* reviewPrompt(run);
  const submission = yield* session.herdr.agentPrompt(target.agent, prompt).pipe(Effect.result);
  if (Result.isFailure(submission)) {
    return failed(`${target.agent} would not take the prompt: ${String(submission.failure)}`);
  }
  const unseen = submission.success === "unobserved" ? UNOBSERVED : "";
  yield* record(session, run, target, `sent ${REVIEW_FILE} to the ${target.role}${unseen}`);
  return { ok: true, message: `sent ${run.record.slug}'s review to ${target.agent}${unseen}` };
});

/**
 * The live implementer that is building from this plan, if there is one. Not just
 * any implementer: the hand-off is only meaningful to the run whose work source is
 * the plan that changed.
 */
export const implementerOfPlan = Effect.fn("Handoff.implementerOfPlan")(function* (
  session: Session,
  planDir: string,
) {
  const target = yield* liveRole(session, "implementer");
  if (!target) return null;
  const run = yield* new RunStore(session.stateDir)
    .load(target.runId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (run) {
    return run.record.inputs.plan === planDir ? target : null;
  }
  // Its run dir is gone; nothing can be said about what it is building.
  return null;
});

/**
 * Tells the implementer that the plan under it has moved. It is already building,
 * so this is a reconciliation, not a restart: finish what is unaffected, adjust
 * what is, and say what now conflicts.
 */
export const sendPlanChange = Effect.fn("Handoff.sendPlanChange")(function* (
  session: Session,
  run: Run,
  opts: { planDir: string; diff: string; changelog: string },
) {
  const target = yield* implementerOfPlan(session, opts.planDir);
  if (!target) return { ok: false, message: "no implementer is building from this plan" };
  const held = yield* boundary(session, run, target);
  if (held) return held;

  const text = [
    `The plan you are building from has changed.${opts.changelog ? ` ${opts.changelog}` : ""}`,
    `The diff of ${opts.planDir} is in ${opts.diff}.`,
    "Reconcile: finish what it does not affect, adjust what it does, and where the change",
    "conflicts with work you have already committed, say so in your Output rather than",
    "quietly undoing either side.",
  ].join(" ");

  const submission = yield* session.herdr.agentPrompt(target.agent, text).pipe(Effect.result);
  if (Result.isFailure(submission)) {
    return failed(`${target.agent} would not take the prompt: ${String(submission.failure)}`);
  }
  const unseen = submission.success === "unobserved" ? UNOBSERVED : "";
  yield* record(session, run, target, `sent the plan change to the implementer${unseen}`);
  return { ok: true, message: `told ${target.agent} the plan changed${unseen}` };
});

/**
 * What an implementer is told about asking for a decision the plan does not cover:
 * the planner's own pane when one is live, and otherwise to stop and ask the human.
 */
export const askRoute = Effect.fn("Handoff.askRoute")(function* (session: Session) {
  const planner = yield* liveRole(session, "planner");
  if (!planner) {
    return [
      "There is no planner live for this work. If you need a decision the plan does not",
      "cover, stop, ask me in your own pane, and say in your Output that you are waiting.",
    ].join(" ");
  }
  return [
    `The planner that wrote this plan is still live as agent \`${planner.agent}\` in pane`,
    `\`${planner.paneId}\`. If you need a decision the plan does not cover, ask it rather than`,
    `stopping: \`herdr agent prompt ${planner.agent} "<your question>"\`, then read the answer`,
    `with \`herdr agent read ${planner.agent} --lines 40\`. Only stop and ask me if it cannot`,
    "answer.",
  ].join(" ");
});

/** The board's own version: the newest review in this Session, to its implementer. */
export const sendReviewToImplementer = Effect.fn("Handoff.sendReviewToImplementer")(function* (
  session: Session,
) {
  const run = yield* lastReviewRun(session);
  if (!run) return { ok: false, message: "no run here has produced a review yet" };
  return yield* sendReview(session, run);
});
