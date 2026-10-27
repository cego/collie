// Share 5 of the scenarios in `support/baseline.ts`, saved as a user's entries under ids that
// share nothing with the shipped ones: each has to hold here as it does as shipped.
import { register } from "./support/baseline";

register("unrelated", 5);
