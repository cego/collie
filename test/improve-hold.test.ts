import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import * as Arr from "effect/Array";
import { buildBoard } from "../src/board";
import { sectionOf } from "../src/board-model";
import { recordDisposition } from "../src/disposition";
import { declaredByModule } from "../src/engine";
import { readEnv } from "../src/env";
import { offersFrom } from "../src/offers";
import { recordFindingStatus } from "../src/finding-status";
import { leaveFindings } from "../src/output";
import type { ActionFacts } from "../src/sdk";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";
import reviewWorkflow from "../workflows/review.workflow";

const NOW = epochMs("2026-10-30T10:00:00Z");
const MR = "https://gitlab.cego.dk/mk/collie/-/merge_requests/7";
const AT = "2026-10-30T09:30:00Z";

const facts: (owned: boolean) => ActionFacts = (owned) => ({
  outcome: "review",
  succeeded: true,
  branch: "feature",
  mrUrl: MR,
  planIssues: 0,
  disposed: false,
  openFindings: 2,
  diffTarget: "mr:gitlab.cego.dk/mk/collie!7",
  review: { head: "H1", reviewed: "H1", owned },
  claim: null,
});

const reviewed = (owned: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-improve-hold-" });
    const run = yield* madeRun(dir, {
      id: "r-review",
      workflow: "review",
      state: "succeeded",
      branch: "feature",
      mr: MR,
      created: "2026-10-30T09:00:00Z",
      finished: AT,
    });
    yield* leaveFindings(run.dir, [
      { id: "r-review-F1", severity: "major", title: "the guard" },
      { id: "r-review-F2", severity: "minor", title: "the name" },
    ]);
    yield* recordDisposition(run.dir, { at: AT, by: "mk", kind: "merged", ref: MR, note: null });
    const offers = offersFrom(declaredByModule(reviewWorkflow), facts(owned), {
      keepUnavailable: true,
    });
    const build = buildBoard({
      env: readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" }),
      runs: [run],
      registered: [],
      now: NOW,
      offers: () => Effect.succeed(offers),
    });
    return { build, offers, run };
  });

test("an owned review's open findings hold its card out of Finished, and taking Improve is offered", () =>
  runEffect(
    Effect.gen(function* () {
      const { build, offers, run } = yield* reviewed(true);
      const views = yield* build;
      expect(views[0] === undefined ? null : sectionOf(views[0])).toBe("waiting");
      expect(views[0]?.landed).toBe(false);
      expect(
        Arr.findFirst(offers, (one) => one.id === "improve").pipe(
          (found) => found._tag === "Some" && found.value.unavailable,
        ),
      ).toBeNull();
      for (const id of ["r-review-F1", "r-review-F2"]) {
        yield* recordFindingStatus(run.dir, {
          id,
          status: "dismissed",
          reason: "not worth it",
          offer: null,
          run: null,
          by: "mk",
          at: AT,
        });
      }
      const after = yield* build;
      expect(after[0]?.landed).toBe(true);
      expect(after[0] === undefined ? null : sectionOf(after[0])).toBe("finished");
    }),
  ));

test("a review of somebody else's merge request offers no Improve, and its open findings do not hold it", () =>
  runEffect(
    Effect.gen(function* () {
      const { build, offers } = yield* reviewed(false);
      const views = yield* build;
      expect(
        Arr.findFirst(offers, (one) => one.id === "improve").pipe(
          (found) => found._tag === "Some" && found.value.unavailable,
        ),
      ).toBe("Collie never pushes to someone else's branch");
      expect(views[0]?.landed).toBe(true);
      expect(views[0] === undefined ? null : sectionOf(views[0])).toBe("finished");
    }),
  ));
