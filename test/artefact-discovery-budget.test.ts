import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Path } from "effect";
import * as Arr from "effect/Array";
import { Artefacts } from "../src/artefacts";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

test("bounded discovery does not spend file slots on directories or private metadata", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const run = yield* madeRun(state);
      const catalogue = yield* Artefacts;
      const files = [
        [`${run.dir}/attachments/pdfs/manual.pdf`, "%PDF-1.7"],
        [`${run.dir}/attachments/pictures/shot.png`, "image bytes"],
        [`${run.dir}/plan/issues/01.md`, "# First ticket"],
        [`${run.evidence}/checks/check.log`, "proof"],
        [`${run.dir}/handoffs/nested/note.txt`, "first note"],
        [`${run.dir}/attachments/credentials.json`, "private"],
        [`${run.evidence}/metrics.jsonl`, "private"],
      ];
      for (const [file, content] of files) {
        yield* fs.makeDirectory(path.dirname(file!), { recursive: true });
        yield* fs.writeFileString(file!, content!);
      }
      const first = yield* catalogue.reconcile(run);
      expect(Arr.map(first.items, (item) => item.ref).sort()).toEqual([
        "attachment:pdfs/manual.pdf",
        "attachment:pictures/shot.png",
        "evidence:checks/check.log",
        "handoff:nested/note.txt",
        "plan:issues/01.md",
      ]);
      yield* fs.writeFileString(`${run.dir}/handoffs/nested/note.txt`, "second note");
      const changed = yield* catalogue.reconcile(run);
      const note = Option.getOrThrow(
        Arr.findFirst(changed.items, (item) => item.ref === "handoff:nested/note.txt"),
      );
      expect(note.revision).toBe(2);
      expect(note.id).toBe(
        Option.getOrThrow(
          Arr.findFirst(first.items, (item) => item.ref === "handoff:nested/note.txt"),
        ).id,
      );
    }),
  ));
