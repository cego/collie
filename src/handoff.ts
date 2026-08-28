// Hand-offs between Runs in one Session: a Run that produced something a live
// agent from another Run should act on prompts that agent directly, instead of
// starting a second one that knows none of the history.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Herdr } from "./herdr";
import { REVIEW_FILE } from "./output";
import { liveAgent, registryPath, type AgentEntry, type RegistryScope } from "./registry";
import { RunStore, type Run } from "./run";

export interface Session extends RegistryScope {
  herdr: Herdr;
  stateDir: string;
  /** The Control Plane's own pane, which is what a temporary pane splits off. */
  paneId?: string | null;
}

export interface HandoffResult {
  ok: boolean;
  message: string;
}

/**
 * Writes the exchange to both Runs: the one that sent it, because that is where the
 * thing being handed over came from, and the receiver's, because a prompt that
 * arrived from somewhere else is otherwise invisible in its audit trail.
 */
export function record(session: Session, from: Run, target: AgentEntry, note: string): void {
  const at = new Date().toISOString();
  from.record.handoffs.push({ direction: "sent", role: target.role, agent: target.agent, run: target.runId, at, note });
  from.save();
  from.log(`handoff sent: ${note} -> ${target.agent}`);

  const store = new RunStore(session.stateDir);
  try {
    const to = store.load(target.runId);
    to.record.handoffs.push({ direction: "received", role: target.role, agent: target.agent, run: from.id, at, note });
    to.save();
    to.log(`handoff received: ${note} from run ${from.id}`);
  } catch {
    // The other run's dir may be gone; the sender's record is the one that matters.
  }
}

/** The live agent for a role in this Session, or null. Stale entries are dropped. */
export async function liveRole(session: Session, role: string): Promise<AgentEntry | null> {
  const alive = await session.herdr.agentList();
  return liveAgent(registryPath(session.stateDir, session), alive, role);
}

/** The newest Run in this Session that rendered a review. */
export function lastReviewRun(session: Session): Run | null {
  return (
    new RunStore(session.stateDir)
      .list()
      .find(
        (r) =>
          r.record.cwd === session.cwd &&
          (r.record.workspace === null || r.record.workspace === session.workspaceId) &&
          existsSync(join(r.dir, REVIEW_FILE)),
      ) ?? null
  );
}

/** What the implementer is told: the paths, and that this is a fix round. */
export function reviewPrompt(run: Run): string {
  const review = join(run.dir, REVIEW_FILE);
  const synthesis = run.record.synthesis ? join(run.dir, run.record.synthesis) : null;
  return [
    `A review of this branch is ready in ${review}`,
    synthesis ? `and its findings as JSON in ${synthesis}.` : "(there is no JSON alongside it).",
    "Read it and apply it as a fix round: fix what it found, commit as you go, and where you",
    "disagree with a finding say so with a reason rather than dropping it silently.",
  ].join(" ");
}

/**
 * Sends one Run's review to the Session's live implementer. Both sides record it:
 * the review run because that is where the review came from, and the implementer's
 * because a prompt that arrived from somewhere else is otherwise invisible in its
 * own audit trail.
 */
export async function sendReview(session: Session, run: Run): Promise<HandoffResult> {
  if (!existsSync(join(run.dir, REVIEW_FILE))) {
    return { ok: false, message: `${run.record.slug} has no ${REVIEW_FILE} to send` };
  }
  const target = await liveRole(session, "implementer");
  if (!target) return { ok: false, message: "no implementer is live in this workspace" };

  try {
    await session.herdr.agentPrompt(target.agent, reviewPrompt(run));
  } catch (e) {
    return { ok: false, message: `${target.agent} would not take the prompt: ${(e as Error).message}` };
  }
  record(session, run, target, `sent ${REVIEW_FILE} to the ${target.role}`);
  return { ok: true, message: `sent ${run.record.slug}'s review to ${target.agent}` };
}

/**
 * The live implementer that is building from this plan, if there is one. Not just
 * any implementer: the hand-off is only meaningful to the run whose work source is
 * the plan that changed.
 */
export async function implementerOfPlan(session: Session, planDir: string): Promise<AgentEntry | null> {
  const target = await liveRole(session, "implementer");
  if (!target) return null;
  try {
    const run = new RunStore(session.stateDir).load(target.runId);
    return run.record.inputs.plan === planDir ? target : null;
  } catch {
    // Its run dir is gone; nothing can be said about what it is building.
    return null;
  }
}

/**
 * Tells the implementer that the plan under it has moved. It is already building,
 * so this is a reconciliation, not a restart: finish what is unaffected, adjust
 * what is, and say what now conflicts.
 */
export async function sendPlanChange(
  session: Session,
  run: Run,
  opts: { planDir: string; diff: string; changelog: string },
): Promise<HandoffResult> {
  const target = await implementerOfPlan(session, opts.planDir);
  if (!target) return { ok: false, message: "no implementer is building from this plan" };

  const text = [
    `The plan you are building from has changed.${opts.changelog ? ` ${opts.changelog}` : ""}`,
    `The diff of ${opts.planDir} is in ${opts.diff}.`,
    "Reconcile: finish what it does not affect, adjust what it does, and where the change",
    "conflicts with work you have already committed, say so in your Output rather than",
    "quietly undoing either side.",
  ].join(" ");

  try {
    await session.herdr.agentPrompt(target.agent, text);
  } catch (e) {
    return { ok: false, message: `${target.agent} would not take the prompt: ${(e as Error).message}` };
  }
  record(session, run, target, "sent the plan change to the implementer");
  return { ok: true, message: `told ${target.agent} the plan changed` };
}

/**
 * What an implementer is told about asking for a decision the plan does not cover:
 * the planner's own pane when one is live, and otherwise to stop and ask the human.
 */
export async function askRoute(session: Session): Promise<string> {
  const planner = await liveRole(session, "planner");
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
}

/** The board's own version: the newest review in this Session, to its implementer. */
export async function sendReviewToImplementer(session: Session): Promise<HandoffResult> {
  const run = lastReviewRun(session);
  if (!run) return { ok: false, message: "no run here has produced a review yet" };
  return await sendReview(session, run);
}
