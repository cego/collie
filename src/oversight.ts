// What the host keeps an eye on while a Run works: the cards a human reads its progress
// from. Everything here is a view of what is already recorded — the tree, the journal,
// the Intent and its drift — so nothing a card says is a claim nobody can check.

import { Clock, Context, Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { appendCard, buildCard, inspectFor, readCheckpoints, type Card } from "./cards";
import {
  alignment,
  evaluatedFor,
  electionsPath,
  openReports,
  pendingEvaluation,
  readDrift,
  readElections,
} from "./drift";
import { readIntent } from "./intent";
import { shell } from "./mr";
import { pendingFor, proposalsPath, read as readProposals } from "./proposals";
import { deliveriesOf, herdOf } from "./steering";
import { nowIso } from "./time";
import { fingerprint, readVerifications } from "./verify";

/** One Run as the host has placed it: where it works, and where its records are. */
export interface Watched {
  readonly runId: string;
  readonly stateDir: string;
  readonly runDir: string;
  readonly evidenceDir: string;
  /** Where the work is: the Run's own worktree, or the checkout it was started in. */
  readonly cwd: string;
  readonly worktree: string | null;
  readonly mr: string | null;
  /** Whether a question of this Run's is still unanswered. */
  readonly asking: boolean;
  readonly socketPath: string | null;
}

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** What "since this work started" means: the merge-base with the default branch, or HEAD. */
export const baseOf = Effect.fn("Oversight.baseOf")(function* (cwd: string) {
  const head = yield* shell("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], cwd);
  const upstream = head.code === 0 ? head.stdout.trim() : "origin/main";
  const merged = yield* shell("git", ["merge-base", upstream, "HEAD"], cwd);
  return merged.code === 0 && merged.stdout.trim() !== "" ? merged.stdout.trim() : "HEAD";
});

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

/** Whether the Herd still owes this Run a cross-run check, has made one, or has none to make. */
const crossRunOf = Effect.fn("Oversight.crossRunOf")(function* (at: Watched) {
  const key = yield* herdOf(at.socketPath).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return "none" as const;
  const found = yield* readElections(yield* electionsPath(at.stateDir, key)).pipe(
    Effect.orElseSucceed(() => []),
  );
  const pending = pendingEvaluation(found);
  if (pending !== null && pending.runs.includes(at.runId)) return "pending" as const;
  return evaluatedFor(found, at.runId) ? ("evaluated" as const) : ("none" as const);
});

/** Proposals about this Run nobody has answered. */
const pendingProposals = Effect.fn("Oversight.pendingProposals")(function* (at: Watched) {
  const key = yield* herdOf(at.socketPath).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return [];
  const found = yield* readProposals(yield* proposalsPath(at.stateDir, key)).pipe(
    Effect.orElseSucceed(() => []),
  );
  return pendingFor(found, at.runId, yield* Clock.currentTimeMillis);
});

/**
 * One card for one slice of work, appended to the Run's cards. Never fatal: a card is how
 * a human learns what happened, and losing the work to protect the report of it is the
 * wrong way round.
 */
export const writeCard = Effect.fn("Oversight.writeCard")(function* (
  at: Watched,
  what: {
    readonly kind: Card["kind"];
    readonly step: string;
    readonly claims: ReadonlyArray<string>;
    /** Whether a model's judgement of the Intent was made, as far as this Run got. */
    readonly judged?: {
      readonly semantic: boolean;
      readonly truncated: boolean;
      readonly goal: boolean;
    };
  },
): Effect.fn.Return<Card, never, Services> {
  const base = yield* baseOf(at.cwd);
  const snapshot = yield* fingerprint(at.cwd).pipe(
    Effect.orElseSucceed(() => ({ head_sha: "", fingerprint: "" })),
  );
  const intent = yield* readIntent(at.runDir).pipe(Effect.orElseSucceed(() => null));
  const drift = yield* readDrift(at.runDir).pipe(Effect.orElseSucceed(() => []));
  const open = openReports(drift);
  const files = yield* shell("git", ["diff", "--name-only", `${base}..HEAD`], at.cwd);
  const commits = yield* shell("git", ["log", "--oneline", `${base}..HEAD`], at.cwd);
  const dirty = yield* shell("git", ["status", "--porcelain"], at.cwd);
  const branch = yield* shell("git", ["rev-parse", "--abbrev-ref", "HEAD"], at.cwd);
  const verifications = yield* readVerifications(at.evidenceDir).pipe(
    Effect.orElseSucceed(() => []),
  );
  const missing: string[] = [];
  for (const constraint of intent?.constraints ?? []) {
    const rule = constraint.rule;
    if (rule?.kind === "command_exit" && !verifications.some((one) => one.name === rule.name))
      missing.push(`no verification named ${rule.name}`);
  }
  for (const line of drift)
    if (line.kind === "skipped") missing.push(`a judgement was skipped: ${line.reason}`);

  const card = buildCard({
    run: at.runId,
    kind: what.kind,
    step: what.step,
    iteration: 0,
    at: yield* nowIso(),
    intentVersion: intent?.version ?? 0,
    revision: {
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      head_sha: snapshot.head_sha,
      fingerprint: snapshot.fingerprint,
      dirty: dirty.stdout.trim() !== "",
    },
    changes: { files: lines(files.stdout), commits: lines(commits.stdout) },
    requested: {
      goal: intent?.goal ?? null,
      constraints: (intent?.constraints ?? []).map((constraint) => constraint.text),
    },
    verifications,
    claims: what.claims.map((text) => ({ text, ref: `${at.runId}:${what.step}` })),
    missing,
    inspect: inspectFor({ worktree: at.worktree, base, mr: at.mr }),
    links: at.mr === null ? {} : { mr: at.mr },
    drift: open.map((report) => report.id),
    deliveries: (yield* deliveriesOf(at.stateDir, at.runId).pipe(
      Effect.orElseSucceed(() => []),
    )).map((entry) => entry.delivery.id),
    aligned: alignment(
      intent,
      drift,
      what.judged ?? { semantic: false, truncated: false, goal: false },
    ).aligned,
    crossRun: yield* crossRunOf(at),
    significance: {
      readiness: "claimed",
      mrTouched: what.kind === "mr",
      pendingChoice: at.asking,
      driftUnresolved: open.some((report) => report.resolution === "escalated"),
      pendingProposal: (yield* pendingProposals(at)).length > 0,
      correctionUnacknowledged: open.some((report) => report.resolution === "correction_submitted"),
      blockingDrift: open.some((report) => report.severity === "block"),
      correctionSent: open.some((report) => report.correction !== undefined),
      intentChanged: (intent?.version ?? 1) > 1,
      ended: null,
    },
    narrative: null,
  });
  yield* appendCard(at.runDir, card).pipe(Effect.ignore);
  return card;
});

/** Which checkpoints have a card already, so a restart does not card them twice. */
const cardedPath = (runDir: string) => `${runDir}/steering/carded`;

/**
 * A card per ticket an agent has said it finished, while its work is still going: a
 * human sees a slice land without waiting for the whole piece, and the agent's own words
 * for it are carried as claims and labelled as claims.
 */
export const cardCheckpoints = Effect.fn("Oversight.cardCheckpoints")(function* (
  at: Watched,
  step: string,
): Effect.fn.Return<ReadonlyArray<Card>, never, Services> {
  const fs = yield* FileSystem.FileSystem;
  const found = yield* readCheckpoints(at.runDir).pipe(Effect.orElseSucceed(() => []));
  const done = found.filter((one) => one.checkpoint.status === "done");
  if (done.length === 0) return [];
  yield* fs.makeDirectory(`${at.runDir}/steering`, { recursive: true }).pipe(Effect.ignore);
  const carded = new Set(
    lines(yield* fs.readFileString(cardedPath(at.runDir)).pipe(Effect.orElseSucceed(() => ""))),
  );
  const written: Card[] = [];
  for (const { file, checkpoint } of done) {
    const key = `${file}@${checkpoint.at}`;
    if (carded.has(key)) continue;
    yield* fs.writeFileString(cardedPath(at.runDir), `${key}\n`, { flag: "a" }).pipe(Effect.ignore);
    written.push(yield* writeCard(at, { kind: "slice", step, claims: checkpoint.claims }));
  }
  return written;
});

/** The host's eye on a Run, as the work reaches the moments a card is written at. */
export class Oversight extends Context.Service<
  Oversight,
  {
    /** A card for a piece of work that just finished, or for the Run as it ends. */
    readonly card: (
      runId: string,
      what: {
        readonly kind: Card["kind"];
        readonly step: string;
        readonly claims: ReadonlyArray<string>;
      },
    ) => Effect.Effect<void>;
    /** Cards for the tickets an agent has said it finished since the last look. */
    readonly checkpoints: (runId: string, step: string) => Effect.Effect<void>;
  }
>()("collie/Oversight") {}
