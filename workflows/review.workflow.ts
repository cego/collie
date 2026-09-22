// One complete review of a target, reconciled into the one review a human reads, and then
// what to do about it.
//
// A reviewer per declared axis — the baseline is one, and a second is a list entry rather
// than a new primitive — then the synthesis that reconciles them, written to this Run's
// own directory as prose for the human and findings for the card. The menu after it comes
// back until something terminal happens: a note that did not land is not an answer.
//
// The Markdown beside this file is the content: how to read each kind of target, what a
// reviewer is asked for, and what the fix is told about where it stands.

import {
  FixOutputSchema,
  NativeAgents,
  NativeChildren,
  NativeHost,
  REVIEW_FILE,
  ReviewOutputSchema,
  SynthesisSchema,
  agentWork,
  ask,
  contentOf,
  decision,
  defineWorkflow,
  formatFindings,
  leaveReview,
  parseMrTarget,
  repoArgs,
  riskLine,
  targetKind,
  type WorkflowMetadata,
} from "collie/native";
import { Effect, FileSystem, Schema } from "effect";
import markdown from "./review.md" with { type: "text" };

export const id = "review";
export const title = "review — an MR, a branch diff, or the working tree";
export const description =
  "You pick the target — an MR, a branch diff or the working tree — one complete review comes out, and what happens next is your call: fix the findings here, hand them to a live implementer, run a full implement, or post the review to somebody else's merge request.";

export const input = {
  target: Schema.String,
  /** Empty unless a workflow embedding this one has a spec to hold the change to. */
  plan: Schema.optionalKey(Schema.String),
  /**
   * What kind of result the change under review has to prove, which decides the one
   * judgement field the reviewer is asked for. Not `outcome`: that is what this Run
   * proves, and a review always proves a review.
   */
  proves: Schema.optionalKey(Schema.String),
};

export const metadata: WorkflowMetadata = {
  hints: { target: "diff-target" },
  // A review proves it wrote a review a human can read; nobody chooses that.
  outcome: { fixed: "review" },
  // What a finished review offers to do next. Declared here because it is this workflow
  // that knows a review can be fixed and re-run — Collie only carries the offer.
  actions: [
    {
      id: "fix-open",
      title: "Fix what is open",
      workflow: "implement",
      arguments: {},
      inputs: { plan: "run-dir" },
      eligible: (facts) => facts.openFindings > 0,
    },
    {
      id: "run-again",
      title: "Review again",
      workflow: "self",
      arguments: {},
      inputs: { target: "diff-target" },
      eligible: (facts) => facts.diffTarget !== null,
    },
  ],
};

const content = contentOf(markdown);
const prompt = (section: string) =>
  [content.preamble, content.sections.get(section) ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");

/**
 * One complete review. A second reviewer and the model that reconciles them are what a
 * specialist axis or a layer override is for, not what every change gets.
 */
const REVIEWERS = [{ harness: "claude", model: "opus", effort: "medium" }];

const FIX = "Fix findings";
const IMPLEMENT = "Fix findings in a full implement run";
const POST = "Post to MR";
const DONE = "Don't post";

/** How often the menu may come back. A post that did not land asks again; not for ever. */
const ROUNDS = 4;

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const menu = Array.from({ length: ROUNDS }, (_, at) =>
    decision(`post-${at + 1}`, { prompt: "What next?", options: [FIX, IMPLEMENT, POST, DONE] }),
  );

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const agents = yield* NativeAgents;
      const children = yield* NativeChildren;
      const fs = yield* FileSystem.FileSystem;
      const runId = payload.runId;
      const asked = payload.input;
      const place = yield* host.place(runId);
      const kind = targetKind(asked.target);

      // The extra axes and the earlier review are the host's own — a caller attaches them
      // to the work rather than declaring them here, and `previous` names the Run whose
      // review this one is a follow-up to.
      const previous = place.options.previous ?? "";
      const before =
        previous === ""
          ? ""
          : yield* fs
              .readFileString(`${(yield* host.place(previous)).dir}/${REVIEW_FILE}`)
              .pipe(Effect.orElseSucceed(() => ""));

      const inputs = {
        target: asked.target,
        target_kind: kind,
        plan: asked.plan ?? "",
        // What the change has to prove, under the name the prose asks for it by.
        outcome: asked.proves ?? "",
      };
      const vars = {
        run: { dir: place.dir, id: runId },
        previous: { review: before },
        // A standalone review is one round of one review: the rally belongs to whoever
        // embeds this, and the numbers say what is true here rather than what is usual.
        iteration: "1",
        max_iterations: "1",
        disputed: formatFindings([]),
        risks: riskLine(place.options.risks ?? ""),
        target_repo: repoArgs(parseMrTarget(asked.target)?.project ?? null).join(" "),
        obstacle: "",
      };

      const reviews = yield* Effect.forEach(REVIEWERS, (reviewer, at) =>
        agentWork({
          runId,
          operation: `review-${at + 1}`,
          role: "reviewer",
          workflow: id,
          harness: reviewer.harness,
          model: reviewer.model,
          effort: reviewer.effort,
          cwd: place.cwd,
          instructions: prompt("review"),
          inputs,
          vars,
          output: ReviewOutputSchema,
        }),
      );

      const synthesis = yield* agentWork({
        runId,
        operation: "synthesize",
        role: "reviewer",
        workflow: id,
        cwd: place.cwd,
        instructions: prompt("synthesize"),
        inputs,
        vars: {
          ...vars,
          fan_in: reviews
            .map((_, at) => `- ${agents.outputFor(runId, `review-${at + 1}`)}`)
            .join("\n"),
        },
        output: SynthesisSchema,
      });
      // The prose a human reads and the findings a card counts, where both are looked for.
      yield* leaveReview(place.dir, synthesis);

      let fixes = 0;
      for (const question of menu) {
        // Posting is offered for a merge request and nothing else; whether this is one to
        // post to is decided when it is invoked, by whoever can actually see GitLab.
        const chosen = yield* ask(
          runId,
          question,
          [FIX, IMPLEMENT, ...(kind === "mr" ? [POST] : []), DONE].filter(
            (one) => one !== FIX || fixes === 0,
          ),
        );
        if (chosen === DONE) return `${synthesis.findings.length} finding(s), not posted`;

        if (chosen === POST) {
          const posted = yield* host.post({
            runId,
            target: asked.target,
            cwd: place.cwd,
            file: `${place.dir}/${REVIEW_FILE}`,
          });
          yield* host.record(runId, posted.message);
          // A note that did not land is not an answer, so the menu comes back.
          if (posted.ok) return posted.message;
          continue;
        }

        if (chosen === IMPLEMENT) {
          const child = yield* children.start({
            runId,
            invocation: "implement",
            workflow: "implement",
            input: { plan: place.dir, target: asked.target },
            options: { workspace: place.cwd },
          });
          yield* children.result(child);
          return `${synthesis.findings.length} finding(s), fixed in ${child.runId}`;
        }

        fixes += 1;
        const fixed = yield* agentWork({
          runId,
          operation: "fix",
          role: "implementer",
          workflow: id,
          cwd: place.cwd,
          instructions: prompt("fix"),
          inputs,
          vars,
          output: FixOutputSchema,
        });
        yield* host.record(runId, `fixed ${fixed.fixed.length}, disputed ${fixed.disputed.length}`);
      }
      return `${synthesis.findings.length} finding(s), asked ${ROUNDS} times what to do next`;
    }),
  );

  return {
    workflow,
    layer,
    decisions: Object.fromEntries(menu.map((one) => [one.asks.name, one])),
  };
};
