import { Host, Run, agentWork, contentOf, defineWorkflow, step } from "collie";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schema } from "effect";
import markdown from "./file-issue.md" with { type: "text" };

const TEAM = "linear-team";

export const FileIssueOutput = Schema.Struct({
  identifier: Schema.String.annotate({ description: "the issue's key, as Linear shows it" }),
  url: Schema.String.annotate({ description: "the issue's own URL" }),
});

const content = contentOf(markdown);

const fileIt = step({
  id: "file-issue",
  title: "File the issue",
  description: "The agent files the finding as one Linear issue through its Linear MCP.",
  kind: "agent",
  role: "generalist",
});

export default defineWorkflow({
  id: "file-issue",
  connections: {
    uses: {
      linear: {
        with: "Files the issue through its Linear MCP",
        without: "Cannot file an issue",
      },
    },
  },
  title: "file-issue — file one finding as a Linear issue",
  description:
    "One agent files one finding as a Linear issue through its Linear MCP, on the team the Run remembers, and the Run answers with the issue's URL.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  path: [fileIt],
  run: ({ input }) =>
    Effect.gen(function* () {
      const run = yield* Run;
      const asked = yield* (yield* Host).asked(run.id);
      const answered = Option.flatMapNullishOr(
        Arr.findLast(asked, (one) => one.name === TEAM),
        (one) => one.answer,
      );
      const filed = yield* fileIt(
        agentWork({
          operation: "file-issue",
          role: "generalist",
          instructions: content.template("file-issue", {
            goal: Schema.String,
            team: Schema.String,
          }),
          input: { goal: input.goal, team: Option.getOrElse(answered, () => "") },
          output: FileIssueOutput,
        }),
      );
      return filed.url;
    }),
});
