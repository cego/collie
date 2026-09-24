// The other entry over the same body. Nothing in it reads the id, so this workflow does
// what `roster` does — which is the whole point of two of them.

import { defineWorkflow } from "collie";
import { listing } from "./listing.ts";

export default defineWorkflow({
  ...listing,
  id: "sweep",
  title: "Sweep a plan, ticket by ticket",
  description: "The same list of work under a name that shares nothing with it.",
});
