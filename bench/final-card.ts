// A multi-megabyte card journal whose last final card supplies one timestamp.
import { strict as assert } from "node:assert";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Console, Effect, FileSystem, Schema } from "effect";
import { CardSchema, finishedOnRecord } from "../src/cards";
import { runEffect } from "../test/support/effect";

await runEffect(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-final-card-bench-" });
    const card = {
      id: "card",
      run: "r",
      kind: "slice",
      at: "2026-09-14T10:00:00Z",
      step: "build",
      iteration: 1,
      intent_version: 1,
      revision: { branch: "work", head_sha: "head", fingerprint: "tree", dirty: false },
      changes: { files: [], commits: [] },
      requested: { goal: null, constraints: [] },
      readiness: "verified",
      verifications: Arr.makeBy(128, (n) => ({
        id: `proof-${n}`,
        name: "test",
        result: "pass" as const,
        ref: `verification:proof-${n}-${Str.repeat(120)("x")}`,
      })),
      claims: [],
      missing: [],
      inspect: [],
      links: {},
      drift: [],
      deliveries: [],
      narrative: null,
      aligned: "true",
      cross_run: "none",
      significance: "routine",
    } as const;
    const encode = Schema.encodeEffect(Schema.fromJsonString(CardSchema));
    const slice = yield* encode(card);
    const final = yield* encode({ ...card, kind: "final" });
    yield* fs.makeDirectory(`${dir}/steering`);
    yield* fs.writeFileString(
      `${dir}/steering/cards.jsonl`,
      `${Str.repeat(130)(`${slice}\n`)}${final}\n`,
    );
    let finishes = 0;
    for (let n = 0; n < 40; n++) {
      assert.equal(yield* finishedOnRecord(dir), card.at);
      finishes++;
    }
    assert.equal(finishes, 40);
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ finishes }),
    );
  }),
);
