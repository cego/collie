export * from "./sdk";
export * from "./agents";

import type { SynthesisSchema } from "./output";
/** Declared for authors in `SDK_DECLARATIONS`; here it is the schema's own type. */
export type SynthesisReport = typeof SynthesisSchema.Type;
