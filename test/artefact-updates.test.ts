import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import * as Arr from "effect/Array";
import { Artefacts } from "../src/artefacts";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun } from "./support/records";

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));
const actor = { origin: "cli", requestId: "update" } as const;

test("renaming discovered material preserves its identity, revision and discovery mapping", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Artefacts;
      const run = yield* madeRun(rig.stateDir);
      for (const root of [
        `${run.dir}/attachments`,
        run.evidence,
        `${run.dir}/handoffs`,
        `${run.dir}/plan`,
      ]) {
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(`${root}/note.md`, "# Original material\n");
      }
      const first = yield* catalogue.reconcile(run);
      expect(first.items).toHaveLength(4);
      for (const item of first.items) {
        const renamed = yield* catalogue.register(
          run,
          "inst",
          { id: item.id, title: "Readable title" },
          item.id,
          actor,
        );
        expect(renamed.item).toMatchObject({
          id: item.id,
          ref: item.ref,
          revision: 1,
          digest: item.digest,
        });
      }
      const after = yield* catalogue.reconcile(run);
      expect(after.items).toHaveLength(4);
      expect(Arr.map(after.items, (item) => item.id).sort()).toEqual(
        Arr.map(first.items, (item) => item.id).sort(),
      );
      for (const item of after.items)
        expect(item).toMatchObject({ title: "Readable title", revision: 1 });
    }),
  ));
