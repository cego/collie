// A workflow that reads the checkout it was started for and then hands the building to
// one that changes it. It says what the work is called, and nothing about where the child
// works: that is the child's declaration and the host's to settle.

import { NativeChildren, NativeHost, agentWork, defineWorkflow } from "collie/native";
import { Effect, Schema } from "effect";

export const id = "chains";
export const title = "Plan the work, then build it";
export const description = "One agent here, then the build as a child Run.";

export const input = {};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const place = yield* (yield* NativeHost).place(payload.runId);
      yield* agentWork({
        runId: payload.runId,
        operation: "plan",
        role: "planner",
        workflow: id,
        cwd: place.cwd,
        instructions: "Plan it.",
        output: Schema.Struct({ verdict: Schema.String }),
      });
      const children = yield* NativeChildren;
      const child = yield* children.start({
        runId: payload.runId,
        invocation: "build",
        workflow: "builds",
        input: { work: "Add a picker" },
        options: { task: "add-a-picker" },
      });
      return String(yield* children.result(child));
    }),
  );

  return { workflow, layer, decisions: {} };
};
