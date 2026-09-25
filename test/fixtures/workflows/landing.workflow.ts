// A fork of the shipped renovation that lands its work differently, and nothing else.
//
// This is the migration example: an installation whose applications do not tag, whose
// releases are a deploy, and which records a renovation on its own board. Everything up
// to the landing — the issue it binds to, the assessment, the batch, stage, the claim and
// the teammate's approval — is the shipped orchestration, reached by importing it.
//
// Nothing was added to Collie to make this possible. `renovation` takes three functions,
// this file supplies three functions, and the one that keeps a shipped section's words is a
// template over the shipped variables, checked when this module loads like the shipped
// ones are. No service to implement, no step to patch, no engine to copy.

import { agentWork, defineWorkflow, template } from "collie";
import { Schema } from "effect";
import {
  Merged,
  RENOVATE,
  Recorded,
  Released,
  RenovateInput,
  asRenovator,
  renovation,
  type Landing,
} from "./renovate.workflow.ts";

/** The shipped rules for what may be merged, and this fork's own way of merging. */
const fastForward = template(
  `${RENOVATE.merge.text}\n\nHere, merge fast-forward only: a batch that will not fast-forward is rebased and re-approved rather than merged with a commit.`,
  RenovateInput.fields,
);

const deploy = template(
  "Nothing is tagged here. Deploy the default branch of {{inputs.repository}} to production and watch it to success, then report the deployment as the version. A deploy that fails is a consultation with the claim still held.",
  RenovateInput.fields,
);

const onOurBoard = template(
  "Write this repository off on the team's own board: one line, the repository and what it is now running ({{released}}). Never rewrite a line you did not add.",
  { ...RenovateInput.fields, released: Schema.String },
);

/** Where this fork differs, and the only thing it had to write. */
const landing: Landing = {
  merge: (at) =>
    agentWork({ ...asRenovator(at, "merge"), instructions: fastForward, output: Merged }),
  release: (at) =>
    agentWork({ ...asRenovator(at, "release"), instructions: deploy, output: Released }),
  record: (at, released) =>
    agentWork({
      ...asRenovator(at, "record"),
      instructions: onOurBoard,
      input: { ...at.input, released: released.version ?? "" },
      output: Recorded,
    }),
};

export default defineWorkflow({
  ...renovation(landing),
  id: "landing",
  title: "landing — the month's updates, merged and deployed rather than tagged",
  description:
    "The shipped renovation up to the point it lands, with a fast-forward merge, a deploy instead of a tag, and the record written on this installation's own board.",
});
