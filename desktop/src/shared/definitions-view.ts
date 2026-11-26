// WARNING: no Bun-only import: the view bundles this.
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

export const offersOf = (metadata: Described["metadata"]) =>
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

export const shownAs = (path: string) => (pipe(path, Str.endsWith(".md")) ? "markdown" : "code");
