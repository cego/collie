// The shipped workflows as modules, run the way a user's own module is run, as shipped.
// The scenarios are in `support/baseline.ts`; `baseline-unrelated.test.ts` runs them again
// under ids that share nothing with the shipped ones.
import { register } from "./support/baseline";

register("shipped");
