// How the Workflows page draws a module a host read: its offers and its files.
// No Bun-only import: the view bundles this.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Option, Schema } from "effect";
import type { Described } from "../../../src/definitions-model";

const Offered = Schema.Struct({ id: Schema.String, title: Schema.String, workflow: Schema.String });
const Offers = Schema.Struct({
  followUps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...Offered.fields,
        when: Schema.Literals(["succeeded", "failed", "always"]),
      }),
    ),
  ),
  actions: Schema.optionalKey(Schema.Array(Offered)),
});

const AFTER = {
  succeeded: "after it succeeds",
  failed: "after it fails",
  always: "after it ends",
} as const;

export interface Offer {
  readonly id: string;
  readonly title: string;
  readonly workflow: string;
  readonly when: string;
}

/** The follow-ups and card actions a module's metadata declares; none where it says none. */
export const offersOf = (metadata: Described["metadata"]): ReadonlyArray<Offer> =>
  Option.match(Schema.decodeUnknownOption(Offers)(metadata), {
    onNone: () => [],
    onSome: ({ followUps = [], actions = [] }) => [
      ...Arr.map(followUps, ({ id, title, workflow, when }) => ({
        id,
        title,
        workflow,
        when: AFTER[when],
      })),
      ...Arr.map(actions, ({ id, title, workflow }) => ({
        id,
        title,
        workflow,
        when: "on its card",
      })),
    ],
  });

/** A module's Markdown is read rendered; anything else is code. */
export const shownAs = (path: string): "markdown" | "code" =>
  pipe(path, Str.endsWith(".md")) ? "markdown" : "code";
