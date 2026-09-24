// One of two entries over the same body, under a public id of its own.

import { defineWorkflow } from "collie";
import { listing } from "./listing.ts";

export default defineWorkflow({
  ...listing,
  id: "roster",
  title: "Build a plan's tickets one at a time",
  description: "Hands each ticket of a plan to one implementer, in order.",
});
