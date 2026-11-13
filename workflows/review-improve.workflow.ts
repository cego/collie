import { defineWorkflow } from "collie";
import review from "./review.workflow.ts";

export default defineWorkflow({
  ...review,
  id: "review-improve",
  title: "Improve the open findings",
  follows: undefined,
  actions: [],
  run: ({ input }) => review.run({ input: { ...input, improving: true } }),
});
