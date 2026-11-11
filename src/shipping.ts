import { Effect, FileSystem, Schema } from "effect";

export const MERGE_POLL_MS = 5 * 60_000;
export const ShippingAction = Schema.Literals(["merge", "stage", "deploy"]);
export type ShippingAction = typeof ShippingAction.Type;

export const ShippingGo = Schema.Union([
  Schema.Struct({ action: ShippingAction, head: Schema.NonEmptyString }),
  Schema.Struct({ action: Schema.Literal("deploy"), tag: Schema.NonEmptyString }),
]);
export type ShippingGo = typeof ShippingGo.Type;

const StageProof = Schema.fromJsonString(
  Schema.Struct({
    head: Schema.NullOr(Schema.String),
    tag: Schema.NullOr(Schema.String),
    proved: Schema.Boolean,
    why: Schema.NullOr(Schema.String),
  }),
);

export const readStageProof = Effect.fn("Shipping.readStageProof")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${dir}/shipping-stage.json`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StageProof)),
    Effect.orElseSucceed(() => null),
  );
});

export const writeStageProof = Effect.fn("Shipping.writeStageProof")(function* (
  dir: string,
  proof: typeof StageProof.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(
      `${dir}/shipping-stage.json`,
      yield* Schema.encodeEffect(StageProof)(proof).pipe(Effect.orDie),
    )
    .pipe(Effect.orDie);
});
