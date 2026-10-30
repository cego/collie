import { defineWorkflow } from "collie";
import { Effect } from "effect";

export default defineWorkflow({
  id: "connection-offers",
  connections: { uses: { linear: { with: "Files an issue", without: "Keeps the local report" } } },
  actions: [
    {
      id: "file",
      title: "File an issue",
      workflow: "connection-provider",
      arguments: {},
      eligible: () => true,
      connections: ["linear"],
    },
    {
      id: "local",
      title: "Read the local report",
      workflow: "connection-provider",
      arguments: {},
      eligible: () => true,
    },
  ],
  run: () => Effect.void,
});
