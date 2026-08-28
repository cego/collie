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
 * Sends the newest review in this Session to its live implementer. Both sides
 * record it: the review run because that is where the review came from, and the
 * message itself so the implementer's own run dir is not the only trace.
 */
export async function sendReviewToImplementer(session: Session): Promise<HandoffResult> {
  const run = lastReviewRun(session);
  if (!run) return { ok: false, message: "no run here has produced a review yet" };
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
