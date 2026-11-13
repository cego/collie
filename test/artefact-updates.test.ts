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

test("metadata updates keep snapshot bytes and tracking even after the source changes or disappears", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const catalogue = yield* Artefacts;
      const run = yield* madeRun(rig.stateDir);
      for (const external of [false, true]) {
        const path = `${rig.stateDir}/${external ? "export" : "plain"}.md`;
        yield* fs.writeFileString(path, "# Kept snapshot\n");
        const first = yield* catalogue.register(
          run,
          "inst",
          { path, snapshot: true, url: external ? "https://example.com/report" : undefined },
          `first-${external}`,
          actor,
        );
        yield* fs.writeFileString(path, "# Changed source\n");
        const renamed = yield* catalogue.register(
          run,
          "inst",
          { id: first.item.id, title: "Readable snapshot" },
          `rename-${external}`,
          actor,
        );
        expect(renamed.item).toMatchObject({
          digest: first.item.digest,
          revision: 1,
          tracking: "snapshot",
          created: first.item.created,
          updated: first.item.updated,
        });
        expect(
          Buffer.from(
            (yield* catalogue.read(run, first.item.id, 1, 0)).content,
            "base64",
          ).toString(),
        ).toBe("# Kept snapshot\n");
        yield* fs.remove(path);
        const described = yield* catalogue.register(
          run,
          "inst",
          { id: first.item.id, description: "Retained even without its source" },
          `describe-${external}`,
          actor,
        );
        expect(described.item).toMatchObject({
          revision: 1,
          tracking: "snapshot",
          digest: first.item.digest,
        });
        const replacement = `${path}.replacement.md`;
        yield* fs.writeFileString(replacement, "# Explicit replacement\n");
        const retargeted = yield* catalogue.register(
          run,
          "inst",
          { id: first.item.id, path: replacement, snapshot: false },
          `retarget-${external}`,
          actor,
        );
        expect(retargeted.item).toMatchObject({ revision: 2, tracking: "local" });
        expect(
          Buffer.from(
            (yield* catalogue.read(run, first.item.id, 2, 0)).content,
            "base64",
          ).toString(),
        ).toBe("# Explicit replacement\n");
      }
    }),
  ));

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
