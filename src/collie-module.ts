// What a shipped workflow's `import … from "collie"` is at runtime (`sdkModules` in
// `engine.ts`), as one module the project's own typecheck can resolve.
export * from "./sdk";
export * from "./agents";

import type { SynthesisSchema } from "./output";
/** Declared for authors in `SDK_DECLARATIONS`; here it is the schema's own type. */
export type SynthesisReport = typeof SynthesisSchema.Type;
