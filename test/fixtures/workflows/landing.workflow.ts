// A fork of the shipped renovation that lands its work differently, and nothing else.
//
// This is the migration example: an installation whose applications do not tag, whose
// releases are a deploy, and which records a renovation on its own board. Everything up
// to the landing — the issue it binds to, the assessment, the batch, stage, the claim and
// the teammate's approval — is the shipped orchestration, reached by importing it.
//
// Nothing was added to Collie to make this possible. `renovation` takes three functions,
// this file supplies three functions, and the sections they are written from are read out
// of the shipped content the same way the shipped ones are. No service to implement, no
// step to patch, no engine to copy.

import { agentWork, defineWorkflow } from "collie";
import {
  Merged,
  Recorded,
  Released,
  TRACKER,
  renovateText,
  renovation,
  type Landing,
} from "./renovate.workflow.ts";

/** Where this fork differs, and the only thing it had to write. */
const landing: Landing = {
  merge: (at) =>
    agentWork({
      operation: "merge",
      agent: TRACKER,
      role: "renovate",
      inputs: at.inputs,
      vars: at.vars,
      // The shipped rules for what may be merged, and this fork's own way of merging.
      instructions: `${renovateText("merge")}\n\nHere, merge fast-forward only: a batch that will not fast-forward is rebased and re-approved rather than merged with a commit.`,
      output: Merged,
    }),
  release: (at) =>
    agentWork({
      operation: "release",
      agent: TRACKER,
      role: "renovate",
      inputs: at.inputs,
      vars: at.vars,
      instructions:
        "Nothing is tagged here. Deploy the default branch to production and watch it to success, then report the deployment as the version. A deploy that fails is a consultation with the claim still held.",
      output: Released,
    }),
  record: (at, released) =>
    agentWork({
      operation: "record",
      agent: TRACKER,
      role: "renovate",
      inputs: at.inputs,
      vars: { ...at.vars, released: released.version ?? "" },
      instructions:
        "Write this repository off on the team's own board: one line, the repository and what it is now running. Never rewrite a line you did not add.",
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
