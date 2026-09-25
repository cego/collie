// Build the plan, review it, fix until nothing blocks, then open the merge request.
//
// One implementer for the whole Run: the tickets are a list it is handed one at a time,
// the fixes go back to the agent that built the work, and the merge request is written by
// the same one that knows what it did. Between them a rally — review, fix, review again —
// that leaves at the first review with nothing blocking and is bounded rather than
// endless. The review itself is `reviewing.ts`, the same pass the review workflow runs.
//
// Nothing here is a repeat declaration or a scheduler. `splitDisputed` decides what is
// still the implementer's, `settleRound` decides where a round goes, `settleFinalFix`
// decides whether the last fix stands, and `evidenceGapsOf` decides whether this Run has
// proved what it set out to prove — the same functions every workflow is held to.
//
// The Markdown beside this file is the content: the five kinds of work source, what a
// slice is told, and what the merge request has to say.

import {
  FindingSchema,
  FixOutputSchema,
  Agents,
  Children,
  Host,
  Run,
  WorkflowError,
  agentWork,
  classifyWorkSource,
  contentOf,
  defineWorkflow,
  evidenceGapsOf,
  findingKey,
  formatFindings,
  identityProblem,
  isBlocking,
  isOutcome,
  isSingleRepo,
  orderedTicketsOf,
  planReposOf,
  renderApproved,
  renderEvidence,
  renderProgress,
  requireApproved,
  settleFinalFix,
  settleRound,
  splitDisputed,
  type Finding,
  type Handed,
  type Slice,
  type SynthesisReport,
} from "collie";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import type { WorkflowEngine, WorkflowInstance } from "effect/unstable/workflow/WorkflowEngine";
import * as Activity from "effect/unstable/workflow/Activity";
import markdown from "./implement.md" with { type: "text" };
import { REVIEWER, reviewPass } from "./reviewing.ts";

const content = contentOf(markdown);
const text = Schema.String;

/** What every implement prompt is told: the plan, what it proves, and what may prove it. */
const Implementing = Schema.Struct({
  inputs: Schema.Struct({ plan: text, plan_kind: text, repo: text, outcome: text }),
  run: Schema.Struct({ dir: text, id: text }),
  verify: text,
});

const prompts = {
  build: content.template("build", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    progress: text,
    session: Schema.Struct({ ask: text }),
    obstacle: text,
  }),
  fix: content.template("fix", {
    ...Implementing.fields,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  mr: content.template("mr", {
    ...Implementing.fields,
    evidence: text,
    unreviewed: text,
    mr: Schema.Struct({ assignee: text, template: text, issues: text }),
    target_repo: text,
  }),
};

/** What an implementer is held to when it says a ticket is built. */
const Built = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  branch: Schema.optionalKey(Schema.String),
  pushed: Schema.optionalKey(Schema.Boolean),
  tickets_done: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "the tickets you built, by title",
  }),
  commits: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "the commit subjects you left behind",
  }),
  tests: Schema.optionalKey(Schema.String),
  /** A bug's reproduction, an investigation's answer, a docs run: whichever applies. */
  reproduced: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Array(Schema.String)),
  patch: Schema.optionalKey(Schema.Boolean),
  documented_commands: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** Which repositories a plan names, as a reading of it records them. */
const Reading = Schema.Struct({
  single: Schema.Boolean,
  waves: Schema.Array(Schema.Array(Schema.String)),
  refusal: Schema.NullOr(Schema.String),
});

/** A ticket as a reading of the plan records it. */
const SliceRecord = Schema.Struct({
  file: Schema.String,
  number: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
});

/** What the step that opens the merge request reports, and what it linked. */
const Opened = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  mr_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  linear_issues: Schema.optionalKey(Schema.Array(Schema.String)),
  branch: Schema.optionalKey(Schema.String),
  /** False is a real answer: auto-merge on somebody else's MR is a reason not to push. */
  pushed: Schema.Boolean,
});

/**
 * A ceiling, not a target: at most four reviews and four fixes after the build. The Run
 * leaves the loop at the first review with nothing blocking.
 */
const ROUNDS = 4;

/** One agent for the whole Run, so its model is named once and the fixes know the build. */
const BUILDER = "build";

export default defineWorkflow({
  id: "implement",
  title: "implement — build the plan, review it, fix until nothing blocks",
  description:
    "Builds from a plan dir, a Linear issue or a description, gets one complete review, fixes what blocks until a review finds nothing blocking, then opens the merge request.",
  input: Schema.Struct({
    /** Where the work is written down: a plan, a review, an issue, a follow-up, or words. */
    plan: Schema.String,
  }),
  output: Schema.String,
  agents: {
    roles: {
      implementer: { harness: "claude", model: "opus", effort: "xhigh" },
      reviewer: REVIEWER,
    },
  },
  hints: { plan: "work-source" },
  // The branch it builds, on a worktree of its own, so two Runs never share an index.
  checkout: "branch",
  // What kind of result this Run has to prove is the human's to say, and an unclassified
  // Run is held to its approved commands rather than made a feature by default.
  outcome: {
    selectable: ["feature", "bug", "refactor", "investigation", "docs", "migration"],
  },
  // A follow-up builds on the same branch, so it is this workflow again rather than
  // another one — and there is nothing to carry on from without a branch to carry it on.
  followUps: [
    {
      id: "follow-up",
      title: "Keep going on this",
      workflow: "self",
      when: "succeeded",
      eligible: (facts) => facts.branch !== null,
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const agents = yield* Agents;
      const runId = (yield* Run).id;
      const place = yield* host.place(runId);
      const cwd = place.cwd;
      const source = yield* classifyWorkSource(asked.plan).pipe(
        Effect.orElseSucceed(() => ({ kind: "text", value: asked.plan })),
      );
      const kind = place.options.outcome ?? "";
      const share = place.options.repo ?? "";
      if (source.kind === "plan-dir" && share === "") {
        const plan = yield* Activity.make({
          name: "repos",
          success: Reading,
          execute: planReposOf(source.value, cwd).pipe(
            Effect.map((read) => ({
              single: isSingleRepo(read),
              waves: read.waves.map((wave) => [...wave]),
              refusal: read.refusal?.message ?? null,
            })),
          ),
        });
        if (plan.refusal !== null) return yield* new WorkflowError({ reason: plan.refusal });
        if (!plan.single) {
          const carried = Object.fromEntries(
            Object.entries(place.options).filter(
              ([name]) => name !== "repo" && name !== "workspace",
            ),
          );
          return yield* buildEach({
            plan: source.value,
            root: cwd,
            waves: plan.waves,
            // One branch in every repository: the one asked for, or one named after this Run.
            options:
              carried.branch !== undefined || carried.task !== undefined
                ? carried
                : { ...carried, task: runId },
          });
        }
      }
      // A repository's share that did not build fails, so no wave waits on work that is not there.
      const unbuilt = (reason: string) =>
        share === "" ? Effect.succeed(reason) : Effect.fail(new WorkflowError({ reason }));
      const approved = yield* requireApproved(kind);

      const input: typeof Implementing.Type = {
        inputs: {
          plan: source.value,
          plan_kind: source.kind,
          // The host's own launch options, under the names the content asks for them by.
          repo: place.options.repo ?? "",
          outcome: kind,
        },
        run: { dir: place.dir, id: runId },
        verify: renderApproved(approved),
      };
      // Where a question the plan does not cover goes: the planner's own pane while one
      // is live, and otherwise the human's.
      const session = { ask: yield* agents.askRoute("planner", cwd) };

      // The tickets as they stand at each boundary: one added, removed or reordered while
      // another is being built is the plan from then on, and what is built stays built by
      // name. Each reading is recorded, so a replay is handed the list that was read.
      let readings = 0;
      const ticketsNow = Effect.gen(function* () {
        readings += 1;
        if (source.kind !== "plan-dir") return [];
        return yield* Activity.make({
          name: `tickets.${readings}`,
          success: Schema.Array(SliceRecord),
          execute: orderedTicketsOf(source.value, place.options.repo ?? ""),
        });
      });
      let tickets: ReadonlyArray<Slice> = yield* ticketsNow;
      // One ticket is not a plan to slice: one pass builds all of it, and only tickets
      // added after that pass are built one at a time.
      const whole = tickets.length < 2;
      const built = new Set<string>();
      const handed: Handed[] = [];
      let build: typeof Built.Type | null = null;
      for (;;) {
        // Identities before work: two tickets nobody can tell apart would share one
        // result, and finding that out after an agent has been paid for is too late.
        const clash = identityProblem(tickets.map((ticket) => ticket.file));
        if (clash !== null) return yield* new WorkflowError({ reason: clash });
        const ticket =
          whole && built.size === 0 ? null : tickets.find((one) => !built.has(one.file));
        if (ticket === undefined) break;
        const before = (yield* host.evidence(runId, cwd)).verifications.length;
        if (ticket !== null) yield* checkpoint(place.dir, ticket, "started", []);
        build = yield* agentWork({
          operation: ticket?.file ?? "build",
          agent: BUILDER,
          role: "implementer",
          skill: "implement",
          instructions: prompts.build,
          input: {
            ...input,
            ticket: { file: ticket?.file ?? "", title: ticket?.title ?? "" },
            progress: renderProgress(handed),
            session,
            obstacle: "",
          },
          output: Built,
        });
        const done: Handed = {
          item: ticket?.file ?? "build",
          title: ticket?.title ?? "",
          commits: [...(build.commits ?? [])],
          verifications: (yield* host.evidence(runId, cwd)).verifications
            .slice(before)
            .map((one) => `${one.name}: ${one.result}`),
        };
        handed.push(done);
        built.add(done.item);
        if (ticket === null) for (const one of tickets) built.add(one.file);
        if (ticket !== null) yield* checkpoint(place.dir, ticket, "done", claimsOf(build, ticket));
        // A ticket that did not land stops the plan here: the next one is written against
        // work that is not there, and building it would be building on nothing. A finding
        // nobody is blocked by is carried, exactly as a review's is.
        const blocking = (build.findings ?? []).filter(isBlocking);
        if (blocking.length > 0) {
          return yield* unbuilt(
            `${done.item}: stopped with ${blocking.length} blocking finding(s)`,
          );
        }
        tickets = yield* ticketsNow;
      }
      if (build === null) return yield* new WorkflowError({ reason: "nothing was built" });

      const rallied = yield* rally({
        cwd,
        plan: source.kind === "plan-dir" ? source.value : "",
        proves: kind,
        risks: place.options.risks ?? "",
        input,
      });
      if (rallied.halted !== null) {
        yield* host.record(runId, rallied.halted);
        return yield* unbuilt(rallied.halted);
      }

      // The gate: Collie's own run of every approved command, on this tree, and then what
      // this kind of result still has no evidence for. An Output saying the tests pass is
      // a claim; a record in the journal, bound to this tree, is not.
      const granted = yield* requireApproved(kind);
      for (const spec of granted) {
        yield* host.verify({ runId, name: spec.name, cwd });
      }
      const evidence = yield* host.evidence(runId, cwd);
      const gaps = evidenceGapsOf({
        kind: isOutcome(kind) ? kind : "unspecified",
        evidence,
        approved: granted,
        outputs: { build: { ...build }, synthesize: { ...rallied.reviewed } },
        // Only a reviewer may vouch for what a reviewer is asked: read from any Output,
        // the agent that wrote the change could vouch for its own scope.
        reviewed: ["synthesize"],
        roots: [place.dir, cwd],
        tickets: tickets.map((ticket) => ({ file: ticket.file, checks: ticket.checks })),
      });
      if (gaps.length > 0) {
        yield* host.record(runId, `no merge request: ${gaps.join("; ")}`);
        return yield* unbuilt(`no merge request: ${gaps.join("; ")}`);
      }

      // A step that needs something this machine or repository does not have is not a
      // failure: it is work that cannot be done here, and the Run says so.
      const gitlab = yield* host.mr({ cwd, source: { value: source.value, kind: source.kind } });
      if (!gitlab.ok) {
        yield* host.record(runId, `no merge request: ${gitlab.reason}`);
        return `no merge request: ${gitlab.reason}`;
      }

      const opened = yield* agentWork({
        operation: "mr",
        agent: BUILDER,
        role: "implementer",
        instructions: prompts.mr,
        input: {
          ...input,
          evidence: renderEvidence(evidence),
          unreviewed: rallied.unreviewed,
          mr: {
            assignee: gitlab.assignee,
            template: gitlab.template,
            issues: gitlab.issues.join(", "),
          },
          target_repo: "",
        },
        output: Opened,
      });
      if (opened.mr_url) yield* host.mergeRequest(runId, opened.mr_url);
      return opened.mr_url ?? (opened.pushed ? "pushed, no merge request url" : "not pushed");
    }),
});

/**
 * One Run of this workflow per repository the plan names, a wave at a time: a repository
 * starts once every one its tickets wait on is built. One that fails or cannot start
 * starts no further wave; the rest of its own wave is still waited on.
 */
const buildEach = (fan: {
  readonly plan: string;
  readonly root: string;
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  /** The launch options every repository's Run is started with, beside its own. */
  readonly options: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const children = yield* Children;
    const runId = (yield* Run).id;
    const invocation = (repo: string) => `implement-${repo.replaceAll("/", "-")}`;
    const clash = identityProblem(fan.waves.flat().map(invocation));
    if (clash !== null) return yield* new WorkflowError({ reason: clash });
    const built: string[] = [];
    for (const [at, wave] of fan.waves.entries()) {
      const started = yield* Effect.forEach(wave, (repo) =>
        children
          .start({
            invocation: invocation(repo),
            workflow: "self",
            input: { plan: fan.plan },
            options: { ...fan.options, repo, workspace: `${fan.root}/${repo}` },
          })
          .pipe(
            Effect.result,
            Effect.map((child) => ({ repo, child })),
          ),
      );
      const ended = yield* Effect.forEach(
        started,
        ({ repo, child }) =>
          child._tag === "Failure"
            ? Effect.succeed({ repo, built: null, why: `not started: ${child.failure.reason}` })
            : children.result(child.success).pipe(
                Effect.map((value) => ({ repo, built: String(value), why: "" })),
                Effect.catch((failure) =>
                  Effect.succeed({ repo, built: null, why: failure.reason }),
                ),
              ),
        { concurrency: "unbounded" },
      );
      for (const one of ended) {
        built.push(`${one.repo}: ${one.built ?? one.why}`);
        yield* host.record(runId, `${one.repo}: ${one.built ?? one.why}`);
      }
      const stopped = ended.find((one) => one.built === null);
      if (stopped !== undefined) {
        const left = fan.waves.slice(at + 1).flat();
        const waiting =
          left.length === 0 ? "" : ` Not run: ${left.join(", ")}, waiting on ${stopped.repo}.`;
        return yield* new WorkflowError({
          reason: `${stopped.repo} did not build.${waiting} ${built.join("; ")}`,
        });
      }
    }
    return `${fan.waves.flat().length} repositories built in ${fan.waves.length} wave(s): ${built.join("; ")}`;
  });

/** What the slice claims it built, or the ticket's own name where it named nothing. */
const claimsOf = (built: typeof Built.Type, ticket: Slice): ReadonlyArray<string> => {
  const named = built.tickets_done ?? [];
  return named.length > 0 ? named : [ticket.title];
};

/**
 * The card a slice landing leaves, in the shape the agent writes its own and the cards
 * read. Written here so a ticket landing is visible whether or not the agent remembered.
 */
const checkpoint = (
  dir: string,
  ticket: Slice,
  status: "started" | "done",
  claims: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* fs.makeDirectory(`${dir}/steering/progress`, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/steering/progress/${ticket.file.replace(/\.md$/, "")}.json`,
      asCheckpoint({ ticket: ticket.file, status, claims: [...claims], at }),
    );
  }).pipe(Effect.orDie);

const asCheckpoint = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ticket: Schema.String,
      status: Schema.Literals(["started", "done"]),
      claims: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  ),
);

/** Where a rally stood when it stopped: what halted it, and what the last fix left. */
interface Rallied {
  /** Why the loop stopped short, or null where it converged. */
  readonly halted: string | null;
  /** What the last fix is attested by where no review came after it; empty otherwise. */
  readonly unreviewed: string;
  /** The review that decided it, which is the one judgement the gate may read. */
  readonly reviewed: SynthesisReport;
}

/**
 * Review, fix, review again. The loop leaves at the first review with nothing blocking;
 * a dispute is carried rather than re-argued, and the last round has no review after it,
 * so that fix's own account is judged against the journal rather than taken on its word.
 */
const rally = (ask: {
  readonly cwd: string;
  readonly plan: string;
  readonly proves: string;
  readonly risks: string;
  readonly input: typeof Implementing.Type;
}): Effect.Effect<
  Rallied,
  WorkflowError,
  Run | Agents | Host | WorkflowEngine | WorkflowInstance | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const agents = yield* Agents;
    const runId = (yield* Run).id;
    let disputed: Finding[] = [];
    let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;

    for (let at = 1; at <= ROUNDS; at++) {
      const synthesis = yield* reviewPass({
        // The change is the work in this checkout: a Run that built it reviews what it
        // built, rather than a merge request somebody else has to be pointed at.
        target: "",
        plan: ask.plan,
        proves: ask.proves,
        previous: "",
        // The last round's fix, which a follow-up review checks each of its findings against.
        answered: at === 1 ? "" : agents.outputFor(runId, `fix-${at - 1}`),
        risks: ask.risks,
        at,
        of: ROUNDS,
        disputed,
      });
      const split = splitDisputed(synthesis.findings, disputed);
      const round = settleRound({ live: split.live, disputed, at, seen });
      if (round.go === "halt") {
        return { halted: `${round.halt}: ${round.reason}`, unreviewed: "", reviewed: synthesis };
      }
      if (round.go === "clean") return { halted: null, unreviewed: "", reviewed: synthesis };
      seen = { at, keys: round.keys };

      const fixed = yield* agentWork({
        operation: `fix-${at}`,
        agent: BUILDER,
        role: "implementer",
        instructions: prompts.fix,
        input: {
          ...ask.input,
          iteration: String(at),
          max_iterations: String(ROUNDS),
          findings: formatFindings(round.live),
        },
        output: FixOutputSchema,
      });
      // A dispute is carried, not re-argued: the next review either answers it with a
      // rebuttal or it stops driving the loop.
      const known = new Set(disputed.map(findingKey));
      disputed = [...disputed, ...fixed.disputed.filter((one) => !known.has(findingKey(one)))];

      if (at === ROUNDS) {
        const settled = settleFinalFix(round.live, fixed, yield* host.evidence(runId, ask.cwd));
        return settled.ok
          ? { halted: null, unreviewed: settled.attestation, reviewed: synthesis }
          : {
              halted: `${settled.halt}: ${settled.reasons.join("; ")}`,
              unreviewed: "",
              reviewed: synthesis,
            };
      }
    }
    return yield* new WorkflowError({ reason: "the rally ran no rounds at all" });
  });
