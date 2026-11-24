import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Schema, SchemaRepresentation, Stream } from "effect";
import { RunDetail } from "../src/board-model";
import { frontDoor, socketOf } from "../src/host";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import frozenJson from "./fixtures/run-detail-base.json";

// WARNING: master's wire schema before revisions, as an older client decodes it; this fixture is frozen.
const frozen: unknown = frozenJson;
const baseRunDetail = Schema.make<Schema.Codec<unknown, unknown>>(
  SchemaRepresentation.fromRepresentation(
    // WARNING: the fixture is `SchemaRepresentation.toJson` of that schema's representation.
    SchemaRepresentation.fromJson(frozen as Schema.Json),
    { revivers: [SchemaRepresentation.isFiniteReviver, SchemaRepresentation.isIntReviver] },
  ).ast,
);

const RunId = Schema.Struct({ data: Schema.Struct({ runId: Schema.String }) });

const finished = (world: World) =>
  Effect.gen(function* () {
    const { envelope } = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
    const { runId } = (yield* Schema.decodeUnknownEffect(RunId)(envelope)).data;
    yield* collie(world, ["run", "wait", runId]);
    return runId;
  }).pipe(Effect.orDie);

interface Revision {
  readonly epoch: string;
  readonly seq: number;
}

interface Sent {
  readonly _tag?: string;
  readonly revision?: Revision;
  readonly pending?: ReadonlyArray<string>;
  readonly flow?: unknown;
  readonly diff?: unknown;
  readonly tail?: unknown;
}

const framesOf = (
  world: World,
  runId: string,
  more: { readonly held?: Revision; readonly parts?: boolean },
) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(world.state));
    // WARNING: the fields a base host's schema lacks are sent as they are, and what comes back is read as no more than `Sent` says.
    return door
      .runDetail({ runId, tail: true, pages: 1, refreshMr: false, ...more })
      .pipe(Stream.map((frame) => frame as Sent | null));
  });

const isDone = (frame: Sent | null) =>
  frame !== null && frame._tag === undefined && frame.pending?.length === 0;

test("a record's first frame is its Flow at a revision, and its diff and log tail come after", () =>
  proves(
    "collie-record-first-",
    (world) =>
      Effect.gen(function* () {
        const runId = yield* finished(world);
        const frames = yield* (yield* framesOf(world, runId, { parts: true })).pipe(
          Stream.takeUntil(isDone),
          Stream.runCollect,
          Effect.timeout("30 seconds"),
          Effect.orDie,
        );
        const [first, ...later] = frames;

        expect(first?.flow).toBeDefined();
        expect(first?.revision).toBeDefined();
        expect(first?.diff ?? null).toBeNull();
        expect(first?.tail ?? null).toBeNull();
        expect(first?.pending).toEqual(expect.arrayContaining(["diff", "tail"]));
        const tailed = Arr.findFirst(later, (one) => (one?.tail ?? null) !== null);
        expect(tailed._tag === "Some" && tailed.value?.revision !== undefined).toBe(true);
        const diffed = Arr.findFirst(later, (one) => !(one?.pending ?? []).includes("diff"));
        expect(diffed._tag === "Some" && diffed.value?.revision !== undefined).toBe(true);
      }),
    ["plain.workflow.ts"],
  ));

test("a caller holding the current revision is told Unchanged; an older one, or another host's, is sent the record", () =>
  proves(
    "collie-record-resume-",
    (world) =>
      Effect.gen(function* () {
        const runId = yield* finished(world);
        const opened = (held: Revision) =>
          framesOf(world, runId, { parts: true, held }).pipe(
            Effect.flatMap(Stream.runHead),
            Effect.map((head) => (head._tag === "Some" ? head.value : null)),
            Effect.timeout("30 seconds"),
            Effect.orDie,
          );
        const done = yield* (yield* framesOf(world, runId, { parts: true })).pipe(
          Stream.filter(isDone),
          Stream.runHead,
          Effect.timeout("30 seconds"),
          Effect.orDie,
        );
        const held = done._tag === "Some" ? done.value!.revision! : { epoch: "", seq: 0 };

        const same = yield* opened(held);
        const older = yield* opened({ ...held, seq: held.seq - 1 });
        yield* stopHost(world.state);
        yield* collie(world, ["run", "show", runId]);
        const restarted = yield* opened(held);

        expect(same).toEqual({ _tag: "Unchanged", revision: held });
        expect(older?._tag).toBeUndefined();
        expect(older?.flow).toBeDefined();
        expect(older?.revision).toEqual(held);
        expect(restarted?._tag).toBeUndefined();
        expect(restarted?.flow).toBeDefined();
        expect(restarted?.revision?.epoch).not.toBe(held.epoch);
      }),
    ["plain.workflow.ts"],
  ));

test("a caller that sends no revision fields is sent a record the base's schema decodes", () =>
  proves(
    "collie-record-compat-",
    (world) =>
      Effect.gen(function* () {
        const runId = yield* finished(world);
        const first = yield* (yield* framesOf(world, runId, {})).pipe(
          Stream.runHead,
          Effect.timeout("30 seconds"),
          Effect.orDie,
        );
        expect(first._tag).toBe("Some");
        const sent = yield* Schema.encodeEffect(Schema.NullOr(RunDetail))(
          // WARNING: an ask without `held` is answered with a record or null, never Unchanged.
          first._tag === "Some" ? (first.value as RunDetail | null) : null,
        ).pipe(Effect.orDie);
        const decoded = yield* Schema.decodeEffect(Schema.NullOr(baseRunDetail), {
          onExcessProperty: "error",
        })(sent).pipe(Effect.exit);
        expect(decoded._tag).toBe("Success");
      }),
    ["plain.workflow.ts"],
  ));
