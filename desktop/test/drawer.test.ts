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
  "![a pixel](https://example.com/pixel.png)",
  "",
  "See [the brands ticket](issues/02-brands.md), and [a lost one](issues/99-lost.md).",
].join("\n");

/** Over a thousand, every one of which is drawn. */
const BIG_LINES = 1200;

const LOG = ["starting", "loading brands", "seeded spilnu"];

const detail = (tail: ReadonlyArray<string>, seedAdded = 2): RunDetail => ({
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
      line: 3,
      detail: null,
    },
    {
      severity: "minor",
      title: "The readme says nothing of staging",
      file: "README.md",
      line: 40,
      detail: null,
    },
    {
      severity: "minor",
      title: "An unchanged line still says once",
      file: "src/seed.ts",
      line: 30,
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
  diff: {
    base: "abc1234def",
    live: true,
    files: [
      { path: "src/seed.ts", status: "modified", added: seedAdded, removed: 1 },
      { path: "gen/big.ts", status: "added", added: BIG_LINES, removed: 0 },
      { path: "docs/notes/a.md", status: "deleted", added: 0, removed: 1 },
    ],
  },
});

const SEED_PATCH = [
  "diff --git a/src/seed.ts b/src/seed.ts",
  "--- a/src/seed.ts",
  "+++ b/src/seed.ts",
  "@@ -1,3 +1,4 @@",
  " /* every brand,",
  "-   once */",
  "+   once,",
  "+   and again */",
  " const seeded = true;",
].join("\n");

const BIG_PATCH = [
  "diff --git a/gen/big.ts b/gen/big.ts",
  "--- /dev/null",
  "+++ b/gen/big.ts",
  `@@ -0,0 +1,${BIG_LINES} @@`,
  ...Array.from({ length: BIG_LINES }, (_, at) => `+const line${at + 1} = ${at + 1};`),
].join("\n");

const README = Array.from({ length: 60 }, (_, at) => `Line ${at + 1} of the readme.`).join("\n");

const FILES = {
  "r-seed diff:src/seed.ts": SEED_PATCH,
  "r-seed diff:gen/big.ts": BIG_PATCH,
  "r-seed diff:docs/notes/a.md": "@@ -1 +0,0 @@\n-A note.",
  "r-seed file:README.md": README,
  "r-seed file:src/seed.ts": Array.from({ length: 40 }, (_, at) => `// seed line ${at + 1}`).join(
    "\n",
  ),
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
const served = (
  tail: ReadonlyArray<string>,
  seedAdded = 2,
  files: Record<string, string> = FILES,
) =>
  serve(board(), "pc", [SEEDING], undefined, {
    details: { "r-seed": detail(tail, seedAdded) },
    files,
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
  "a drawer opens on its plan",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* settled("the plan, unasked", () =>
          drawer()
            .getByTestId("plan")
            .isVisible()
            .then((seen) => seen || undefined),
        );
      }),
    ),
  30_000,
);

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
        expect(yield* Effect.promise(() => plan.locator("img[src^='http']").count())).toBe(0);
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
        yield* Effect.promise(() => plan.getByRole("link", { name: "a lost one" }).first().click());
        yield* reads(file.getByTestId("unread"), "issues/99-lost.md could not be read.");
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
        yield* reads(
          review.getByTestId("findings").getByTestId("finding-location").first(),
          "src/seed.ts:3",
        );
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

const diffOf = () => drawer().getByTestId("diff");
const seed = () => diffOf().getByTestId("diff-src/seed.ts");
const colourOf = (side: string, text: string) =>
  Effect.promise(() =>
    seed()
      .locator(`[data-side="${side}"] span`, { hasText: text })
      .first()
      .evaluate((span) => getComputedStyle(span).color),
  );

test(
  "the diff lists every changed file as a tree, and opening one fetches it",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Diff").click());
        const tree = diffOf().getByTestId("diff-tree");
        for (const name of ["src", "seed.ts", "gen", "big.ts", "docs", "notes", "a.md"])
          yield* reads(tree.getByText(name, { exact: true }), name);
        yield* Effect.promise(() => tree.getByText("a.md", { exact: true }).click());
        yield* reads(
          diffOf().getByTestId("diff-docs/notes/a.md").locator("[data-old-line='1'] td").last(),
          "A note.",
        );
      }),
    ),
  30_000,
);

test(
  "unified and side by side both colour a comment across every line it spans",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Diff").click());
        const comment = yield* colourOf("unified", "/* every brand,");
        expect(yield* colourOf("unified", "and again */")).toBe(comment);
        expect(yield* colourOf("unified", "const")).not.toBe(comment);
        yield* Effect.promise(() => diffOf().getByTestId("split").click());
        const row = seed().locator("tr", { has: app!.page.getByText("once */") });
        yield* reads(row.locator('[data-side="new"]'), "once,");
        expect(yield* colourOf("new", "and again */")).toBe(comment);
        expect(yield* colourOf("old", "once */")).toBe(comment);
        yield* Effect.promise(() => diffOf().getByTestId("split").click());
      }),
    ),
  30_000,
);

test(
  "a big file starts collapsed, and opened shows every line",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Diff").click());
        const big = diffOf().getByTestId("diff-gen/big.ts");
        yield* settled("the big file's header", () =>
          big.isVisible().then((seen) => seen || undefined),
        );
        expect(yield* Effect.promise(() => big.getByTestId("diff-lines").count())).toBe(0);
        yield* Effect.promise(() => big.getByTestId("diff-file-header").click());
        yield* reads(
          big.locator(`[data-new-line='${BIG_LINES}'] td`).last(),
          `const line${BIG_LINES} = ${BIG_LINES};`,
        );
        expect(yield* Effect.promise(() => big.locator("[data-new-line]").count())).toBe(BIG_LINES);
      }),
    ),
  30_000,
);

test(
  "a finding jumps to its line in the diff, or to the file read-only when it is not in it",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Review").click());
        const locations = drawer().getByTestId("finding-location");
        yield* Effect.promise(() => locations.first().click());
        const line = seed().locator("[data-target]");
        yield* reads(line.locator("td").last(), "and again */");
        yield* settled("the line in view", () =>
          line.isVisible().then((seen) => seen || undefined),
        );
        yield* Effect.promise(() => tab("Review").click());
        yield* Effect.promise(() => locations.nth(1).click());
        const source = diffOf().getByTestId("source-file");
        yield* reads(source.getByTestId("source-file-name"), "README.md");
        const target = source.locator("[data-target]");
        yield* reads(target.locator("td").last(), "Line 40 of the readme.");
        const inView = yield* Effect.promise(() =>
          target.evaluate((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
          }),
        );
        expect(inView).toBe(true);
        // A line of a changed file that no hunk shows is read from the checkout.
        yield* Effect.promise(() => tab("Review").click());
        yield* Effect.promise(() => locations.nth(2).click());
        yield* reads(source.getByTestId("source-file-name"), "src/seed.ts");
        yield* reads(source.locator("[data-target] td").last(), "// seed line 30");
      }),
    ),
  30_000,
);

test(
  "an open file follows the Run, and the Diff tab keeps its view across tabs",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Diff").click());
        yield* Effect.promise(() => diffOf().getByTestId("split").click());
        yield* Effect.promise(() => tab("Log").click());
        yield* Effect.promise(() => tab("Diff").click());
        yield* reads(seed().locator('[data-new-line="3"] [data-side="new"]'), "and again */");
        yield* served(LOG, 3, {
          ...FILES,
          "r-seed diff:src/seed.ts": `${SEED_PATCH}\n+const more = true;`,
        });
        yield* reads(seed().locator('[data-new-line="5"] [data-side="new"]'), "const more = true;");
        yield* served(LOG);
        yield* Effect.promise(() => diffOf().getByTestId("split").click());
      }),
    ),
  30_000,
);
