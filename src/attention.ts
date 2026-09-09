import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  claimExists,
  driverOwnership,
  pendingResumeAt,
  readChoice,
  type Ownership,
  type PendingChoice,
} from "./driver";
import type { AgentsAlive, AsksAgents } from "./herdr";
import { runSettled, runStatus } from "./operations";
import { runningAgents, type Run } from "./run";

/**
 * What a Run wants from whoever is watching it. `none` is the ordinary case — the Run
 * is working and nobody has to do anything — and everything else is a reason to come
 * back to it. Kept apart from the lifecycle status on purpose: `waiting` already means
 * something (a Run that has not settled), and redefining it would change what every
 * existing wait and fan-out returns.
 */
export type AttentionCategory = "none" | "question" | "completed" | "interrupted";

export interface Attention {
  readonly category: AttentionCategory;
  /** Stable across releases; the code an agent branches on. */
  readonly reason: string;
  readonly explanation: string;
  readonly step: string | null;
  /** The `run` subcommands that make sense here, by name. */
  readonly actions: ReadonlyArray<string>;
  readonly choice: PendingChoice | null;
  /** Whether a Driver owns this Run, has conclusively gone, or could not be read. */
  readonly driver: Ownership;
  /** The Steps a resume keeps, by id. Nothing already done is redone. */
  readonly preserved: ReadonlyArray<string>;
  /**
   * The agents this Run's record still had running when it was last written. Recorded,
   * not probed — `agentsAlive` is what herdr was actually asked. Named so a human can
   * look before starting anything that could compete.
   */
  readonly agents: ReadonlyArray<string>;
  /** What herdr says about those agents, where there was a reason to ask. */
  readonly agentsAlive: AgentsAlive;
}

/**
 * The one classification both front doors read: the CLI's `show` and attention wait,
 * and the board's detail, all render this rather than each deciding for themselves what
 * a stopped Run means.
 *
 * A pending Choice outranks everything: a Run can be terminal in its own record while
 * its Driver still holds a question open, and the question is the actionable half.
 * Only the Choice file counts as one. A Step's `awaiting` text says an agent is being
 * waited on, which nobody can answer — treating it as attention would wake every caller
 * on every ordinary Step.
 *
 * Every other verdict is derived from what is already recorded — the Step results, the
 * findings the loop still owns, the stop marker and the Driver's ownership claim. What
 * none of those settle is reported as unknown rather than guessed at.
 *
 * The Run is all a caller passes. The lifecycle status is read here rather than taken
 * as an argument: it has to be this Run's status at this moment for any of the verdicts
 * below to mean anything, and a caller holding a stale or unrelated one got a confident
 * wrong answer with nothing to catch it. Reading it costs the caller nothing it was not
 * already paying — every one of them called `runStatus` itself to fill that argument.
 */
export const attentionFor = Effect.fn("attention.attentionFor")(function* (
  run: Run,
  agents: AsksAgents,
): Effect.fn.Return<
  Attention,
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | BunServices
> {
  const status = yield* runStatus(run);
  const driver = yield* driverOwnership(run.dir);
  const facts: Pick<Attention, "driver" | "preserved" | "agents" | "agentsAlive"> = {
    driver,
    preserved: run.record.steps.filter((step) => step.status === "done").map((step) => step.id),
    agents: runningAgents(run.record),
    // Overridden only where a resume could be offered; nothing else asks herdr.
    agentsAlive: "unasked",
  };
  const choice = yield* readChoice(run.dir);
  // Worked out before the Choice is trusted: a Driver killed while holding a question
  // leaves `choice.json` behind, and the next Driver clears it as stale for exactly
  // that reason. Answering one has nobody to consume the answer, so a question outlives
  // its Driver as a fact about the past, not as something to do. Whether the Run has
  // since been stopped makes no difference — a stop does not remove the file, and a
  // Choice a live Driver is still holding stays answerable however its record reads.
  const gone = yield* orphaned(run, driver);
  if (choice && !gone)
    return {
      ...facts,
      category: "question",
      reason: "choice_pending",
      explanation: `${run.id} is asking: ${choice.header}`,
      step: choice.step,
      actions: ["answer", "show", "stop"],
      choice,
    };
  if (status === "succeeded")
    return {
      ...facts,
      category: "completed",
      reason: "succeeded",
      explanation: `${run.id} succeeded.`,
      step: currentStep(run),
      actions: ["show", "output"],
      choice: null,
    };
  const interrupted = whyInterrupted(run, status, gone);
  if (interrupted === null)
    return {
      ...facts,
      category: "none",
      reason: "working",
      explanation: `${run.id} is ${status}.`,
      step: currentStep(run),
      actions: ["show", "stop"],
      choice: null,
    };
  // Asked here and nowhere else: only an interrupted Run with no Driver could be
  // offered a resume, so that is the one place the answer changes anything. Every
  // other verdict — and every ordinary tick of an attention wait — costs no herdr call.
  const agentsAlive = driver === "none" ? yield* agents.agentsAlive(facts.agents) : "unasked";
  return {
    ...facts,
    agentsAlive,
    category: "interrupted",
    reason: interrupted.reason,
    explanation: [
      interrupted.explanation,
      ownershipSays(run.id, driver, facts.agents, agentsAlive),
    ].join(" "),
    step: interrupted.step,
    actions: recoveryActions(driver, agentsAlive),
    choice: null,
  };
});

/**
 * Whether a pending Choice can still be answered. Only a Driver consumes an answer, so
 * a question left behind by one that is gone is no longer a question: the inbox entry
 * would be discarded by the next Driver as stale, after the human had been told it was
 * sent. The same judgement `attentionFor` makes, exported so the board's rows and the
 * classification cannot offer different answers about one Run.
 */
export const choiceAnswerable = Effect.fn("attention.choiceAnswerable")(function* (
  run: Run,
): Effect.fn.Return<
  boolean,
  PlatformError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return !(yield* orphaned(run, yield* driverOwnership(run.dir)));
});

interface Stopped {
  reason: string;
  explanation: string;
  step: string | null;
}

/** Why a Run that has ended did, from what it recorded on its way out. */
function whyStopped(run: Run, status: string): Stopped {
  const findings = run.record.outstanding.length;
  if (findings > 0 && run.record.iteration >= run.record.max_iterations) {
    return {
      reason: "review_exhausted",
      explanation: `${run.id} used all ${run.record.max_iterations} review iterations with ${findings} finding(s) still open.`,
      step: currentStep(run),
    };
  }
  const blocked = run.record.steps.find((step) => step.status === "blocked");
  if (blocked) {
    return {
      reason: "step_blocked",
      explanation: `${run.id} stopped at ${blocked.id}: ${blocked.note ?? "it needs a human"}.`,
      step: blocked.id,
    };
  }
  if (status === "stopped") {
    return { reason: "stopped", explanation: `${run.id} was stopped.`, step: currentStep(run) };
  }
  // Everything else the record can say here is `failed` or `blocked`, and neither
  // carries a cause. Saying so is the honest end of the list: an explanation that
  // invented one would be worse than an explanation that admits to none.
  return {
    reason: "failed",
    explanation: `${run.id} ended unsuccessfully, and nothing it recorded says why.`,
    step: currentStep(run),
  };
}

/**
 * How long a Driver has to claim the Run it was started for before that counts as a
 * lost Driver. `run start` and `run resume` both return the moment they have spawned
 * one, and the claim lands a process start later — so without this, waiting on a Run
 * you have just started or just resumed reports it as lost before it has had a chance
 * to claim itself.
 */
const CLAIM_GRACE_MS = 30_000;

/**
 * Whether this Run has been left with nobody driving it — and only where that is
 * conclusive: an ownership Collie could not read is not evidence the Driver is gone,
 * and neither is a Driver that has been started and has not claimed the Run yet.
 *
 * The one question behind two answers: nothing is left to consume an answer to a
 * pending Choice, and nothing is left to finish the work.
 */
const orphaned = Effect.fn("attention.orphaned")(function* (run: Run, driver: Ownership) {
  if (driver !== "none") return false;
  return !(yield* stillClaiming(run));
});

/**
 * Why a Run has stopped short, if it has. A Run that ended says so in its own record; a
 * Run that still calls itself running has stopped short only if nothing is driving it.
 */
function whyInterrupted(run: Run, status: string, gone: boolean): Stopped | null {
  if (runSettled(status)) return whyStopped(run, status);
  if (!gone) return null;
  return {
    reason: "driver_lost",
    explanation: `${run.id} records itself as running, but no Driver owns it.`,
    step: currentStep(run),
  };
}

/**
 * Whether a Driver is on its way to claiming this Run. The two ways that happens look
 * different on disk: a brand-new Run has no claim file at all, and a resumed one still
 * has the dead Driver's, with an unconsumed `resume` in its inbox. Both get the same
 * bounded benefit of the doubt, after which an unclaimed Run really is unclaimed.
 */
const stillClaiming = Effect.fn("attention.stillClaiming")(function* (run: Run) {
  const now = yield* Clock.currentTimeMillis;
  if (!(yield* claimExists(run.dir)))
    return now - Date.parse(run.record.created_at) < CLAIM_GRACE_MS;
  const asked = yield* pendingResumeAt(run.dir);
  return asked !== null && now - asked < CLAIM_GRACE_MS;
});

/** Who else may be working on this Run, as the sentence a human reads after the cause. */
function ownershipSays(
  runId: string,
  driver: Ownership,
  agents: ReadonlyArray<string>,
  alive: AgentsAlive,
): string {
  const also = agentsSay(agents, alive);
  if (driver === "live") return `A Driver still owns it, so stop that before anything else.${also}`;
  if (driver === "unknown")
    return `Whether a Driver still owns it could not be determined, so resuming it could start a second one — look at run ${runId} before acting.${also}`;
  return `No Driver owns it, so a resume keeps what is done and picks up the rest.${also}`;
}

/** The agents' half of that, as herdr answered for them. */
function agentsSay(agents: ReadonlyArray<string>, alive: AgentsAlive): string {
  if (agents.length === 0) return "";
  const named = agents.join(", ");
  switch (alive) {
    case "live":
      return ` ${named} is still live, so stop that before resuming.`;
    case "unverified":
      return ` Whether ${named} is still live cannot be verified from here — retry when herdr is reachable.`;
    case "absent":
      return ` herdr no longer has ${named}.`;
    // Nothing was asked, because nothing hung on the answer.
    case "unasked":
      return ` These agents may still be live: ${named}.`;
  }
}

/**
 * Only what is safe right now. A resume is offered where the Driver is conclusively
 * gone and every agent the Run still records is conclusively gone with it — an agent
 * herdr could not be asked about counts against it, because resuming would reset the
 * Step under whatever is still writing in that worktree. `run resume` re-checks both,
 * so advice that has gone stale by the time it is acted on is refused there rather
 * than starting a second Driver.
 */
function recoveryActions(driver: Ownership, agents: AgentsAlive): ReadonlyArray<string> {
  // Whatever is still there can be stopped, and the explanation says to: an action a
  // consumer is told to take has to be one this list offers, or it cannot take it.
  if (driver === "live" || agents === "live") return ["show", "logs", "stop"];
  if (driver === "unknown" || agents !== "absent") return ["show", "logs"];
  return ["show", "logs", "resume"];
}

/** The Step the Run is on, where its record says: the last one that is not pending. */
function currentStep(run: Run): string | null {
  const running = run.record.steps.find((step) => step.status === "running");
  if (running) return running.id;
  return run.record.steps.findLast((step) => step.status !== "pending")?.id ?? null;
}
