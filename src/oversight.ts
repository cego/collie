// What the host keeps an eye on while a Run works: whether the work still matches its
// Intent, and the cards a human reads its progress from. Everything here is a view of what
// is already recorded — the tree, the journal, the Intent and its drift — so nothing a
// card or a report says is a claim nobody can check.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Context, Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { appendCard, buildCard, inspectFor, readCheckpoints, type Card } from "./cards";
import {
  NOT_JUDGED,
  alignment,
  appendDrift,
  checkRules,
  electionsPath,
  evaluatedFor,
  flattenOutput,
  judge,
  newReports,
  openReports,
  pendingEvaluation,
  readDrift,
  readElections,
  recordSkipped,
  type Judged,
  type JudgementDeps,
  type RuleFacts,
} from "./drift";
import { readIntent, type Intent } from "./intent";
import { reason } from "./naming";
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
  /** Where each piece of agent work's Output is, as `<operation>.json`. */
  readonly agentsDir: string;
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
    aligned: alignment(intent, drift, yield* judgedOf(at)).aligned,
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

/** Where a Run's events are written, beside its other records in the host's directory. */
const said = (at: Watched, line: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(`${at.stateDir}/events.${at.runId}.log`, `${line}\n`, { flag: "a" }),
    ),
    Effect.ignore,
  );

const JudgedJson = Schema.fromJsonString(
  Schema.Struct({ semantic: Schema.Boolean, truncated: Schema.Boolean, goal: Schema.Boolean }),
);
const judgedPath = (runDir: string) => `${runDir}/steering/judged.json`;

/** What the last judgement of this Run got to, which is what `aligned` may claim. */
const judgedOf = (at: Watched) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(judgedPath(at.runDir))),
    Effect.flatMap(Schema.decodeUnknownEffect(JudgedJson)),
    Effect.orElseSucceed((): Judged => NOT_JUDGED),
  );

/** What a rule check compares against: the tree, every Output, and what was verified. */
export const ruleFacts = Effect.fn("Oversight.ruleFacts")(function* (at: Watched) {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* baseOf(at.cwd);
  const committed = yield* shell("git", ["diff", "--name-only", `${base}..HEAD`], at.cwd);
  const dirty = yield* shell("git", ["diff", "--name-only", "HEAD"], at.cwd);
  // Untracked too: a file an agent created is exactly what a `protected_paths` rule is
  // for, and it is in no diff until somebody commits it.
  const untracked = yield* shell("git", ["ls-files", "--others", "--exclude-standard"], at.cwd);
  const branch = yield* shell("git", ["rev-parse", "--abbrev-ref", "HEAD"], at.cwd);
  const outputs: Record<string, Record<string, string>> = {};
  const names = yield* fs.readDirectory(at.agentsDir).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = yield* fs
      .readFileString(`${at.agentsDir}/${name}`)
      .pipe(Effect.orElseSucceed(() => ""));
    if (text !== "") outputs[name.slice(0, -".json".length)] = flattenOutput(text);
  }
  const verifications: Record<string, { exit: number; ref: string }> = {};
  const verified = yield* readVerifications(at.evidenceDir).pipe(Effect.orElseSucceed(() => []));
  for (const one of verified) verifications[one.name] = { exit: one.exit, ref: one.id };
  const mr = /https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(at.mr ?? "");
  return {
    changedFiles: [...new Set(lines(`${committed.stdout}\n${dirty.stdout}\n${untracked.stdout}`))],
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    mrTarget: mr === null ? null : { project: mr[1]!, iid: mr[2]! },
    outputs,
    verifications,
  } satisfies RuleFacts;
});

/** The half Collie establishes itself: what the rules say about the evidence, recorded. */
const checkRuleDrift = Effect.fn("Oversight.checkRuleDrift")(function* (
  at: Watched,
  intent: Intent,
  where: string,
) {
  const found = checkRules(intent, yield* ruleFacts(at), yield* nowIso());
  const before = yield* readDrift(at.runDir).pipe(Effect.orElseSucceed(() => []));
  for (const report of newReports(found, before)) {
    yield* appendDrift(at.runDir, report).pipe(Effect.ignore);
    yield* said(
      at,
      `drift at ${where}: ${report.constraint} (${report.severity}) — ${report.evidence
        .map((ref) => ref.path ?? ref.excerpt ?? ref.kind)
        .join(", ")}`,
    );
  }
  // A report that was open and is no longer found is one the work came back from — but
  // only where the check found fewer things: an unchanged tree finds the same ones, and
  // calling that a fix would clear a report nobody acted on.
  for (const report of openReports(before)) {
    if (found.some((still) => still.constraint === report.constraint)) continue;
    yield* appendDrift(at.runDir, { ...report, at: yield* nowIso(), resolution: "verified" }).pipe(
      Effect.ignore,
    );
    yield* said(at, `drift ${report.constraint} cleared at ${where}`);
  }
});

/**
 * The half only a model can make: one Judgement, of the semantic constraints at every
 * boundary and of the goal as well at the finish. A judgement that could not be made is
 * recorded as skipped, which keeps the Run `unverified` rather than reading as checked.
 */
const judgeDrift = Effect.fn("Oversight.judgeDrift")(function* (
  at: Watched,
  intent: Intent,
  where: string,
  final: boolean,
  deps: JudgementDeps | null,
) {
  // A goal is judged once, at the finish: nothing mid-Run is corrected from it, so judging
  // it at every boundary would pay for the same question over and over.
  const semantic = intent.constraints.some((constraint) => constraint.kind === "semantic");
  if (!final && !semantic) return;
  if (deps === null) {
    yield* recordSkipped(at.runDir, at.runId, "there is no Herd to charge a judgement to").pipe(
      Effect.ignore,
    );
    return;
  }
  const outcome = yield* judge(deps, intent, {
    runDir: at.runDir,
    worktree: at.cwd,
    base: yield* baseOf(at.cwd),
    at: yield* nowIso(),
  }).pipe(
    Effect.catch((cause) =>
      recordSkipped(at.runDir, at.runId, `the judgement failed: ${reason(cause)}`).pipe(
        Effect.ignore,
        Effect.as({ judged: NOT_JUDGED, reports: [] }),
      ),
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${at.runDir}/steering`, { recursive: true }).pipe(Effect.ignore);
  yield* fs
    .writeFileString(judgedPath(at.runDir), Schema.encodeSync(JudgedJson)(outcome.judged))
    .pipe(Effect.ignore);
  const before = yield* readDrift(at.runDir).pipe(Effect.orElseSucceed(() => []));
  for (const report of newReports(outcome.reports, before)) {
    yield* appendDrift(at.runDir, report).pipe(Effect.ignore);
    yield* said(
      at,
      `drift at ${where}: ${report.constraint} (${report.severity}) — judged against ${report.evidence.length} piece(s) of evidence`,
    );
  }
});

/**
 * Where this Run's work stands against its Intent, at one moment: after a piece of work
 * is collected (the rules only, which cost nothing), before the next one starts, and at
 * the finish, where a model judges what no rule can. A Run with no Intent is not checked.
 */
export const checkDrift = Effect.fn("Oversight.checkDrift")(function* (
  at: Watched,
  where: string,
  judging: "none" | "boundary" | "finish",
  deps: JudgementDeps | null,
): Effect.fn.Return<void, never, BunServices> {
  const intent = yield* readIntent(at.runDir).pipe(Effect.orElseSucceed(() => null));
  if (intent === null) return;
  if (judging !== "none") yield* judgeDrift(at, intent, where, judging === "finish", deps);
  if (intent.constraints.some((constraint) => constraint.kind === "rule"))
    yield* checkRuleDrift(at, intent, where);
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
    /** The Run's work against its Intent, at one of the moments `checkDrift` names. */
    readonly drift: (
      runId: string,
      where: string,
      judging: "none" | "boundary" | "finish",
    ) => Effect.Effect<void>;
  }
>()("collie/Oversight") {}
