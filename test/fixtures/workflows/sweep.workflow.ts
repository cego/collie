// The other entry over the same body. Nothing in it reads the id, so this workflow does
// what `roster` does — which is the whole point of two of them.

export { input, make, metadata } from "./listing.ts";

export const id = "sweep";
export const title = "Sweep a plan, ticket by ticket";
export const description = "The same list of work under a name that shares nothing with it.";
