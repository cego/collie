import { Deferred, Effect, Option, Result, SubscriptionRef, type Types } from "effect";
import type { HarnessCatalogue } from "../../../src/catalogue-model";
import type { ListedModel } from "./claude-models";

export type HarnessList =
  | { readonly from: "reading" }
  | { readonly from: "table"; readonly why: string }
  | { readonly from: "harness"; readonly models: ReadonlyArray<ListedModel> };

export const harnessLists = Effect.fn("HarnessLists.open")(function* (
  readers: Readonly<Record<string, Effect.Effect<ReadonlyArray<ListedModel>, string>>>,
) {
  const scope = yield* Effect.scope;
  const held = yield* SubscriptionRef.make<Readonly<Record<string, HarnessList>>>({});
  const pending = new Map<string, Deferred.Deferred<void>>();
  const now = (harness: string) => SubscriptionRef.getUnsafe(held)[harness];
  const put = (harness: string, list: HarnessList) =>
    SubscriptionRef.update(held, (all) => ({ ...all, [harness]: list }));
  const need = Effect.fn("HarnessLists.need")(function* (harness: string) {
    const reader = readers[harness];
    if (reader === undefined || pending.has(harness) || now(harness)?.from === "harness") return;
    const done = Deferred.makeUnsafe<void>();
    pending.set(harness, done);
    yield* put(harness, { from: "reading" });
    yield* reader.pipe(
      Effect.matchEffect({
        onSuccess: (models) => put(harness, { from: "harness", models }),
        onFailure: (why) => put(harness, { from: "table", why }),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(harness);
          Deferred.doneUnsafe(done, Effect.void);
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const ready = (harness: string) =>
    need(harness).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const done = pending.get(harness);
          if (done === undefined || now(harness)?.from !== "reading") return Effect.void;
          return Deferred.await(done).pipe(
            Effect.timeoutOption("20 seconds"),
            Effect.flatMap((finished) =>
              Option.isNone(finished) && now(harness)?.from === "reading"
                ? put(harness, {
                    from: "table",
                    why: "The model list did not arrive within 20 seconds",
                  })
                : Effect.void,
            ),
          );
        }),
      ),
    );
  return { now, need, ready, changes: SubscriptionRef.changes(held) };
});

export type HarnessLists = Effect.Success<ReturnType<typeof harnessLists>>;

/** A harness's list as this computer's host read it: what it does not hide, or why it read none. */
export const listedIn = (
  catalogues: ReadonlyArray<HarnessCatalogue>,
  harness: string,
  keep: (model: string) => boolean = () => true,
): Result.Result<ReadonlyArray<ListedModel>, string> => {
  const catalogue = catalogues.find((one) => one.harness === harness);
  if (catalogue === undefined) return Result.fail(`${harness} is not installed on this computer`);
  if (catalogue.table !== null) return Result.fail(catalogue.table);
  return Result.succeed(
    catalogue.entries
      .filter((entry) => !entry.hidden && keep(entry.model))
      .map(({ model, label, description, efforts }) => {
        const offered: Types.Mutable<ListedModel> = { id: model, label, efforts };
        if (description !== null) offered.description = description;
        return offered;
      }),
  );
};
