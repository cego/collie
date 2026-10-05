// A card's drawer in the built app, fed by the scripted host's Run details: plans, specs
// and the review as rendered markdown, the log as it grows, the merge request and the facts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import type { RunDetail, TaskView } from "../../src/board-model";
import { task } from "../../test/support/task";
import type { ScriptedMachine } from "./support/scripted-machine";
import { type App, LOCAL, launch, quit, reads, run, serve, settled } from "./support/app";

/** A page on this machine, so a navigation the rules let through commits at once. */
const asked: Array<string> = [];
const away = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    asked.push(request.url);
    return new Response("<title>away</title>", { headers: { "content-type": "text/html" } });
  },
});

const SPEC = [
  "# The seeder",
  "",
  "| Brand | Seeded |",
  "| --- | --- |",
  "| spilnu | yes |",
  `| ${"brands/".repeat(40)}vinderhuset | no |`,
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
  '<img srcset="https://example.com/srcset.png 1x" alt="a far pixel">',
  "",
  '<div style="position:fixed;inset:0;background:url(https://example.com/style.png)">over all</div>',
  "",
  `<map name="away"><area shape="default" href="${away.url}area"></map>`,
  '<img usemap="#away" alt="a map" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  "",
  "See [the brands ticket](issues/02-brands.md), and [a lost one](issues/99-lost.md).",
].join("\n");

/** Sent cut, so the drawer reads it whole by reference. */
const REVIEW = "## Review\n\nLooks **right**, but see `src/seed.ts:3`.\n\nRead to the end.";

/** A diff longer than a thousand lines, drawn whole. */
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
  review: {
    _tag: "Text",
    text: REVIEW.slice(0, 40),
    truncated: true,
  },
  plan: {
    spec: { _tag: "Text", text: SPEC, truncated: true },
    tickets: [
      { file: "01-loader.md", title: "The loader", done: true },
      { file: "02-brands.md", title: "Brands per environment", done: false },
    ],
  },
  outputs: [
    {
      step: "build",
      where: "agents/build.json",
      state: "recorded",
      text: '{"notes":"Sketched in [Seeding plan](https://claude.ai/artifact/5eed), counts on https://kibana.cego.dk/app/seed, and https://gitlab.cego.dk/mk/collie/-/pipelines/90 ran."}',
    },
  ],
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
      verifications: { pass: 1, fail: 2, unstable: 0, byCollie: 3 },
      slices: { done: 1, total: 2 },
      rework: 1,
      peakContext: { agent: "builder", tokens: 81000 },
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
  verifications: [
    {
      id: "v-unit",
      name: "unit",
      result: "pass",
      expect: "pass",
      exit: 0,
      at: "2026-10-05T10:00:00Z",
      by: "collie",
    },
    {
      id: "v-lint",
      name: "lint",
      result: "fail",
      expect: "pass",
      exit: 1,
      at: "2026-10-05T10:01:00Z",
      by: "collie",
    },
    {
      id: "v-repro",
      name: "regression",
      result: "fail",
      expect: "fail",
      exit: 1,
      at: "2026-10-05T09:00:00Z",
      by: "agent",
    },
  ],
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
  evidence: [
    ...[
      "home.before.png",
      "home.after.png",
      ...SHOTS,
      "demo.webm",
      "lighthouse.html",
      "suite.log",
      "core.bin",
    ].map((name) => ({ name, bytes: 68 })),
  ],
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

/** Enough single shots, beside one before/after pair, to need a second page. */
const SHOTS = Array.from({ length: 14 }, (_, at) => `shot-${String(at + 1).padStart(2, "0")}.png`);
const PNG = {
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
};
const REPORT = [
  // No head of its own, and a header the policy must not be put in.
  "<!doctype html><html><body><header>Lighthouse</header>",
  '<p id="score">Score 97</p>',
  "<script>",
  'document.getElementById("score").textContent += " (scripted)";',
  'document.body.append(" " + document.compatMode);',
  'try { parent.document.title = "pwned"; } catch { document.body.append(" kept out"); }',
  'fetch("https://example.com/").then(() => document.body.append(" fetched"), () => document.body.append(" offline"));',
  "</script></body></html>",
].join("");

const FILES = {
  "r-seed review": REVIEW,
  "r-seed pipeline:https://gitlab.cego.dk/mk/collie/-/pipelines/90": "failed\n",
  "r-seed verification:v-unit": "12 pass",
  "r-seed verification:v-lint":
    "\x1b[31mFAIL\x1b[0m src/seed.ts\n\x1b[32mok\x1b[0m src/load.ts\nfound 1 problem",
  "r-seed verification:v-repro": "the bug, reproduced",
  ...Object.fromEntries(
    ["home.before.png", "home.after.png", ...SHOTS].map((name) => [`r-seed evidence:${name}`, PNG]),
  ),
  "r-seed evidence:demo.webm": { base64: "GkXfowEAAAAAAAAf" },
  "r-seed evidence:lighthouse.html": REPORT,
  "r-seed evidence:suite.log":
    "\x1b[1mRUN\x1b[0m suite\n\x1b[32mPASS\x1b[0m seeds\n\x1b[31mFAIL\x1b[0m staging",
  "r-seed diff:src/seed.ts": SEED_PATCH,
  "r-seed diff:gen/big.ts": BIG_PATCH,
  "r-seed diff:docs/notes/a.md": "@@ -1 +0,0 @@\n-A note.",
  "r-seed file:README.md": README,
  "r-seed file:src/seed.ts": Array.from({ length: 40 }, (_, at) => `// seed line ${at + 1}`).join(
    "\n",
  ),
  "r-seed plan:issues/01-loader.md":
    "# The loader\n\nReads every brand. Then [the spec](../SPEC.md).",
  "r-seed plan:issues/02-brands.md": [
    "# Brands per environment",
    "One row per brand.",
    '<div class="fixed inset-0 z-50">a cover</div>',
    '<button popovertarget="lid">Lift the lid</button>',
    '<div id="lid" popover class="fixed inset-0">a lid</div>',
    '<button commandfor="held" command="show-modal">Hold the window</button>',
    '<dialog id="held" closedby="none">held</dialog>',
  ].join("\n\n"),
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
  files: NonNullable<ScriptedMachine["files"]> = FILES,
) =>
  serve(board(), "pc", [SEEDING], undefined, {
    details: { "r-seed": detail(tail, seedAdded) },
    files,
  });

beforeAll(
  () =>
    run(
      Effect.gen(function* () {
        app = yield* launch(
          [],
          (flock) =>
            serve(`${flock}/${LOCAL}`, "pc", [SEEDING], undefined, {
              details: { "r-seed": detail(LOG) },
              files: FILES,
            }),
          true,
        );
      }),
    ),
  120_000,
);

afterAll(() => run(quit(app)).then(() => away.stop()));

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
        // The rest of a cut spec is not on the scripted host, so the drawer says it is cut.
        yield* reads(
          plan.getByTestId("cut").first(),
          "This is cut short, and the rest could not be read.",
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
        yield* reads(review.getByText("Read to the end."), "Read to the end.");
        expect(yield* Effect.promise(() => review.getByTestId("cut").count())).toBe(0);
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

const evidence = () => drawer().getByTestId("evidence");

test(
  "verifications are a checklist with the failures open, in their terminal colours",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const checks = evidence().getByTestId("verifications");
        // The one that did not do what it was expected to comes first, already open.
        yield* reads(
          checks.getByTestId("evidence-text-open").first().locator("span.flex-1"),
          "lint",
        );
        const verdictOf = (name: string) =>
          Effect.promise(() =>
            checks
              .getByTestId(`check-${name}`)
              .locator("[data-verdict]")
              .getAttribute("data-verdict"),
          );
        expect(yield* verdictOf("lint")).toBe("failed");
        // Expected to fail, and it did: what it was meant to show.
        expect(yield* verdictOf("regression")).toBe("met");
        const lint = checks.getByTestId("check-lint");
        const fail = lint.locator("[data-testid='ansi-lines'] span", { hasText: "FAIL" });
        expect(
          yield* Effect.promise(() => fail.evaluate((span) => getComputedStyle(span).color)),
        ).toBe("rgb(207, 34, 46)");
        expect(
          yield* Effect.promise(() =>
            checks.getByTestId("check-unit").getByTestId("ansi-lines").count(),
          ),
        ).toBe(0);
        expect(
          yield* Effect.promise(() =>
            checks.getByTestId("check-regression").getByTestId("ansi-lines").count(),
          ),
        ).toBe(0);
        yield* Effect.promise(() =>
          checks.getByTestId("check-unit").getByTestId("evidence-text-open").click(),
        );
        yield* reads(checks.getByTestId("check-unit").getByTestId("ansi-lines"), "12 pass");
      }),
    ),
  30_000,
);

test(
  "a suite log is read by reference and searched",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const log = evidence().getByTestId("file-suite.log");
        yield* Effect.promise(() => log.getByTestId("evidence-text-open").click());
        yield* reads(log.getByTestId("ansi-lines"), "RUN suite\nPASS seeds\nFAIL staging");
        yield* Effect.promise(() => log.getByTestId("ansi-search").fill("fail"));
        yield* reads(log.getByTestId("ansi-lines"), "FAIL staging");
        expect(
          yield* Effect.promise(() => evidence().getByTestId("files").textContent()),
        ).toContain("core.bin");
      }),
    ),
  30_000,
);

test(
  "screenshots are a gallery, a before beside its after, paged when there are many",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const gallery = evidence().getByTestId("gallery");
        const pair = gallery.getByTestId("pair-home.png");
        const [before, after] = yield* Effect.all([
          settled("the before shot", () =>
            pair
              .getByTestId("image-home.before.png")
              .locator("img")
              .boundingBox({ timeout: 1000 })
              .then((box) => box ?? undefined),
          ),
          settled("the after shot", () =>
            pair
              .getByTestId("image-home.after.png")
              .locator("img")
              .boundingBox({ timeout: 1000 })
              .then((box) => box ?? undefined),
          ),
        ]);
        expect(after.x).toBeGreaterThan(before.x);
        expect(Math.abs(after.y - before.y)).toBeLessThan(2);
        const loaded = yield* Effect.promise(() =>
          pair
            .locator("img")
            .first()
            .evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth)),
        );
        expect(loaded).toBe(1);
        expect(yield* Effect.promise(() => gallery.locator("figure").count())).toBe(12 + 1);
        yield* Effect.promise(() =>
          gallery.getByTestId("gallery-pages").getByRole("button", { name: "2" }).click(),
        );
        yield* settled("the second page", () =>
          gallery
            .locator("figure")
            .count()
            .then((n) => (n === 3 ? n : undefined)),
        );
        yield* reads(gallery.locator("figcaption").last(), "shot-14.png");
      }),
    ),
  30_000,
);

test(
  "a video plays inline, and an HTML report runs sandboxed, kept from Desktop and the network",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const player = evidence().getByTestId("video-demo.webm");
        expect(yield* Effect.promise(() => player.locator("video").count())).toBe(0);
        yield* Effect.promise(() => player.getByTestId("video-play").click());
        const video = player.locator("video");
        yield* settled("the video", () =>
          video
            .getAttribute("src", { timeout: 1000 })
            .then((src) => src?.startsWith("blob:") || undefined),
        );
        expect(yield* Effect.promise(() => video.getAttribute("controls"))).not.toBeNull();
        const report = evidence().getByTestId("report-lighthouse.html");
        yield* Effect.promise(() => report.getByTestId("report-open").click());
        const frame = report.locator("iframe");
        yield* settled("the report", () => frame.isVisible().then((seen) => seen || undefined));
        expect(yield* Effect.promise(() => frame.getAttribute("sandbox"))).toBe("allow-scripts");
        const inside = report.frameLocator("iframe").locator("body");
        yield* settled("the report's own script", () =>
          inside
            .innerText({ timeout: 1000 })
            .then((text) =>
              ["Score 97 (scripted)", "CSS1Compat", "kept out", "offline"].every((part) =>
                text.includes(part),
              )
                ? text
                : undefined,
            ),
        );
        expect(yield* Effect.promise(() => inside.innerText())).not.toContain("fetched");
        expect(yield* Effect.promise(() => app!.page.title())).not.toBe("pwned");
      }),
    ),
  30_000,
);

test(
  "a Run's metrics are a table",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const metrics = evidence().getByTestId("metrics");
        yield* reads(
          metrics.getByTestId("metric-Verifications"),
          "1 pass · 2 fail · 0 unstable · 3 by Collie",
        );
        yield* reads(metrics.getByTestId("metric-Slices"), "1 of 2");
        yield* reads(metrics.getByTestId("metric-Peak context"), "81000 tokens (builder)");
      }),
    ),
  30_000,
);

test(
  "a Run's links are cards that open in the default browser, as an app window where it has one",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        const links = evidence().getByTestId("links");
        yield* reads(links.getByTestId("link-artifact").getByTestId("link-title"), "Seeding plan");
        yield* reads(links.getByTestId("link-mr").getByTestId("link-status"), "opened");
        const pipeline = (title: string) =>
          links.getByTestId("link-pipeline").filter({ hasText: title }).getByTestId("link-status");
        yield* reads(pipeline("Pipeline of !151"), "success");
        yield* reads(pipeline("Pipeline #90"), "failed");
        const asked = (what: string) =>
          settled(what, () =>
            Bun.file(`${app!.flock}/opened.log`)
              .text()
              .catch(() => "")
              .then((log) => log.split("\n").includes(what) || undefined),
          );
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${app!.flock}/browser`, "firefox.desktop\n");
        yield* Effect.promise(() => links.getByTestId("link-artifact").click());
        yield* asked("https://claude.ai/artifact/5eed");

        const applications = `${app!.flock}/share/applications`;
        yield* fs.makeDirectory(applications, { recursive: true });
        yield* fs.writeFileString(
          `${applications}/brave-browser.desktop`,
          `[Desktop Entry]\nName=Brave\nExec=${app!.flock}/browsers/brave %U\n`,
        );
        yield* fs.writeFileString(`${app!.flock}/browser`, "brave-browser.desktop\n");
        yield* Effect.promise(() =>
          links.getByTestId("link-link").filter({ hasText: "kibana" }).click(),
        );
        yield* asked("brave --app=https://kibana.cego.dk/app/seed");
      }),
    ),
  30_000,
);

/** What the view's policy refused from now on, by directive and address. */
const watchRefusals = () =>
  app!.page.evaluate(() => {
    document.body.dataset.refused = "";
    document.addEventListener("securitypolicyviolation", (event) => {
      document.body.dataset.refused += `${event.effectiveDirective} ${event.blockedURI}\n`;
    });
  });
const refusals = () =>
  app!.page.evaluate(() => (document.body.dataset.refused ?? "").split("\n").filter(Boolean));

test(
  "agent markdown fetches nothing from the network, and lays nothing over the window",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Facts").click());
        yield* Effect.promise(watchRefusals);
        yield* Effect.promise(() => tab("Plan").click());
        const plan = drawer().getByTestId("plan");
        yield* reads(plan.getByText("over all"), "over all");
        expect(
          yield* Effect.promise(() => plan.getByText("over all").getAttribute("style")),
        ).toBeNull();
        expect(
          yield* Effect.promise(() => plan.locator("[style*='fixed'], [style*='url(']").count()),
        ).toBe(0);
        // Positioned by a class of the view's own, and still kept inside its markdown.
        yield* Effect.promise(() =>
          plan.getByRole("button", { name: "Brands per environment" }).click(),
        );
        const ticket = plan.getByTestId("ticket-02-brands.md");
        yield* reads(ticket.getByText("a cover"), "a cover");
        const cover = yield* Effect.promise(() => ticket.getByText("a cover").boundingBox());
        const markdown = yield* Effect.promise(() => ticket.getByTestId("markdown").boundingBox());
        expect(cover!.width).toBeLessThanOrEqual(markdown!.width);
        expect(cover!.y).toBeGreaterThanOrEqual(markdown!.y);
        // A popover or a modal dialog would be drawn above every box, so markdown opens neither.
        // Dispatched, since the cover above lies over them.
        yield* Effect.promise(() => ticket.getByText("Lift the lid").dispatchEvent("click"));
        yield* Effect.promise(() => ticket.getByText("Hold the window").dispatchEvent("click"));
        expect(
          yield* Effect.promise(() =>
            ticket.locator("[popover], [popovertarget], [command], [commandfor], dialog").count(),
          ),
        ).toBe(0);
        expect(
          yield* Effect.promise(() =>
            app!.page.evaluate(() => document.querySelector(":popover-open, :modal")),
          ),
        ).toBeNull();
        // The end of a wide row can be scrolled to, rather than being cut off by the box.
        const spec = plan.getByTestId("markdown").first();
        const end = spec.locator("tr", { hasText: "vinderhuset" }).locator("td").last();
        yield* Effect.promise(() => end.scrollIntoViewIfNeeded());
        const [cell, box] = yield* Effect.promise(() =>
          Promise.all([end.boundingBox(), spec.boundingBox()]),
        );
        expect(cell!.x + cell!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
        const refused = yield* settled("the far pixel refused", () =>
          refusals().then((seen) =>
            seen.some((one) => one.startsWith("img-src https://example.com/srcset"))
              ? seen
              : undefined,
          ),
        );
        const fetched = yield* Effect.promise(() =>
          app!.page.evaluate(() =>
            window.performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((name) => name.startsWith("http")),
          ),
        );
        // Chromium lists a refused load among its resources too, so each must be a refusal.
        const blocked = new Set(refused.map((one) => one.split(" ")[1]));
        expect(fetched.filter((name) => !blocked.has(name))).toEqual([]);
      }),
    ),
  30_000,
);

test(
  "a report cannot navigate its own frame away",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Evidence").click());
        yield* Effect.promise(watchRefusals);
        const report = evidence().getByTestId("report-lighthouse.html");
        if (!(yield* Effect.promise(() => report.locator("iframe").isVisible())))
          yield* Effect.promise(() => report.getByTestId("report-open").click());
        yield* Effect.promise(() =>
          report
            .frameLocator("iframe")
            .locator("body")
            .evaluate(() => void (location.href = "https://example.com/leak")),
        );
        yield* settled("the navigation refused", () =>
          refusals().then(
            (seen) =>
              seen.some((one) => one.startsWith("frame-src https://example.com")) || undefined,
          ),
        );
      }),
    ),
  30_000,
);

test(
  "a file:line in markdown jumps to that line",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Review").click());
        yield* Effect.promise(() =>
          drawer().getByTestId("review").getByTestId("markdown").getByTestId("file-ref").click(),
        );
        yield* reads(seed().locator("[data-target]").locator("td").last(), "and again */");
      }),
    ),
  30_000,
);

// Last: were it to leave, the window would no longer be Desktop's.
test(
  "nothing in agent markdown navigates Desktop's window",
  () =>
    run(
      Effect.gen(function* () {
        yield* opened;
        yield* Effect.promise(() => tab("Plan").click());
        const map = drawer().getByTestId("plan").getByAltText("a map");
        yield* Effect.promise(() => map.scrollIntoViewIfNeeded());
        // A blocked navigation never commits, which a click would otherwise wait for.
        yield* Effect.promise(() => map.click({ noWaitAfter: true }));
        // A navigation let through reaches the local page well inside this.
        yield* Effect.promise(() => app!.page.waitForTimeout(1000));
        expect({ url: app!.page.url(), asked }).toEqual({
          url: expect.stringMatching(/^views:\/\//),
          asked: [],
        });
        expect(yield* Effect.promise(() => drawer().isVisible())).toBe(true);
      }),
    ),
  30_000,
);
