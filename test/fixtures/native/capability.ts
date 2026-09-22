// The shared contract two projects implement differently, and the ordinary function that
// consumes it. None of it is Collie's: the service is the author's, the Layer is the
// author's, and a module reaches this file by importing it rather than by any lookup.

import { Context, Effect, Layer } from "effect";

export interface ReviewApi {
  /** What this house calls a review of one note. */
  readonly verdict: (note: string) => string;
}

export class Review extends Context.Service<Review, ReviewApi>()("fixture/Review") {}

/** One implementation, named. A module provides the one its project wants. */
export const reviewLayer = (house: string): Layer.Layer<Review> =>
  Layer.succeed(Review)(Review.of({ verdict: (note) => `${house}:${note}` }));

/** An ordinary function over the contract: no workflow, no Activity, no lookup. */
export const reviewed = (note: string): Effect.Effect<string, never, Review> =>
  Effect.map(Review, (review) => review.verdict(note));
