import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Path, Schema } from "effect";
import { decodeBenchmarkPlan } from "./measurement-model";

export const REPO_LINE = /^\s*\*\*Repo:\*\*\s*(.*?)\s*$/m;
const BLOCKED_LINE = /^\s*\*\*Blocked by:\*\*\s*(.*?)\s*$/m;
export const CHANGE_LINE = /^[ \t]*\*\*Change:\*\*[ \t]*(.*?)[ \t]*$/m;
const NEEDS_LINE = /^[ \t]*\*\*Needs merged:\*\*[ \t]*(.*?)[ \t]*$/m;
const CHECKS_LINE = /^\s*\*\*Checks:\*\*\s*(.*?)\s*$/m;
const BENCHMARK_LINE = /^\s*\*\*Benchmark:\*\*\s*(.*?)\s*$/m;

export function benchmarkIn(text: string) {
  const named = Str.trim(BENCHMARK_LINE.exec(text)?.[1] ?? "");
  const returned: string | null = named === "" ? null : named;
  return returned;
}

export const benchmarkFile = (planDir: string, benchmark: string) =>
  `${planDir}/issues/${benchmark}`;

export function checksIn(text: string) {
  const line =
    Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(CHECKS_LINE.exec(text)), (present) =>
        Option.map(Option.fromNullishOr(present[1]), (present_) => Str.trim(present_)),
      ),
    ) ?? "";
  if (line === "" || /^none\b/i.test(line)) {
    const returned: string[] = [];
    return returned;
  }
  const returned: string[] = Arr.filter(
    Arr.map(Str.split(line, ","), (part) =>
      Str.trim(pipe_(Str.trim(part), Str.replace(/^`|`$/g, ""))),
    ),
    (part) => part !== "",
  );
  return returned;
}

const ACCEPTANCE = /^#+\s+acceptance criteria\b/i;
const AFTER_MERGE = /^#+\s+after merge\b/i;
const HEADING = /^#+\s/;
const CHECKBOX = /^[-*]\s+\[[ xX]\]\s+(.*)$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

function sectionOf(lines: ReadonlyArray<string>, heading: RegExp) {
  const at = Option.getOrElse(
    Arr.findFirstIndex(lines, (line) => heading.test(line)),
    () => -1,
  );
  if (at === -1) {
    const returned: ReadonlyArray<string> | null = null;
    return returned;
  }
  const rest = lines.slice(at + 1);
  const end = Option.getOrElse(
    Arr.findFirstIndex(rest, (line) => HEADING.test(line)),
    () => -1,
  );
  const returned: ReadonlyArray<string> | null = end === -1 ? rest : rest.slice(0, end);
  return returned;
}

function itemsIn(lines: ReadonlyArray<string>, item: RegExp) {
  const items: string[][] = [];
  let open: string[] | null = null;
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const found = fenced ? null : item.exec(line);
    if (found) {
      open = [Str.trim(found[1]!)];
      items.push(open);
    } else if (
      !fenced &&
      open !== null &&
      /^\s+\S/.test(line) &&
      !/^\s+([-*+]|\d+[.)])\s/.test(line)
    )
      open.push(Str.trim(line));
    else open = null;
  }
  const returned: string[] = Arr.map(items, (parts) => Arr.join(parts, " "));
  return returned;
}

export function criteriaIn(text: string) {
  const lines = Str.split(text, "\n");
  const section = sectionOf(lines, ACCEPTANCE);
  if (section !== null) {
    const returned: string[] = itemsIn(section, CHECKBOX);
    return returned;
  }
  const afterMerge = sectionOf(lines, AFTER_MERGE);
  if (afterMerge === null) {
    const returned: string[] = itemsIn(lines, CHECKBOX);
    return returned;
  }
  const at = Option.getOrElse(
    Arr.findFirstIndex(lines, (line) => AFTER_MERGE.test(line)),
    () => -1,
  );
  const returned: string[] = itemsIn(
    [...lines.slice(0, at), ...lines.slice(at + 1 + afterMerge.length)],
    CHECKBOX,
  );
  return returned;
}

export function afterMergeIn(text: string) {
  const returned: string[] = itemsIn(
    sectionOf(Str.split(text, "\n"), AFTER_MERGE) ?? [],
    LIST_ITEM,
  );
  return returned;
}

export const planIssuesIn = Effect.fn("Plan.planIssuesIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(path.join(dir, "plan", "issues"))
    .pipe(Effect.orElseSucceed(() => []));
  return Arr.filter(names, (name) => pipe_(name, Str.endsWith(".md"))).length;
});

export interface PlanRepo {
  path: string;
  change?: string;
  stacked?: string;
  tickets: ReadonlyArray<string>;
}

export const changeKey = (one: { readonly path: string; readonly change?: string | undefined }) =>
  one.change ? `${one.path}--${one.change}` : one.path;

export const changeBranch = (plan: string, change: string | undefined) =>
  change ? `${plan}--${change}` : plan;

export const changeOfKey = (repo: string, key: string) =>
  key === repo ? "" : pipe_(key, Str.slice(repo.length + 2));

export function stackedBranch(
  own: string,
  run: { readonly repo: string; readonly change?: string; readonly stacked: string },
) {
  const suffix = changeBranch("", run.change);
  if (!pipe_(own, Str.endsWith(suffix))) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = changeBranch(
    pipe_(own, Str.slice(0, own.length - suffix.length)),
    changeOfKey(run.repo, run.stacked),
  );
  return returned;
}

const changeLineOf: (text: string) => string | null = (text) => CHANGE_LINE.exec(text)?.[1] ?? null;

const refusedInBranch = (name: string) =>
  name === "" ||
  name === "@" ||
  /[\p{Cc} ~^:?*[\\]|\.\.|@\{|\/\/|^[/.]|\/\.|[/.]$|\.lock(\/|$)/u.test(name);

export interface Prerequisite {
  run: string;
  change: string | null;
}

const needsLineOf: (text: string) => string = (text) => NEEDS_LINE.exec(text)?.[1] ?? "";

export const prerequisitesOf = (text: string) => prerequisitesIn(needsLineOf(text));

function prerequisitesIn(said: string) {
  if (said === "" || /^none\.?$/i.test(said)) {
    const returned: ReadonlyArray<Prerequisite> | null = [];
    return returned;
  }
  const entries = Arr.map(Str.split(said, ","), (entry) =>
    Arr.filter(Str.split(Str.trim(entry), /\s+/), (word) => word !== ""),
  );
  const readable = Arr.every(
    entries,
    (words) => words.length === 1 || (words.length === 2 && !refusedInBranch(words[1]!)),
  );
  const returned: ReadonlyArray<Prerequisite> | null = readable
    ? Arr.map(entries, ([run, change]) => ({
        run: run!,
        change: change ?? null,
      }))
    : null;
  return returned;
}

export interface PlanRefusal {
  kind:
    | "cycle"
    | "missing-repo"
    | "missing-checkout"
    | "outside-root"
    | "unknown-blocker"
    | "duplicate-ticket"
    | "bad-change"
    | "bad-prerequisite";
  message: string;
}

export interface PlanRepos {
  repos: ReadonlyArray<PlanRepo>;
  waves: ReadonlyArray<ReadonlyArray<string>>;
  refusal: PlanRefusal | null;
}

function ticketId(raw: string) {
  const digits = /^0*(\d+)/.exec(raw)?.[1];
  const returned: string = digits ?? raw;
  return returned;
}

function blockersIn(said: string) {
  const ids = Arr.filter(
    Arr.map(Str.split(said, /[\s,;]+/), (word) =>
      pipe_(word, Str.replaceAll(/^[([{'"]+|[)\]}'".:]+$/g, "")),
    ),
    (word) => /^\d+$/.test(word),
  );
  if (ids.length > 0) {
    const returned: ReadonlyArray<string> | null = Arr.map(ids, ticketId);
    return returned;
  }
  const returned: ReadonlyArray<string> | null = said === "" || /none/i.test(said) ? [] : null;
  return returned;
}

interface Ticket {
  file: string;
  id: string;
  written: string;
  repo: string | null;
  blockedText: string;
  blockedBy: ReadonlyArray<string> | null;
  change: string | null;
  needsText: string;
}

type Placed = Ticket & { repo: string };

function repoUnderRoot(raw: string) {
  const value = Str.trim(raw);
  if (value === "" || pipe_(value, Str.startsWith("/")) || pipe_(value, Str.startsWith("~"))) {
    const returned: string | null = null;
    return returned;
  }
  const segments = Arr.filter(
    Str.split(value, "/"),
    (segment) => segment !== "" && segment !== ".",
  );
  if (Arr.some(segments, (segment) => segment === "..")) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = segments.length === 0 ? "." : Arr.join(segments, "/");
  return returned;
}

function refuse(kind: PlanRefusal["kind"], message: string) {
  const returned: PlanRepos = { repos: [], waves: [], refusal: { kind, message } };
  return returned;
}

function indexBy(index: Map<string, string[]>, key: string, file: string) {
  const files = index.get(key);
  if (files) files.push(file);
  else index.set(key, [file]);
}

export function isSingleRepo(plan: PlanRepos) {
  const returned: boolean =
    plan.refusal === null && plan.repos.length === 1 && plan.repos[0]!.path === ".";
  return returned;
}

export function readPlanRepos(
  tickets: ReadonlyArray<{ file: string; text: string }>,
  checkouts: ReadonlySet<string>,
) {
  const parsed: Ticket[] = Arr.map(tickets, (ticket) => {
    const written =
      Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(REPO_LINE.exec(ticket.text)), (present__) =>
          Option.map(Option.fromNullishOr(present__[1]), (present___) => Str.trim(present___)),
        ),
      ) ?? "";
    const blockedText =
      Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(BLOCKED_LINE.exec(ticket.text)), (present____) =>
          Option.map(Option.fromNullishOr(present____[1]), (present_____) =>
            Str.trim(present_____),
          ),
        ),
      ) ?? "";
    return {
      file: ticket.file,
      id: ticketId(ticket.file),
      written,
      repo: repoUnderRoot(written),
      blockedText,
      blockedBy: blockersIn(blockedText),
      change: changeLineOf(ticket.text),
      needsText: needsLineOf(ticket.text),
    };
  });

  const escaping = Arr.filter(parsed, (ticket) => ticket.written !== "" && ticket.repo === null);
  if (escaping.length > 0) {
    const named = Arr.map(escaping, (ticket) => `${ticket.file} (${ticket.written})`);
    const outcome: PlanRepos = refuse(
      "outside-root",
      `These tickets name a repository that is not under the plan's root: ${Arr.join(named, ", ")}. ` +
        `A **Repo:** line is a path relative to the root: it cannot be absolute, and it cannot contain "..".`,
    );
    return outcome;
  }

  const badChange = Arr.filter(
    parsed,
    (ticket) => ticket.change !== null && refusedInBranch(ticket.change),
  );
  if (badChange.length > 0) {
    const named = Arr.map(badChange, (ticket) => `${ticket.file} (Change: "${ticket.change}")`);
    const outcome: PlanRepos = refuse(
      "bad-change",
      `These tickets name a Change git will not take as part of a branch name: ${Arr.join(named, ", ")}. ` +
        `A **Change:** name is short and plain, like "schema": no spaces, no "..", and none of ~ ^ : ? * [ \\.`,
    );
    return outcome;
  }

  const badNeeds = Arr.filter(parsed, (ticket) => prerequisitesIn(ticket.needsText) === null);
  if (badNeeds.length > 0) {
    const named = Arr.map(
      badNeeds,
      (ticket) => `${ticket.file} (Needs merged: "${ticket.needsText}")`,
    );
    const outcome: PlanRepos = refuse(
      "bad-prerequisite",
      `These tickets name a Change to wait for that Collie cannot read: ${Arr.join(named, ", ")}. ` +
        `A **Needs merged:** line is Run ids separated by commas, each optionally followed by that Run's Change name, ` +
        `like "run-ac644eef card, run-e15f4a62", or "None".`,
    );
    return outcome;
  }

  const claiming = new Map<string, string[]>();
  for (const ticket of parsed) indexBy(claiming, ticket.id, ticket.file);
  const twice = Arr.filter([...claiming.values()], (files) => files.length > 1);
  if (twice.length > 0) {
    const outcome: PlanRepos = refuse(
      "duplicate-ticket",
      `These tickets are numbered the same, so a "Blocked by" line cannot say which it means: ${Arr.join(
        Arr.map(twice, (files) => Arr.join(files, " and ")),
        ", ",
      )}. Number every ticket of a plan once.`,
    );
    return outcome;
  }

  const unreadable = Arr.flatMap(parsed, (ticket) =>
    ticket.blockedBy === null
      ? [`${ticket.file} (blocked by "${ticket.blockedText}")`]
      : Arr.map(
          Arr.filter(ticket.blockedBy, (id) => !claiming.has(id)),
          (id) => `${ticket.file} (blocked by ${id})`,
        ),
  );
  if (unreadable.length > 0) {
    const outcome: PlanRepos = refuse(
      "unknown-blocker",
      `These tickets are blocked by something that is not a ticket of this plan: ${Arr.join(unreadable, ", ")}. ` +
        `A "Blocked by" line names the numbers of the tickets it waits for, or "None".`,
    );
    return outcome;
  }

  const changeOfId = new Map(
    Arr.map(parsed, (ticket) => [ticket.id, `${ticket.repo ?? "."}\0${ticket.change ?? ""}`]),
  );
  let cyclic = Arr.map(parsed, (ticket) => ({
    ...ticket,
    blockedBy: Arr.filter(
      ticket.blockedBy ?? [],
      (id) => changeOfId.get(id) === changeOfId.get(ticket.id),
    ),
  }));
  for (;;) {
    const ids = new Set(Arr.map(cyclic, (ticket) => ticket.id));
    const stuck = Arr.filter(
      cyclic,
      (ticket) =>
        Arr.some(ticket.blockedBy, (id) => ids.has(id)) &&
        Arr.some(cyclic, (other) => other.blockedBy.includes(ticket.id)),
    );
    if (stuck.length === cyclic.length) break;
    cyclic = stuck;
  }
  if (cyclic.length > 0) {
    const outcome: PlanRepos = refuse(
      "cycle",
      `These tickets block each other, so none of them can be built first: ${Arr.join(
        Arr.map(cyclic, (ticket) => ticket.file),
        ", ",
      )}. Take one of them off another's "Blocked by" line.`,
    );
    return outcome;
  }

  const atRoot = Arr.every(parsed, (ticket) => ticket.repo === null || ticket.repo === ".");
  if (atRoot && new Set(Arr.map(parsed, (ticket) => ticket.change ?? "")).size <= 1) {
    const outcome: PlanRepos = {
      repos: [{ path: ".", tickets: Arr.map(parsed, (ticket) => ticket.file) }],
      waves: [["."]],
      refusal: null,
    };
    return outcome;
  }

  const placed = Arr.filter(
    Arr.map(parsed, (ticket) => (atRoot ? { ...ticket, repo: "." } : ticket)),
    (ticket): ticket is Placed => ticket.repo !== null,
  );
  if (placed.length < parsed.length) {
    const silent = Arr.map(
      Arr.filter(parsed, (ticket) => ticket.repo === null),
      (ticket) => ticket.file,
    );
    const outcome: PlanRepos = refuse(
      "missing-repo",
      `Some tickets name a repository and these do not: ${Arr.join(silent, ", ")}. Every ticket in a plan that spans repositories needs a **Repo:** line.`,
    );
    return outcome;
  }

  const keyOf = (ticket: Placed) =>
    changeKey({ path: ticket.repo, change: ticket.change ?? undefined });
  const named = (ticket: Placed) =>
    `${ticket.file} (${ticket.change === null ? ticket.repo : `${ticket.repo}, Change: ${ticket.change}`})`;
  const firstOf = new Map<string, Placed>();
  const clashing: string[] = [];
  for (const ticket of placed) {
    const first = firstOf.get(keyOf(ticket));
    if (first === undefined) firstOf.set(keyOf(ticket), ticket);
    else if (first.repo !== ticket.repo || first.change !== ticket.change)
      clashing.push(`${named(first)} and ${named(ticket)}`);
  }
  if (clashing.length > 0) {
    const outcome: PlanRepos = refuse(
      "bad-change",
      `These tickets' Changes would share one name, and so one run and one branch: ${Arr.join(clashing, ", ")}. ` +
        `Name the Change so that it is not "<repository>--<name>" of another repository.`,
    );
    return outcome;
  }
  const ticketsOf = new Map<string, string[]>();
  const changeOf = new Map<string, { path: string; change?: string }>();
  const keyOfId = new Map<string, string>();
  for (const ticket of placed) {
    const key = keyOf(ticket);
    keyOfId.set(ticket.id, key);
    indexBy(ticketsOf, key, ticket.file);
    changeOf.set(
      key,
      ticket.change === null ? { path: ticket.repo } : { path: ticket.repo, change: ticket.change },
    );
  }
  const keys = [...ticketsOf.keys()];

  const blockers = new Map<string, Set<string>>(Arr.map(keys, (key) => [key, new Set<string>()]));
  const interleaving = new Map<string, string[]>();
  for (const ticket of placed) {
    const key = keyOf(ticket);
    for (const id of ticket.blockedBy ?? []) {
      const from = keyOfId.get(id)!;
      if (from === key) continue;
      blockers.get(key)!.add(from);
      const named = interleaving.get(key) ?? [];
      named.push(`${ticket.file} (blocked by ${from})`);
      interleaving.set(key, named);
    }
  }

  const waves: string[][] = [];
  const settled = new Set<string>();
  while (settled.size < keys.length) {
    const left = Arr.filter(keys, (key) => !settled.has(key));
    const wave = Arr.filter(left, (key) =>
      Arr.every([...blockers.get(key)!], (from) => settled.has(from)),
    );
    if (wave.length === 0) {
      let cyclic = left;
      for (;;) {
        const waited = Arr.filter(cyclic, (key) =>
          Arr.some(cyclic, (other) => blockers.get(other)!.has(key)),
        );
        if (waited.length === cyclic.length) break;
        cyclic = waited;
      }
      const interleaved = Arr.flatMap(cyclic, (key) => interleaving.get(key) ?? []);
      const outcome: PlanRepos = refuse(
        "cycle",
        `These Changes block each other, so no run can go first: ${Arr.join(cyclic, ", ")}. ` +
          `The tickets that interleave them: ${Arr.join(interleaved, ", ")}. ` +
          `Move a Change's tickets so that once it is blocked by another, none of that one's is blocked by it.`,
      );
      return outcome;
    }
    for (const key of wave) settled.add(key);
    waves.push(wave);
  }

  const paths = Arr.dedupe(Arr.map(placed, (ticket) => ticket.repo));
  const missing = Arr.filter(paths, (path) => !checkouts.has(path));
  if (missing.length > 0) {
    const outcome: PlanRepos = refuse(
      "missing-checkout",
      `These repositories are named by a ticket but not checked out under the plan's root: ${Arr.join(missing, ", ")}. ` +
        `Clone them there and answer again — Collie does not clone.`,
    );
    return outcome;
  }

  const waveOf = new Map(
    Arr.flatMap(waves, (wave, at) => Arr.map(wave, (key) => [key, at] as const)),
  );
  const repos = Arr.map([...ticketsOf], ([key, tickets]) => {
    const own = changeOf.get(key)!;
    const under = Arr.filter(
      keys,
      (from) => blockers.get(key)!.has(from) && changeOf.get(from)!.path === own.path,
    );
    const latest = Arr.reduce(under, Option.none<string>(), (best, from) =>
      Option.isNone(best) || waveOf.get(from)! > waveOf.get(best.value)! ? Option.some(from) : best,
    );
    const returned: PlanRepo = Option.isNone(latest)
      ? { ...own, tickets }
      : { ...own, stacked: latest.value, tickets };
    return returned;
  });
  const outcome: PlanRepos = { repos, waves, refusal: null };
  return outcome;
}

export const planReposOf = Effect.fn("Plan.planReposOf")(function* (planDir: string, root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const issues = path.join(planDir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe_(name, Str.endsWith(".md")),
  ).sort();
  const tickets: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const text = yield* fs
      .readFileString(path.join(issues, file))
      .pipe(Effect.orElseSucceed(() => ""));
    tickets.push({ file, text });
  }

  const named = new Set<string>(["."]);
  for (const ticket of tickets) {
    const repo = repoUnderRoot(REPO_LINE.exec(ticket.text)?.[1] ?? "");
    if (repo !== null) named.add(repo);
  }
  const checkouts = new Set<string>();
  for (const repo of named) {
    if (yield* fs.exists(path.join(root, repo, ".git"))) checkouts.add(repo);
  }

  return readPlanRepos(tickets, checkouts);
});

export interface Slice {
  file: string;
  number: string;
  title: string;
  blockedBy: ReadonlyArray<string>;
  checks: ReadonlyArray<string>;
  criteria: ReadonlyArray<string>;
  benchmark: string | null;
  prerequisites: ReadonlyArray<Prerequisite>;
}

function titleOf(file: string, text: string) {
  const heading = /^#+\s+(.+?)\s*$/m.exec(text)?.[1];
  if (heading) {
    const returned: string = Str.trim(pipe_(heading, Str.replace(/^\d+[\s:.-]+/, "")));
    return returned;
  }
  const returned: string = pipe_(
    file,
    Str.replace(/\.md$/, ""),
    Str.replace(/^\d+[-_]?/, ""),
    Str.replaceAll("-", " "),
  );
  return returned;
}

export function orderedTickets(
  tickets: ReadonlyArray<{ file: string; text: string }>,
  repo?: string,
  change = "",
) {
  const mine = Arr.filter(tickets, (ticket) => {
    if (repo === undefined || repo === "") return true;
    const written = repoUnderRoot(REPO_LINE.exec(ticket.text)?.[1] ?? "");
    return (
      (written === repo || (written === null && repo === ".")) &&
      (changeLineOf(ticket.text) ?? "") === change
    );
  });
  const slices: Slice[] = Arr.map(mine, (ticket) => ({
    file: ticket.file,
    number: ticketId(ticket.file),
    title: titleOf(ticket.file, ticket.text),
    blockedBy:
      blockersIn(
        Option.getOrUndefined(
          Option.flatMap(Option.fromNullishOr(BLOCKED_LINE.exec(ticket.text)), (present______) =>
            Option.map(Option.fromNullishOr(present______[1]), (present_______) =>
              Str.trim(present_______),
            ),
          ),
        ) ?? "",
      ) ?? [],
    checks: checksIn(ticket.text),
    criteria: criteriaIn(ticket.text),
    benchmark: benchmarkIn(ticket.text),
    prerequisites: prerequisitesOf(ticket.text) ?? [],
  }));

  const here = new Set(Arr.map(slices, (slice) => slice.number));
  const done = new Set<string>();
  const out: Slice[] = [];
  let left = slices;
  while (left.length > 0) {
    const ready = Arr.filter(left, (slice) =>
      Arr.every(slice.blockedBy, (id) => !here.has(id) || done.has(id)),
    );
    const taking = ready.length > 0 ? ready : left;
    for (const slice of taking) {
      out.push(slice);
      done.add(slice.number);
    }
    left = Arr.filter(left, (slice) => !done.has(slice.number));
  }
  const returned: Slice[] = out;
  return returned;
}

export const orderedTicketsOf = Effect.fn("Plan.orderedTicketsOf")(function* (
  planDir: string,
  repo?: string,
  change?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const issues = path.join(planDir, "issues");
  const files = Arr.filter(
    yield* fs.readDirectory(issues).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe_(name, Str.endsWith(".md")),
  ).sort();
  const tickets: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const text = yield* fs
      .readFileString(path.join(issues, file))
      .pipe(Effect.orElseSucceed(() => ""));
    tickets.push({ file, text });
  }
  return orderedTickets(tickets, repo, change);
});

export const benchmarkRefusalOf = Effect.fn("Plan.benchmarkRefusalOf")(function* (planDir: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const ticket of yield* orderedTicketsOf(planDir)) {
    if (ticket.benchmark === null) continue;
    const refused = yield* fs.readFileString(benchmarkFile(planDir, ticket.benchmark)).pipe(
      Effect.mapError((cause) => `it cannot be read: ${cause.message}`),
      Effect.flatMap((text) =>
        Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
          Effect.mapError((cause) => `it is not JSON: ${cause.message}`),
        ),
      ),
      Effect.flatMap(decodeBenchmarkPlan),
      Effect.flip,
      Effect.option,
    );
    if (Option.isSome(refused)) return `${ticket.file}: ${ticket.benchmark}: ${refused.value}`;
  }
  return null;
});
