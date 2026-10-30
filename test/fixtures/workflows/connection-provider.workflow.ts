import { defineWorkflow } from "collie";
import { Effect } from "effect";

export default defineWorkflow({
  id: "connection-provider",
  connections: {
    needs: { helle: { with: "Holds the shared environment" } },
    uses: { linear: { with: "Files an issue", without: "Leaves the report in the Run" } },
  },
  run: () => Effect.void,
});
