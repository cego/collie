// A card's drawer in the built app, fed by the scripted host's Run details: plans, specs
// and the review as rendered markdown, the log as it grows, the merge request and the facts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import type { RunDetail, TaskView } from "../../src/board-model";
import { task } from "../../test/support/task";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

const SPEC = [
  "# The seeder",
  "",
  "| Brand | Seeded |",
  "| --- | --- |",
  "| spilnu | yes |",
  "",
  "```ts",
  "const seeded = true;",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  Loader-->Brands",
  "```",
  "",
  "<script>window.pwned = true</script>",
  "",
  '<img src="x" onerror="window.pwned = true">',
  "",
  "[a bad link](javascript:window.pwned=true)",
  "",
  "See [the brands ticket](issues/02-brands.md).",
].join("\n");

const LOG = ["starting", "loading brands", "seeded spilnu"];

const detail = (tail: ReadonlyArray<string>): RunDetail => ({
  id: "r-seed",
  dir: "/state/runs/r-seed",
  title: "Implement · Strapi seeder",
  status: "running",
  inputs: [],
  steps: [],
  handoffs: [],
  intent: { goal: "Seed every brand", constraints: ["no production writes"] },
  review: { _tag: "Text", text: "## Review\n\nLooks **right**.", truncated: false },
  plan: {
    spec: { _tag: "Text", text: SPEC, truncated: false },
    tickets: [
      { file: "01-loader.md", title: "The loader", done: true },
      { file: "02-brands.md", title: "Brands per environment", done: false },
    ],
  },
  outputs: [],
  tail: { _tag: "Text", text: tail.join("\n"), truncated: false },
  attention: { category: "none", reason: "running", explanation: "", actions: [] },
  outcome: {
    kind: null,
    gaps: [],
    obstacle: null,
    next: null,
    delivered: null,
    metrics: {
      timeToFirstEvidence: null,
      verifications: { pass: 0, fail: 0, unstable: 0, byCollie: 0 },
      slices: { done: 0, total: 0 },
      rework: 0,
      peakContext: null,
      halts: [],
      obstacles: [],
    },
  },
  finishedAt: 0,
  mr: {
    _tag: "Details",
    iid: "151",
    project: "mk/collie",
    title: "Seed the brands",
    state: "opened",
    author: "mk",
    assignees: [],
    sourceBranch: "mk/seed",
    targetBranch: "master",
    pipeline: "success",
    approvals: "1 of 2 approvals",
    unresolved: true,
    notes: 3,
    headSha: "abc1234",
    mergedSha: "",
    updatedAt: 0,
    url: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151",
  },
  findings: [
    {
      severity: "major",
      title: "The loader skips a brand",
      file: "src/seed.ts",
      line: 12,
      detail: null,
    },
  ],
  verifications: [],
  steering: [
    {
      id: "c1",
      kind: "slice",
      at: "2026-10-05T10:00:00Z",
      readiness: "inspect-ready",
      significance: "consequential",
      narrative: "Every brand is seeded but staging.",
      missing: ["nobody ran it against staging"],
    },
  ],
  evidence: [],
  diff: null,
});

const FILES = {
  "r-seed plan:issues/01-loader.md":
    "# The loader\n\nReads every brand. Then [the spec](../SPEC.md).",
  "r-seed plan:issues/02-brands.md": "# Brands per environment\n\nOne row per brand.",
};

const SEEDING: TaskView = task({
  id: "t-seed",
  name: "Seed the brands",
  state: "active",
  run: "r-seed",
  runs: ["r-seed"],
});

let app: App | undefined;
const board = () => `${app!.flock}/${LOCAL}`;
const served = (tail: ReadonlyArray<string>) =>
  serve(board(), "pc", [SEEDING], undefined, {
    details: { "r-seed": detail(tail) },
    files: FILES,
  });

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        app = yield* launch([], (flock) =>
          serve(`${flock}/${LOCAL}`, "pc", [SEEDING], undefined, {
            details: { "r-seed": detail(LOG) },
            files: FILES,
          }),
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)));

const drawer = () => app!.page.getByTestId("drawer");
const tab = (name: string) => drawer().getByRole("tab", { name });

const opened = Effect.gen(function* () {
  if (yield* Effect.promise(() => drawer().isVisible())) return;
  yield* Effect.promise(() => app!.page.getByTestId("card-t-seed").getByTestId("name").click());
  yield* settled("the drawer", () =>
    drawer()
      .isVisible()
      .then((seen) => seen || undefined),
  );
});

test(
  "a plan renders its tables, highlighted code and diagrams, with nothing it could run",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Plan").click());
        const plan = drawer().getByTestId("plan");
        yield* settled("the table", () =>
          plan
            .locator("table td", { hasText: "spilnu" })
            .count()
            .then((n) => n || undefined),
        );
        const coloured = yield* settled("highlighted code", () =>
          plan
            .locator("pre span[style*='color']")
            .count()
            .then((n) => n || undefined),
        );
        expect(coloured).toBeGreaterThan(0);
        yield* settled("the diagram", () =>
          plan
            .locator("svg")
            .filter({ hasText: "Loader" })
            .count()
            .then((n) => n || undefined),
        );
        expect(yield* Effect.promise(() => plan.locator("script").count())).toBe(0);
        expect(yield* Effect.promise(() => plan.locator("[onerror]").count())).toBe(0);
        expect(yield* Effect.promise(() => plan.locator("a[href^='javascript']").count())).toBe(0);
        expect(yield* Effect.promise(() => app!.page.evaluate(() => "pwned" in window))).toBe(
          false,
        );
      }),
    ),
  30_000,
);

test(
  "a plan's tickets expand in place, and a link between plan files opens in the drawer",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Plan").click());
        const plan = drawer().getByTestId("plan");
        yield* Effect.promise(() => plan.getByRole("button", { name: "The loader" }).click());
        yield* reads(plan.getByTestId("ticket-01-loader.md").getByRole("heading"), "The loader");
        // The spec's link to the other ticket, and the ticket's link back to the spec.
        yield* Effect.promise(() =>
          plan.getByRole("link", { name: "the brands ticket" }).first().click(),
        );
        const file = plan.getByTestId("plan-file");
        yield* reads(file.getByTestId("plan-file-name"), "issues/02-brands.md");
        yield* reads(file.getByRole("heading"), "Brands per environment");
        yield* Effect.promise(() =>
          plan.getByTestId("ticket-01-loader.md").getByRole("link", { name: "the spec" }).click(),
        );
        yield* reads(file.getByTestId("plan-file-name"), "SPEC.md");
        expect(app!.page.url()).toStartWith("views://");
      }),
    ),
  30_000,
);

test(
  "the review renders, and its findings are a list",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Review").click());
        const review = drawer().getByTestId("review");
        yield* reads(review.getByRole("heading"), "Review");
        yield* reads(review.locator("strong", { hasText: "right" }), "right");
        yield* reads(review.getByTestId("findings").locator("code"), "src/seed.ts:12");
      }),
    ),
  30_000,
);

test(
  "the log follows the Run as it writes, and a search keeps the lines that match",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Log").click());
        const lines = drawer().getByTestId("log-lines");
        yield* reads(lines, LOG.join("\n"));
        yield* served([...LOG, "seeded happytiger"]);
        yield* reads(lines, [...LOG, "seeded happytiger"].join("\n"));
        yield* Effect.promise(() => drawer().getByTestId("log-search").fill("SEEDED"));
        yield* reads(lines, "seeded spilnu\nseeded happytiger");
        yield* served([...LOG, "seeded happytiger", "seeded vinderhuset"]);
        yield* reads(lines, "seeded spilnu\nseeded happytiger\nseeded vinderhuset");
        yield* Effect.promise(() => drawer().getByTestId("log-search").fill(""));
      }),
    ),
  30_000,
);

test(
  "the merge request panel says what GitLab said, and opens the MR in the browser",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Merge request").click());
        const mr = drawer().getByTestId("mr");
        yield* reads(mr.getByTestId("mr-title"), "!151 Seed the brands");
        yield* reads(mr.getByTestId("mr-state"), "opened");
        yield* reads(mr.getByTestId("mr-pipeline"), "success");
        yield* reads(mr.getByTestId("mr-approvals"), "1 of 2 approvals");
        yield* reads(mr.getByTestId("mr-comments"), "3 · a discussion is unresolved");
        yield* Effect.promise(() => mr.getByTestId("mr-open").click());
        const log = yield* settled("the browser asked", () =>
          Bun.file(`${app!.flock}/opened.log`)
            .text()
            .catch(() => "")
            .then((text) => text || undefined),
        );
        expect(log.trim()).toBe("https://gitlab.cego.dk/mk/collie/-/merge_requests/151");
      }),
    ),
  30_000,
);

test(
  "the Facts tab shows the TaskView, the intent and the steering cards",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Facts").click());
        const facts = drawer().getByTestId("facts");
        yield* reads(facts.getByTestId("intent").locator("p"), "Seed every brand");
        yield* reads(facts.getByTestId("intent").locator("li"), "no production writes");
        yield* reads(
          facts.getByTestId("steering-c1").locator("p").first(),
          "Every brand is seeded but staging.",
        );
        const shown = yield* Effect.promise(() => facts.getByTestId("taskview").textContent());
        expect(shown).toContain('"run": "r-seed"');
        expect(shown).toContain('"name": "Seed the brands"');
      }),
    ),
  30_000,
);
