// What the host keeps an eye on while a Run works: whether the work still matches its
// Intent, and the cards a human reads its progress from. Everything here is a view of what
// is already recorded — the tree, the journal, the Intent and its drift — so nothing a
// card or a report says is a claim nobody can check.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Context, Effect, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { appendCard, buildCard, inspectFor, readCards, readCheckpoints, type Card } from "./cards";
import {
  EXTRA_PASSES,
  NOT_JUDGED,
  alignment,
  alreadyStood,
  appendDrift,
  appendElection,
  askJudgement,
  checkRules,
  correctionText,
  correctionsSent,
  decideCorrections,
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
  shouldStand,
  staleSince,
  type Judged,
  type JudgementDeps,
  type RuleFacts,
} from "./drift";
import { readIntent, type Intent } from "./intent";
import { reason } from "./naming";
import { appendPendingReport } from "./live";
import { withLock } from "./lock";
import { shell } from "./mr";
import {
  pendingFor,
  proposalsPath,
  read as readProposals,
  record as recordProposal,
} from "./proposals";
import {
  appendLine,
  deliveriesOf,
  herdOf,
  ledgerPath,
  newestById,
  overrideActive,
  readLedger,
} from "./steering";
import { capabilitiesOf } from "./steering-caps";
import { externalSubmissions } from "./compactors";
import { controlDir } from "./compaction";
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
  /** Whether a human has held this Run. */
  readonly held: boolean;
  /** This Run and every Run related to it: its parent, that parent's children, its own. */
  readonly family: ReadonlyArray<string>;
  /** Where any Run's records are, by its id. */
  readonly dirOf: (runId: string) => string;
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

/** The Run's own log, which its record's log tab shows: what the host saw of its work. */
export const said = (at: { readonly runDir: string }, line: string) =>
  FileSystem.FileSystem.pipe(
    Effect.tap((fs) => fs.makeDirectory(at.runDir, { recursive: true })),
    Effect.flatMap((fs) => fs.writeFileString(`${at.runDir}/log.txt`, `${line}\n`, { flag: "a" })),
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

/** The agent a correction would go to, and the one sender that takes it there. */
export interface Correcting {
  readonly agent: {
    readonly agent: string;
    readonly harness: string;
    readonly terminalId?: string | undefined;
  };
  readonly send: (correction: {
    readonly text: string;
    readonly constraint: string;
    readonly requestId: string;
    readonly attempt: number;
    readonly intentVersion: number;
    readonly mode: "boundary" | "now";
  }) => Effect.Effect<boolean>;
}

/** What correcting did: constraints a correction went out about, and ones given up on. */
export interface Corrected {
  readonly sent: ReadonlyArray<string>;
  readonly escalated: ReadonlyArray<string>;
}

const NOTHING_CORRECTED: Corrected = { sent: [], escalated: [] };

/**
 * A human typing into the agent's pane since the last look, written onto its ledger as a
 * manual override: from then on Collie does not take turns with them. Counted rather than
 * timestamped, against the count seen last time, which is kept beside the Run.
 */
const noticeOverride = Effect.fn("Oversight.noticeOverride")(function* (
  at: Watched,
  to: Correcting["agent"],
  ledger: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const seen = yield* externalSubmissions(yield* controlDir(at.stateDir, to.agent)).pipe(
    Effect.orElseSucceed(() => 0),
  );
  const file = `${at.runDir}/steering/externals.${to.agent}`;
  const before = Number(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "0")));
  if (seen <= before || to.terminalId === undefined) return;
  yield* fs.makeDirectory(`${at.runDir}/steering`, { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFileString(file, String(seen)).pipe(Effect.ignore);
  yield* appendLine(ledger, {
    kind: "manual_override",
    at: yield* nowIso(),
    incarnation: to.terminalId,
    by: "hook:UserPromptSubmit",
  }).pipe(Effect.ignore);
  yield* said(at, `${to.agent}: manual_override — someone typed into its pane`);
});

/**
 * Sends what this Run's own authority lets Collie send about its open drift, and gives up
 * where the bound is spent. Every refusal is somebody being deferred to: the human at that
 * keyboard, the human who held the Run, the human who never granted this. A correction is
 * `correction_submitted`, never `verified`: sending text is not the work changing.
 */
const correctDrift = Effect.fn("Oversight.correctDrift")(function* (
  at: Watched,
  intent: Intent,
  to: Correcting,
) {
  if (!intent.authority.auto_correct) return NOTHING_CORRECTED;
  const open = openReports(yield* readDrift(at.runDir).pipe(Effect.orElseSucceed(() => [])));
  if (open.length === 0 || to.agent.terminalId === undefined) return NOTHING_CORRECTED;
  const ledger = yield* ledgerPath(at.stateDir, to.agent.terminalId);
  yield* noticeOverride(at, to.agent, ledger);
  const lines = yield* readLedger(ledger).pipe(Effect.orElseSucceed(() => []));
  const deliveries = [...newestById(lines).values()];
  const sentSoFar = correctionsSent(deliveries);
  const capabilities = capabilitiesOf(to.agent.harness);
  const decided = decideCorrections(intent, open, {
    overridden: overrideActive(lines),
    attributable: capabilities?.attribution.status === "proven",
    held: at.held,
    sent: sentSoFar,
    inFlight: new Set(
      deliveries
        .filter((one) => one.cause.kind === "correction" && !SETTLED.has(one.state))
        .map((one) => one.cause.ref),
    ),
    nowProven: capabilities?.now.status === "proven",
  });
  const sent: string[] = [];
  for (const { report, mode } of decided) {
    const constraint = intent.constraints.find((one) => one.id === report.constraint);
    if (constraint === undefined) continue;
    const requestId = `${at.runId}-correction-${report.constraint}-${intent.version}`;
    const went = yield* to.send({
      text: correctionText(requestId, constraint, report),
      constraint: report.constraint,
      requestId,
      attempt: (sentSoFar[report.constraint] ?? 0) + 1,
      intentVersion: intent.version,
      mode,
    });
    if (!went) continue;
    yield* appendDrift(at.runDir, {
      ...report,
      at: yield* nowIso(),
      resolution: "correction_submitted",
      correction: requestId,
    }).pipe(Effect.ignore);
    yield* said(at, `correction sent for ${report.constraint} (${mode})`);
    sent.push(report.constraint);
  }
  // The bound is spent and it is still open: nothing else Collie can do about it.
  const escalated: string[] = [];
  for (const report of open) {
    if (report.resolution === "escalated") continue;
    if ((sentSoFar[report.constraint] ?? 0) < intent.authority.max_corrections_per_constraint)
      continue;
    if (decided.some((one) => one.report.constraint === report.constraint)) continue;
    yield* appendDrift(at.runDir, { ...report, at: yield* nowIso(), resolution: "escalated" }).pipe(
      Effect.ignore,
    );
    yield* said(at, `drift ${report.constraint} escalated: the correction bound is spent`);
    escalated.push(report.constraint);
  }
  return { sent, escalated };
});

/** Delivery states nothing follows, so a correction in one is not in flight. */
const SETTLED: ReadonlySet<string> = new Set(["verified", "failed", "superseded", "expired"]);

/**
 * Where this Run's work stands against its Intent, at one moment: after a piece of work
 * is collected (the rules only, which cost nothing), before the next one starts, and at
 * the finish, where a model judges what no rule can. What is open is then corrected where
 * the Intent allows and there is an agent to correct. A Run with no Intent is not checked.
 */
export const checkDrift = Effect.fn("Oversight.checkDrift")(function* (
  at: Watched,
  where: string,
  judging: "none" | "boundary" | "finish",
  deps: JudgementDeps | null,
  to: Correcting | null,
): Effect.fn.Return<Corrected, never, BunServices> {
  const intent = yield* readIntent(at.runDir).pipe(Effect.orElseSucceed(() => null));
  if (intent === null) return NOTHING_CORRECTED;
  if (judging !== "none") yield* judgeDrift(at, intent, where, judging === "finish", deps);
  const rules = intent.constraints.some((constraint) => constraint.kind === "rule");
  if (rules) yield* checkRuleDrift(at, intent, where);
  // With no rule to check there may still be something to correct, from the judgement.
  if (to === null || !(rules || judging !== "none")) return NOTHING_CORRECTED;
  return yield* correctDrift(at, intent, to);
});

/** One Run the cross-run question is about: where it has got to, and what it is for. */
interface CrossRunTarget {
  readonly id: string;
  readonly dir: string;
  readonly intentVersion: number;
  readonly goal: string | null;
  readonly constraints: ReadonlyArray<string>;
  /** Whether it has ended, so a report about it is said on the board rather than filed. */
  readonly finished: boolean;
  /** The vector as one line, which is what the log and the pack both show. */
  readonly line: string;
}

/**
 * Every related Run's Intent version, newest card and open drift: the snapshot a cross-run
 * Judgement is made from, read whether or not anyone can judge it.
 */
const versionVector = Effect.fn("Oversight.versionVector")(function* (
  at: Watched,
  family: ReadonlyArray<string>,
) {
  const targets: CrossRunTarget[] = [];
  for (const id of new Set(family)) {
    const dir = at.dirOf(id);
    const intent = yield* readIntent(dir).pipe(Effect.orElseSucceed(() => null));
    const cards = yield* readCards(dir).pipe(Effect.orElseSucceed(() => []));
    const open = openReports(yield* readDrift(dir).pipe(Effect.orElseSucceed(() => [])));
    const card = cards.at(-1);
    targets.push({
      id,
      dir,
      intentVersion: intent?.version ?? 0,
      goal: intent?.goal ?? null,
      constraints: (intent?.constraints ?? []).map(
        (one) => `${one.id} (${one.kind}/${one.severity}): ${one.text}`,
      ),
      finished: cards.some((one) => one.kind === "final"),
      line: `${id} v${intent?.version ?? 0} ${card === undefined ? "no card" : `${card.id}@${card.revision.head_sha.slice(0, 8)}`} drift ${open.length}`,
    });
  }
  return targets;
});

/** The cross-run question: what each related Run is for, and where each has got to. */
const crossRunPack = (targets: ReadonlyArray<CrossRunTarget>) =>
  [
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

/**
 * The Judgement an election exists to make: one call over the vector, and each report
 * filed on the Run it is about — its drift journal while it is working, and the board's
 * pending reports once it has ended, since a finished Run's record does not change. Why
 * none was made, or null where it was.
 */
const judgeCrossRun = Effect.fn("Oversight.judgeCrossRun")(function* (
  at: Watched,
  deps: JudgementDeps | null,
  key: string,
  targets: ReadonlyArray<CrossRunTarget>,
  snapshotAt: string,
) {
  if (deps === null) return "no Herd to charge a cross-run judgement to";
  const asked = yield* askJudgement(deps, at.runId, crossRunPack(targets));
  if (asked.refused !== null) return asked.refused;
  const byId = new Map(targets.map((target) => [target.id, target]));
  let filed = 0;
  for (const found of asked.reports) {
    // Only a Run this question was about: a report naming anything else is a model
    // reaching outside what it was shown.
    const target = byId.get(found.run);
    if (target === undefined) continue;
    const report = {
      ...found,
      at: snapshotAt,
      intent_version: target.intentVersion,
      resolution: "open" as const,
    };
    if (target.finished) {
      yield* appendPendingReport(at.stateDir, key, target.id, report).pipe(Effect.ignore);
    } else {
      const before = yield* readDrift(target.dir).pipe(Effect.orElseSucceed(() => []));
      if (newReports([report], before).length === 0) continue;
      yield* appendDrift(target.dir, report).pipe(Effect.ignore);
    }
    filed += 1;
  }
  yield* said(at, `cross-run judged at ${snapshotAt}: ${filed} report(s) filed`);
  yield* appendElection(yield* electionsPath(at.stateDir, key), {
    kind: "evaluated",
    at: snapshotAt,
    by: at.runId,
    runs: targets.map((target) => target.id),
  }).pipe(Effect.ignore);
  return null;
});

/**
 * Stands for the Herd's cross-run check, and makes it if it wins. A Run with relatives
 * stands at every boundary and at its finish; any Run stands while a check is owed, which
 * is what stops an owed check waiting for a Run that may never work again. One winner at
 * a time judges; a loser says it moved, which is what tells the winner its snapshot is
 * behind. A Run leaving without an answer writes the check down as owed.
 */
export const standForElection = Effect.fn("Oversight.standForElection")(function* (
  at: Watched,
  where: string,
  leaving: boolean,
  deps: JudgementDeps | null,
): Effect.fn.Return<void, never, BunServices> {
  const key = yield* herdOf(at.socketPath).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return;
  const file = yield* electionsPath(at.stateDir, key);
  const standing = yield* readElections(file).pipe(Effect.orElseSucceed(() => []));
  if (!shouldStand(standing, at.family.length > 1)) return;
  const now = yield* nowIso();
  if (!alreadyStood(standing, at.runId))
    yield* appendElection(file, { kind: "candidate", at: now, by: where, run: at.runId }).pipe(
      Effect.ignore,
    );
  const owed = pendingEvaluation(standing)?.runs ?? [];
  const owe = (why: string) =>
    Effect.gen(function* () {
      if (
        pendingEvaluation(yield* readElections(file).pipe(Effect.orElseSucceed(() => []))) !== null
      )
        return;
      yield* appendElection(file, { kind: "pending", since: now, runs: [...at.family] }).pipe(
        Effect.ignore,
      );
      yield* said(at, `cross-run evaluation pending for ${at.family.join(", ")}: ${why}`);
    });
  yield* withLock(
    `${file}.evaluator.lock`,
    appendElection(file, { kind: "dirty", at: now, by: where, run: at.runId }).pipe(Effect.ignore),
    Effect.gen(function* () {
      let snapshotAt = now;
      for (let passes = 0; ; passes += 1) {
        const targets = yield* versionVector(at, [...at.family, ...owed]);
        const why = yield* judgeCrossRun(at, deps, key, targets, snapshotAt).pipe(
          Effect.catch((cause) => Effect.succeed(`the judgement failed: ${reason(cause)}`)),
        );
        if (why !== null) {
          yield* said(at, `cross-run judgement not made at ${snapshotAt}: ${why}`);
          // Only a Run leaving writes it down: a mark at every boundary nobody could pay
          // for would be a mark no later boundary could clear.
          if (leaving) yield* owe("nobody could make it");
          return;
        }
        // Answered — for the snapshot it was made from. A loser's `dirty` newer than that
        // means something moved while the call was out, so judge again, a bounded number
        // of times, and then leave it owed.
        if (
          !staleSince(yield* readElections(file).pipe(Effect.orElseSucceed(() => [])), snapshotAt)
        )
          return;
        if (passes >= EXTRA_PASSES) return yield* owe("the Herd kept moving through the passes");
        snapshotAt = yield* nowIso();
      }
    }),
  ).pipe(Effect.ignore);
});

/**
 * The verifications Collie may run itself at the finish: approved for this Run, named by a
 * `command_exit` rule, and not yet run by anybody.
 */
export const grantedToRun = Effect.fn("Oversight.grantedToRun")(function* (at: Watched) {
  const intent = yield* readIntent(at.runDir).pipe(Effect.orElseSucceed(() => null));
  if (intent === null) return [];
  const wanted = new Set(
    intent.constraints.flatMap((constraint) =>
      constraint.rule?.kind === "command_exit" ? [constraint.rule.name] : [],
    ),
  );
  const already = new Set(
    (yield* readVerifications(at.evidenceDir).pipe(Effect.orElseSucceed(() => []))).map(
      (one) => one.name,
    ),
  );
  return intent.authority.run_verification
    .map((spec) => spec.name)
    .filter((name) => wanted.has(name) && !already.has(name));
});

/**
 * What a finished Run leaves behind: an honest answer about whether its work is what was
 * asked for, and — where something is still open and blocking — a proposal of a follow-up
 * Run for the human rather than another prompt to an agent. A finished Run is not extended
 * by anyone but them. The proposal's id, where one was made.
 */
export const settleAtFinish = Effect.fn("Oversight.settleAtFinish")(function* (at: Watched) {
  const intent = yield* readIntent(at.runDir).pipe(Effect.orElseSucceed(() => null));
  if (intent === null) return null;
  const drift = yield* readDrift(at.runDir).pipe(Effect.orElseSucceed(() => []));
  const verdict = alignment(intent, drift, yield* judgedOf(at));
  yield* said(at, `aligned: ${verdict.aligned} — ${verdict.why}`);
  const blocking = openReports(drift).filter((report) => report.severity === "block");
  if (blocking.length === 0) return null;
  const key = yield* herdOf(at.socketPath).pipe(Effect.orElseSucceed(() => null));
  if (key === null) {
    yield* said(at, "no Herd to record a follow-up proposal in; drift is on the Run's journal");
    return null;
  }
  const text = blocking
    .map(
      (report) =>
        `${report.constraint}: ${report.evidence.map((ref) => ref.path ?? ref.excerpt ?? ref.kind).join(", ")}`,
    )
    .join("\n");
  return yield* recordProposal(yield* proposalsPath(at.stateDir, key), {
    interpretation: `${at.runId} finished with ${blocking.length} blocking constraint(s) still open`,
    targets: [{ run: at.runId }],
    actions: [{ kind: "followup", run: at.runId, text }],
    allowedNow: [],
    intentVersions: {},
    by: `host:${at.runId}`,
  }).pipe(
    Effect.map((recorded) => recorded.id),
    Effect.catch((cause) =>
      said(at, `could not record a follow-up proposal: ${reason(cause)}`).pipe(Effect.as(null)),
    ),
  );
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
    /**
     * A Run's end, before it is reported: the verifications Collie was granted, its work
     * judged against its Intent one last time, what is still blocking offered as a
     * follow-up, and the card that closes it.
     */
    readonly finish: (runId: string) => Effect.Effect<void>;
    /** The Run's work against its Intent, at one of the moments `checkDrift` names. */
    readonly drift: (
      runId: string,
      where: string,
      judging: "none" | "boundary" | "finish",
    ) => Effect.Effect<void>;
  }
>()("collie/Oversight") {}
