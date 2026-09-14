// Reading a plan directory as repositories and waves. Pure: the tickets' text and the
// checkouts that exist go in, what the fan-out would do comes out, so every rule and
// every refusal is one small case.

import { expect, test } from "bun:test";
import { checksIn, isSingleRepo, orderedTickets, readPlanRepos } from "../src/plan";

function ticket(file: string, opts: { repo?: string; blockedBy?: string } = {}) {
  const repo = opts.repo === undefined ? "" : `**Repo:** ${opts.repo}\n\n`;
  return {
    file,
    text: `# ${file}\n\n**What to build:** something.\n\n**Blocked by:** ${
      opts.blockedBy ?? "None (can start immediately)"
    }\n\n${repo}**Status:** ready-for-agent\n`,
  };
}

test("a plan whose tickets all say `.`, or say nothing, is single-repo", () => {
  for (const tickets of [
    [ticket("01-a", { repo: "." }), ticket("02-b", { repo: "." })],
    [ticket("01-a"), ticket("02-b")],
  ]) {
    const plan = readPlanRepos(tickets, new Set());
    expect(plan.refusal).toBeNull();
    expect(plan.repos).toEqual([{ path: ".", tickets: ["01-a", "02-b"] }]);
    expect(plan.waves).toEqual([["."]]);
  }
});

test("tickets group by the repository they name, in the order they first appear", () => {
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01" }),
      ticket("03-api", { repo: "cego/api" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal).toBeNull();
  expect(plan.repos).toEqual([
    { path: "cego/api", tickets: ["01-api", "03-api"] },
    { path: "cego/web", tickets: ["02-web"] },
  ]);
});

test("a wave is every repository whose tickets are blocked by no other repository's", () => {
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-client", { repo: "cego/client", blockedBy: "01" }),
      ticket("03-web", { repo: "cego/web", blockedBy: "02" }),
      ticket("04-docs", { repo: "cego/docs" }),
    ],
    new Set(["cego/api", "cego/client", "cego/web", "cego/docs"]),
  );

  expect(plan.refusal).toBeNull();
  expect(plan.waves).toEqual([["cego/api", "cego/docs"], ["cego/client"], ["cego/web"]]);
});

test("repositories that block each other are refused, naming the cycle and its tickets", () => {
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01" }),
      ticket("03-api", { repo: "cego/api", blockedBy: "02" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal?.kind).toBe("cycle");
  expect(plan.refusal?.message).toContain("cego/api");
  expect(plan.refusal?.message).toContain("cego/web");
  // The tickets that interleave, so the planner knows which ones to move.
  expect(plan.refusal?.message).toContain("03-api");
  expect(plan.waves).toEqual([]);
});

test("the cycle refusal names the repositories on the cycle and no others", () => {
  // `docs` blocks nothing and is stuck only because the cycle is: telling the planner to
  // move its tickets too would be telling it to move the wrong ones.
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01" }),
      ticket("03-api", { repo: "cego/api", blockedBy: "02" }),
      ticket("04-docs", { repo: "cego/docs", blockedBy: "01" }),
    ],
    new Set(["cego/api", "cego/web", "cego/docs"]),
  );

  expect(plan.refusal?.kind).toBe("cycle");
  expect(plan.refusal?.message).toContain("cego/api");
  expect(plan.refusal?.message).toContain("cego/web");
  expect(plan.refusal?.message).not.toContain("cego/docs");
});

test("a ticket with no Repo: line where others have one is refused, naming it", () => {
  const plan = readPlanRepos(
    [ticket("01-api", { repo: "cego/api" }), ticket("02-web")],
    new Set(["cego/api"]),
  );

  expect(plan.refusal?.kind).toBe("missing-repo");
  expect(plan.refusal?.message).toContain("02-web");
});

test("a repository with no checkout under the root is refused, naming the path", () => {
  const plan = readPlanRepos(
    [ticket("01-api", { repo: "cego/api" }), ticket("02-web", { repo: "cego/web" })],
    new Set(["cego/api"]),
  );

  expect(plan.refusal?.kind).toBe("missing-checkout");
  expect(plan.refusal?.message).toContain("cego/web");
  expect(plan.refusal?.message).not.toContain("cego/api");
});

test("two spellings of one repository are one repository", () => {
  // `Repo:` is prose an agent wrote, so the same checkout arrives spelled several ways.
  // Two entries would each be given a run in one wave, against one checkout.
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-api", { repo: "cego/api/" }),
      ticket("03-api", { repo: "./cego/api" }),
      ticket("04-web", { repo: "cego/web", blockedBy: "01" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal).toBeNull();
  expect(plan.repos).toEqual([
    { path: "cego/api", tickets: ["01-api", "02-api", "03-api"] },
    { path: "cego/web", tickets: ["04-web"] },
  ]);
  expect(plan.waves).toEqual([["cego/api"], ["cego/web"]]);
});

test("an unpadded blocker still names the ticket it obviously means", () => {
  // The skill that writes these lines holds "the numbers of the tickets", so a plan
  // saying `2` for a file called `02-web.md` is a plan that means `02`. Dropping the
  // edge would have started both repositories in one wave.
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "1" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal).toBeNull();
  expect(plan.waves).toEqual([["cego/api"], ["cego/web"]]);
});

test("only a word that is nothing but a number is a ticket number", () => {
  // The prompt lets a planner write a number and then prose about it, so the prose is
  // read as prose: the `2` in "v2" is not an edge onto ticket 02.
  const plan = readPlanRepos(
    [
      ticket("01-contract", { repo: "cego/api" }),
      ticket("02-client", { repo: "cego/client", blockedBy: "01" }),
      ticket("03-web", { repo: "cego/web", blockedBy: "01, before the v2 rollout" }),
    ],
    new Set(["cego/api", "cego/client", "cego/web"]),
  );

  expect(plan.refusal).toBeNull();
  // The client and the web repo each wait on the contract and on nothing else.
  expect(plan.waves).toEqual([["cego/api"], ["cego/client", "cego/web"]]);
});

test('a line that names a ticket and then says "none" still names that ticket', () => {
  // "None" is what a line says when it names no ticket, not a word that may not appear
  // in one that does.
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01 (none of the others block it)" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal).toBeNull();
  expect(plan.waves).toEqual([["cego/api"], ["cego/web"]]);
});

test("a blocker that names no ticket of this plan is refused, not dropped", () => {
  // An edge nobody records is the frontend run starting beside the backend run it
  // depends on, and nothing anywhere saying an edge was ignored.
  for (const blockedBy of ["the API contract", "07"]) {
    const plan = readPlanRepos(
      [ticket("01-api", { repo: "cego/api" }), ticket("02-web", { repo: "cego/web", blockedBy })],
      new Set(["cego/api", "cego/web"]),
    );

    expect([blockedBy, plan.refusal?.kind]).toEqual([blockedBy, "unknown-blocker"]);
    expect(plan.refusal?.message).toContain("02-web");
  }

  // A line that names its ticket and then says more about it is not one of those: the
  // edge is recorded, and the rest is prose.
  const annotated = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01 (the API contract)" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );
  expect(annotated.refusal).toBeNull();
  expect(annotated.waves).toEqual([["cego/api"], ["cego/web"]]);
});

test("two tickets numbered the same are refused, naming both", () => {
  // A "Blocked by" line names a number, so two tickets wearing one number cannot say
  // which an edge points at: whichever was read last used to win, and the edge onto the
  // other was quietly lost.
  const plan = readPlanRepos(
    [
      ticket("01-api", { repo: "cego/api" }),
      ticket("01-web", { repo: "cego/web" }),
      ticket("02-web", { repo: "cego/web", blockedBy: "01" }),
    ],
    new Set(["cego/api", "cego/web"]),
  );

  expect(plan.refusal?.kind).toBe("duplicate-ticket");
  expect(plan.refusal?.message).toContain("01-api");
  expect(plan.refusal?.message).toContain("01-web");
  expect(plan.waves).toEqual([]);
});

test("a repository that is not under the plan's root is refused, naming the ticket", () => {
  for (const outside of ["../other-project", "/srv/other", "cego/../../other", "~/other"]) {
    const plan = readPlanRepos(
      [ticket("01-api", { repo: "cego/api" }), ticket("02-out", { repo: outside })],
      // Checked out, so nothing but this rule stops Collie cutting a branch in it.
      new Set(["cego/api", outside]),
    );

    expect([outside, plan.refusal?.kind]).toEqual([outside, "outside-root"]);
    expect(plan.refusal?.message).toContain("02-out");
    expect(plan.refusal?.message).toContain(outside);
  }
});

test("only the run's own root is a single-repo plan", () => {
  // `.` and nothing else: the plans a Choice chains rooted where the parent is.
  expect(isSingleRepo(readPlanRepos([ticket("01-a", { repo: "." })], new Set()))).toBe(true);
  expect(isSingleRepo(readPlanRepos([ticket("01-a")], new Set()))).toBe(true);
  // One repository, but one under the root: it needs a run rooted there, so it is a
  // wave of one rather than an ordinary chain.
  const named = readPlanRepos([ticket("01-api", { repo: "cego/api" })], new Set(["cego/api"]));
  expect(named.repos).toEqual([{ path: "cego/api", tickets: ["01-api"] }]);
  expect(isSingleRepo(named)).toBe(false);
  // And a refusal is never one, whatever it names.
  expect(isSingleRepo(readPlanRepos([ticket("01-api", { repo: "cego/api" })], new Set()))).toBe(
    false,
  );
});

test("a single-repo plan is not asked for a checkout: the chain refuses that as it always did", () => {
  const plan = readPlanRepos([ticket("01-a", { repo: "." })], new Set());
  expect(plan.refusal).toBeNull();
});

test("a number claimed twice is refused however many repositories the plan names", () => {
  const plan = readPlanRepos(
    [
      { file: "01-api.md", text: "**Blocked by:** None\n" },
      { file: "01-web.md", text: "**Blocked by:** None\n" },
    ],
    new Set(["."]),
  );
  // One repository, so this used to take the shortcut below and never be looked at —
  // and a "Blocked by: 01" in the same plan could not have said which it meant.
  expect(plan.refusal?.kind).toBe("duplicate-ticket");
  expect(plan.refusal?.message).toContain("01-api.md and 01-web.md");
});

test("a blocker naming nothing in the plan is refused in a single-repository plan too", () => {
  const dangling = readPlanRepos(
    [
      { file: "01-api.md", text: "**Blocked by:** None\n" },
      { file: "02-web.md", text: "**Blocked by:** 07\n" },
    ],
    new Set(["."]),
  );
  expect(dangling.refusal?.kind).toBe("unknown-blocker");
  expect(dangling.refusal?.message).toContain("02-web.md (blocked by 7)");

  const prose = readPlanRepos(
    [{ file: "01-api.md", text: "**Blocked by:** after the migration\n" }],
    new Set(["."]),
  );
  expect(prose.refusal?.kind).toBe("unknown-blocker");
});

test("an ordinary single-repository plan still needs nothing said about repositories", () => {
  const plan = readPlanRepos(
    [
      { file: "01-api.md", text: "**Blocked by:** None\n" },
      { file: "02-web.md", text: "**Blocked by:** 01\n" },
    ],
    new Set(["."]),
  );
  expect(plan.refusal).toBeNull();
  expect(plan.repos).toEqual([{ path: ".", tickets: ["01-api.md", "02-web.md"] }]);
});

test("tickets build in an order that respects Blocked by, and plan order otherwise", () => {
  const ticket = (file: string, blocked: string, title = "a thing") => ({
    file,
    text: `# ${title}\n\n**Blocked by:** ${blocked}\n**Repo:** .\n`,
  });

  const order = orderedTickets([
    ticket("01-api.md", "None", "the API"),
    ticket("02-web.md", "03", "the web client"),
    ticket("03-schema.md", "01", "the schema"),
    ticket("04-docs.md", "None", "the docs"),
  ]);

  expect(order.map((s) => s.file)).toEqual([
    // 01 and 04 wait for nothing, in plan order; 03 waits for 01; 02 waits for 03.
    "01-api.md",
    "04-docs.md",
    "03-schema.md",
    "02-web.md",
  ]);
  expect(order.map((s) => s.title)).toEqual([
    "the API",
    "the docs",
    "the schema",
    "the web client",
  ]);
  expect(order.map((s) => s.number)).toEqual(["1", "4", "3", "2"]);
  expect(order[2]!.blockedBy).toEqual(["1"]);
});

test("only this repository's tickets are sliced, and every ticket is returned exactly once", () => {
  const tickets = [
    { file: "01-api.md", text: "# API\n\n**Blocked by:** None\n**Repo:** cego/api\n" },
    { file: "02-web.md", text: "# Web\n\n**Blocked by:** 01\n**Repo:** cego/web\n" },
    { file: "03-more.md", text: "# More\n\n**Blocked by:** None\n**Repo:** cego/api\n" },
  ];
  expect(orderedTickets(tickets, "cego/api").map((s) => s.file)).toEqual([
    "01-api.md",
    "03-more.md",
  ]);
  // An edge onto a ticket that is not in this slice's repo does not hold it back: that
  // ordering is the fan-out's, between Runs, and it has already been settled.
  expect(orderedTickets(tickets, "cego/web").map((s) => s.file)).toEqual(["02-web.md"]);
  expect(orderedTickets(tickets).map((s) => s.file)).toHaveLength(3);
});

test("a cycle nothing refused still yields every ticket rather than losing one", () => {
  // `readPlanRepos` refuses this before a build ever gets here; if one did, losing a
  // ticket silently would be worse than building them in the order they were written.
  const order = orderedTickets([
    { file: "01-a.md", text: "# A\n\n**Blocked by:** 02\n" },
    { file: "02-b.md", text: "# B\n\n**Blocked by:** 01\n" },
  ]);
  expect(order.map((s) => s.file)).toEqual(["01-a.md", "02-b.md"]);
});

test("a ticket with no heading is still called something a hand-off can print", () => {
  const order = orderedTickets([{ file: "07-fix-the-picker.md", text: "**Blocked by:** None\n" }]);
  expect(order[0]!.title).toBe("fix the picker");
});

test("a ticket's Checks line names the verifications that will prove it", () => {
  expect(checksIn("# 01\n\n**Checks:** tests, typecheck\n")).toEqual(["tests", "typecheck"]);
  expect(checksIn("**Checks:** `tests`, `docs-install`")).toEqual(["tests", "docs-install"]);
  expect(checksIn("**Checks:** None\n")).toEqual([]);
  expect(checksIn("# 01\n\nno such line\n")).toEqual([]);
  const [slice] = orderedTickets([
    { file: "01-a.md", text: "# 01: a\n\n**Blocked by:** None\n\n**Checks:** tests\n" },
  ]);
  expect(slice!.checks).toEqual(["tests"]);
});
