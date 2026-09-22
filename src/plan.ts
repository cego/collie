// A plan directory read as repositories and waves: which repo each ticket changes, which
// repo run can start when, and the reasons a plan cannot be fanned out at all
// (CONTEXT.md, Repo run and Wave).

import { Effect, FileSystem, Path } from "effect";

const REPO_LINE = /^\s*\*\*Repo:\*\*\s*(.*?)\s*$/m;
const BLOCKED_LINE = /^\s*\*\*Blocked by:\*\*\s*(.*?)\s*$/m;
const CHECKS_LINE = /^\s*\*\*Checks:\*\*\s*(.*?)\s*$/m;

/**
 * The verification names a ticket's `**Checks:**` line promises, `[]` where it has none
 * or says `None`. Written as names — `tests, typecheck` — or as the commands in backticks;
 * either way what is kept is the name a `collie verify` record carries.
 */
export function checksIn(text: string): string[] {
  const line = CHECKS_LINE.exec(text)?.[1]?.trim() ?? "";
  if (line === "" || /^none\b/i.test(line)) return [];
  return line
    .split(",")
    .map((part) => part.trim().replace(/^`|`$/g, "").trim())
    .filter((part) => part !== "");
}

/**
 * How many tickets a Run wrote. The plan a Run was *given* is somebody else's work, so
 * only its own directory is counted: writing tickets is what leaves a plan to build from.
 */
export const planIssuesIn = Effect.fn("Plan.planIssuesIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(path.join(dir, "plan", "issues"))
    .pipe(Effect.catch(() => Effect.succeed([])));
  return names.filter((name) => name.endsWith(".md")).length;
});

/** One repository the plan changes, and the tickets that change it, in plan order. */
export interface PlanRepo {
  path: string;
  tickets: ReadonlyArray<string>;
}

/** Why this plan cannot be fanned out. The message is what the human is shown. */
export interface PlanRefusal {
  kind:
    | "cycle"
    | "missing-repo"
    | "missing-checkout"
    | "outside-root"
    | "unknown-blocker"
    | "duplicate-ticket";
  message: string;
}

export interface PlanRepos {
  repos: ReadonlyArray<PlanRepo>;
  /** Repo paths in the order their runs may start; each wave waits on the one before. */
  waves: ReadonlyArray<ReadonlyArray<string>>;
  refusal: PlanRefusal | null;
}

/**
 * A ticket's own name in a "Blocked by" line, as one number however it was padded: the
 * skill that writes those lines holds "the numbers of the tickets", and a plan saying
 * `Blocked by: 2` for a file called `02-api.md` means the ticket it obviously means.
 */
function ticketId(raw: string): string {
  const digits = /^0*(\d+)/.exec(raw)?.[1];
  return digits ?? raw;
}

/**
 * The tickets a "Blocked by" line names, `[]` where it names none, and `null` where it
 * says something that is not ticket numbers at all. That third answer is the point: a
 * line nobody can read is a refusal rather than an absence, and deciding it here is what
 * keeps every rule after this from asking again what an empty list meant.
 *
 * A ticket number is a word that is nothing but digits, not any digits anywhere in the
 * line: the prompt lets a planner write `01, before the v2 rollout`, and scraping every
 * run of digits out of that read the `2` in "v2" as a blocker on ticket 02 — an edge no
 * ticket states, ordering two repository runs for a reason nobody can see. "None" is
 * consulted only where no number was named, because `01 (none of the others block it)`
 * names one.
 */
function blockersIn(said: string): ReadonlyArray<string> | null {
  const ids = said
    .split(/[\s,;]+/)
    // Punctuation off the ends, never letters: `(01)` and `01.` name a ticket, and
    // trimming any non-digit instead would turn the `v2` this rule exists for into one.
    .map((word) => word.replaceAll(/^[([{'"]+|[)\]}'".:]+$/g, ""))
    .filter((word) => /^\d+$/.test(word));
  if (ids.length > 0) return ids.map(ticketId);
  return said === "" || /none/i.test(said) ? [] : null;
}

/** A ticket as the reading needs it: what it changes, and what it waits for. */
interface Ticket {
  file: string;
  /** Its own name in a "Blocked by" line: the number its file is prefixed with. */
  id: string;
  /** The `Repo:` line as the ticket wrote it, which is what a refusal quotes back. */
  written: string;
  /** That value as a path under the root, and null where it is not one. */
  repo: string | null;
  /** The "Blocked by" line as the ticket wrote it, for the same reason. */
  blockedText: string;
  blockedBy: ReadonlyArray<string> | null;
}

/** A ticket past the missing-`Repo:` guard, which every rule after it can rely on. */
type Placed = Ticket & { repo: string };

/**
 * The repository a ticket names, as a path under the plan run's root: `.` for the root
 * itself, and otherwise its segments with nothing empty and no `.` among them, so that
 * `cego/api`, `cego/api/` and `./cego/api` are the one repository they mean rather than
 * three entries that would each be given a run.
 *
 * `null` for a value that is not plainly under the root — an absolute path, or one with
 * a `..` in it at all, which is stricter than resolving them because a planner writing
 * these has no reason to. A ticket is prose an agent wrote, and this value becomes the
 * directory a Run is rooted at and a branch is cut in: `../other-project` would have
 * Collie open a merge request in a repository the operator never named.
 */
function repoUnderRoot(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.startsWith("/") || value.startsWith("~")) return null;
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments.length === 0 ? "." : segments.join("/");
}

function refuse(kind: PlanRefusal["kind"], message: string): PlanRepos {
  return { repos: [], waves: [], refusal: { kind, message } };
}

/** Adds a ticket to the list at that key, starting one where there is none yet. */
function indexBy(index: Map<string, string[]>, key: string, file: string): void {
  const files = index.get(key);
  if (files) files.push(file);
  else index.set(key, [file]);
}

/**
 * Whether this plan is one repository and that repository is the run's own root — every
 * ticket saying `.` or saying nothing. Those are the plans a Choice chains exactly as it
 * always did, rooted where the parent is.
 *
 * A plan whose tickets all name the same repository *by path* is not one of them: its
 * repository is somewhere under the root, so it needs a run rooted there with that
 * `repo` — a wave of one. Rooting it at the parent's own directory is the failure the
 * fan-out exists to fix, and a folder of checkouts touching one of them is exactly the
 * shape that produces it.
 */
export function isSingleRepo(plan: PlanRepos): boolean {
  return plan.refusal === null && plan.repos.length === 1 && plan.repos[0]!.path === ".";
}

/**
 * What the fan-out would do with a plan: the tickets' text as they are on disk, and the
 * checkouts that exist under the plan run's root, in — repos, waves and a refusal out.
 *
 * Pure, because every rule in it is a claim about a set of tickets and nothing else: a
 * refusal has to be decidable before anything is started.
 */
export function readPlanRepos(
  tickets: ReadonlyArray<{ file: string; text: string }>,
  checkouts: ReadonlySet<string>,
): PlanRepos {
  const parsed: Ticket[] = tickets.map((ticket) => {
    const written = REPO_LINE.exec(ticket.text)?.[1]?.trim() ?? "";
    const blockedText = BLOCKED_LINE.exec(ticket.text)?.[1]?.trim() ?? "";
    return {
      file: ticket.file,
      id: ticketId(ticket.file),
      written,
      // Normalised the once, here, because everything after this treats it as a path.
      repo: repoUnderRoot(written),
      blockedText,
      blockedBy: blockersIn(blockedText),
    };
  });

  // Said something that is not a path under the root, as against having said nothing:
  // both leave `repo` null, and `written` is what tells the two apart.
  const escaping = parsed.filter((ticket) => ticket.written !== "" && ticket.repo === null);
  if (escaping.length > 0) {
    const named = escaping.map((ticket) => `${ticket.file} (${ticket.written})`);
    return refuse(
      "outside-root",
      `These tickets name a repository that is not under the plan's root: ${named.join(", ")}. ` +
        `A **Repo:** line is a path relative to the root: it cannot be absolute, and it cannot contain "..".`,
    );
  }

  // Two rules about the tickets themselves, before anything about repositories: a number
  // claimed twice and a "Blocked by" line naming something that is not a ticket here are
  // wrong however many repositories the plan spans. They used to be checked only past the
  // single-repository shortcut below, so the same plan was judged one way as one repo and
  // another as two — and the order those lines describe is what a build is sliced along.
  const claiming = new Map<string, string[]>();
  for (const ticket of parsed) indexBy(claiming, ticket.id, ticket.file);
  const twice = [...claiming.values()].filter((files) => files.length > 1);
  if (twice.length > 0) {
    return refuse(
      "duplicate-ticket",
      `These tickets are numbered the same, so a "Blocked by" line cannot say which it means: ${twice
        .map((files) => files.join(" and "))
        .join(", ")}. Number every ticket of a plan once.`,
    );
  }

  const unreadable = parsed.flatMap((ticket) =>
    ticket.blockedBy === null
      ? [`${ticket.file} (blocked by "${ticket.blockedText}")`]
      : ticket.blockedBy
          .filter((id) => !claiming.has(id))
          .map((id) => `${ticket.file} (blocked by ${id})`),
  );
  if (unreadable.length > 0) {
    return refuse(
      "unknown-blocker",
      `These tickets are blocked by something that is not a ticket of this plan: ${unreadable.join(", ")}. ` +
        `A "Blocked by" line names the numbers of the tickets it waits for, or "None".`,
    );
  }

  // Every ticket in one repository, whether it says so or not: today's plans, and the
  // ones written inside a repo, where `.` is the only answer there is.
  if (parsed.every((ticket) => ticket.repo === null || ticket.repo === ".")) {
    return {
      repos: [{ path: ".", tickets: parsed.map((ticket) => ticket.file) }],
      waves: [["."]],
      refusal: null,
    };
  }

  const placed = parsed.filter((ticket): ticket is Placed => ticket.repo !== null);
  if (placed.length < parsed.length) {
    const silent = parsed.filter((ticket) => ticket.repo === null).map((ticket) => ticket.file);
    return refuse(
      "missing-repo",
      `Some tickets name a repository and these do not: ${silent.join(", ")}. Every ticket in a plan that spans repositories needs a **Repo:** line.`,
    );
  }

  // The tickets by repository — in the order the repositories first appear, which a Map
  // keeps — and two answers about their numbers: which repository a number is in, for
  // the blocking edges, and which files claim it, for the two that claim one twice.
  const ticketsOf = new Map<string, string[]>();
  const repoOfId = new Map<string, string>();
  for (const ticket of placed) {
    repoOfId.set(ticket.id, ticket.repo);
    indexBy(ticketsOf, ticket.repo, ticket.file);
  }
  const paths = [...ticketsOf.keys()];

  // Cross-repo blocking edges only: an edge inside a repo orders that run's tickets,
  // which is the implementer's business rather than the fan-out's.
  const blockers = new Map<string, Set<string>>(paths.map((path) => [path, new Set<string>()]));
  const interleaving = new Map<string, string[]>();
  for (const ticket of placed) {
    // Never null past the guard above, which refuses a line it could not read.
    for (const id of ticket.blockedBy ?? []) {
      const from = repoOfId.get(id)!;
      if (from === ticket.repo) continue;
      blockers.get(ticket.repo)!.add(from);
      const named = interleaving.get(ticket.repo) ?? [];
      named.push(`${ticket.file} (blocked by ${from})`);
      interleaving.set(ticket.repo, named);
    }
  }

  const waves: string[][] = [];
  const settled = new Set<string>();
  while (settled.size < paths.length) {
    const left = paths.filter((path) => !settled.has(path));
    const wave = left.filter((path) => [...blockers.get(path)!].every((from) => settled.has(from)));
    if (wave.length === 0) {
      // Only the repositories on the cycle, not everything downstream of it: a repo
      // nothing else waits for is stuck because the cycle is, and telling the planner to
      // move its tickets too would be telling it to move the wrong ones. Trimmed by
      // dropping whatever has no dependent left, until only what waits on itself remains.
      let cyclic = left;
      for (;;) {
        const waited = cyclic.filter((path) =>
          cyclic.some((other) => blockers.get(other)!.has(path)),
        );
        if (waited.length === cyclic.length) break;
        cyclic = waited;
      }
      const interleaved = cyclic.flatMap((path) => interleaving.get(path) ?? []);
      return refuse(
        "cycle",
        `These repositories block each other, so no run can go first: ${cyclic.join(", ")}. ` +
          `The tickets that interleave them: ${interleaved.join(", ")}. ` +
          `Move a repository's tickets so that once it is blocked by another, none of that one's is blocked by it.`,
      );
    }
    for (const path of wave) settled.add(path);
    waves.push(wave);
  }

  const missing = paths.filter((path) => !checkouts.has(path));
  if (missing.length > 0) {
    return refuse(
      "missing-checkout",
      `These repositories are named by a ticket but not checked out under the plan's root: ${missing.join(", ")}. ` +
        `Clone them there and answer again — Collie does not clone.`,
    );
  }

  const repos = [...ticketsOf].map(([path, tickets]) => ({ path, tickets }));
  return { repos, waves, refusal: null };
}

/**
 * The same reading, against a plan directory on disk and the checkouts under the plan
 * run's root. The only I/O the fan-out needs before it decides: the tickets, and whether
 * each repository they name is somewhere to work.
 */
export const planReposOf = Effect.fn("Plan.planReposOf")(function* (planDir: string, root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const issues = path.join(planDir, "issues");
  const files = (yield* fs.readDirectory(issues).pipe(Effect.catch(() => Effect.succeed([]))))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const tickets: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const text = yield* fs
      .readFileString(path.join(issues, file))
      .pipe(Effect.catch(() => Effect.succeed("")));
    tickets.push({ file, text });
  }

  // Through the same normalisation the reading uses, so the probe below asks about the
  // repository the reading will name rather than about the text as it was typed.
  const named = new Set<string>();
  for (const ticket of tickets) {
    const repo = repoUnderRoot(REPO_LINE.exec(ticket.text)?.[1] ?? "");
    if (repo !== null) named.add(repo);
  }
  // A `.git` that is there at all: git writes a directory for a clone and a file for a
  // worktree, and either is a checkout to root a run at.
  const checkouts = new Set<string>();
  for (const repo of named) {
    if (yield* fs.exists(path.join(root, repo, ".git"))) checkouts.add(repo);
  }

  return readPlanRepos(tickets, checkouts);
});

/** One ticket as a build slice needs it: where it is, what it is called, what it waits for. */
export interface Slice {
  file: string;
  /** The number its file is prefixed with, which a "Blocked by" line names it by. */
  number: string;
  title: string;
  blockedBy: ReadonlyArray<string>;
  /** The verification names its `**Checks:**` line promised will prove it. */
  checks: ReadonlyArray<string>;
}

/** The first heading, else the file name without its number — what a hand-off calls it. */
function titleOf(file: string, text: string): string {
  const heading = /^#+\s+(.+?)\s*$/m.exec(text)?.[1];
  if (heading) return heading.replace(/^\d+[\s:.-]+/, "").trim();
  return file
    .replace(/\.md$/, "")
    .replace(/^\d+[-_]?/, "")
    .replaceAll("-", " ");
}

/**
 * The plan's tickets in an order they can actually be built in: `Blocked by` before
 * blocked, and plan order among tickets that do not wait for each other. This is the
 * intra-repository ordering `readPlanRepos` deliberately leaves alone — it orders
 * *repositories*, and says an edge inside one is the implementer's business. Slicing a
 * build is that business.
 *
 * Refuses nothing on its own: `readPlanRepos` has already refused a plan with a cycle, a
 * number claimed twice or an edge pointing at nothing, and a second opinion here that
 * disagreed with it would be worse than none. A cycle that reached this anyway keeps plan
 * order for whatever is left, so a caller still gets every ticket exactly once.
 */
export function orderedTickets(
  tickets: ReadonlyArray<{ file: string; text: string }>,
  repo?: string,
): Slice[] {
  const mine = tickets.filter((ticket) => {
    if (repo === undefined || repo === "") return true;
    const written = repoUnderRoot(REPO_LINE.exec(ticket.text)?.[1] ?? "");
    return written === repo || (written === null && repo === ".");
  });
  const slices: Slice[] = mine.map((ticket) => ({
    file: ticket.file,
    number: ticketId(ticket.file),
    title: titleOf(ticket.file, ticket.text),
    blockedBy: blockersIn(BLOCKED_LINE.exec(ticket.text)?.[1]?.trim() ?? "") ?? [],
    checks: checksIn(ticket.text),
  }));

  const here = new Set(slices.map((slice) => slice.number));
  const done = new Set<string>();
  const out: Slice[] = [];
  let left = slices;
  while (left.length > 0) {
    // Plan order among the ready ones: the planner numbered them for a reason, and two
    // tickets that wait for nothing should build in the order they were written.
    const ready = left.filter((slice) =>
      slice.blockedBy.every((id) => !here.has(id) || done.has(id)),
    );
    // A cycle nothing refused: take what is left in plan order rather than lose it.
    const taking = ready.length > 0 ? ready : left;
    for (const slice of taking) {
      out.push(slice);
      done.add(slice.number);
    }
    left = left.filter((slice) => !done.has(slice.number));
  }
  return out;
}

/** The same, against a plan directory on disk. */
export const orderedTicketsOf = Effect.fn("Plan.orderedTicketsOf")(function* (
  planDir: string,
  repo?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issues = path.join(planDir, "issues");
  const files = (yield* fs.readDirectory(issues).pipe(Effect.catch(() => Effect.succeed([]))))
    .filter((name) => name.endsWith(".md"))
    .sort();
  const tickets: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const text = yield* fs
      .readFileString(path.join(issues, file))
      .pipe(Effect.catch(() => Effect.succeed("")));
    tickets.push({ file, text });
  }
  return orderedTickets(tickets, repo);
});
