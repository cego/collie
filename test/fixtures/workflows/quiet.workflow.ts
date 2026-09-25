import { defineWorkflow } from "collie";
import { Effect } from "effect";

export default defineWorkflow({ id: "quiet", run: () => Effect.void });
