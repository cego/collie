// What a new Task's workspace is called: `<Project or theme> | <what this work is>`.
//
// The name is inferred rather than asked for, from the work itself and from the names the
// person already has on their own workspaces, tabs and panes — so a second Collie task
// reads as a sibling of the first, and somebody else's projects read as theirs. Nothing
// is remembered between sessions: the live labels are the vocabulary, read each time.
//
// Every one of those labels is data. They are quoted into the pack as data, the model
// answers in a two-string schema with nothing in it that acts, and what comes back is a
// display label — never a path component, an agent name or a command.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { PluginEnv } from "./env";
import { askOnce, budgetedDeps, type BudgetedDeps, type TaskName } from "./evaluator";
import { Herdr } from "./herdr";
import { liveHerds } from "./herds";
import { oneLine, taskWorkspaceLabel } from "./naming";
import type { RunFacts } from "./runs";
import { listTasks, readTask, withTaskLock, writeTask } from "./task";

/** The names this person already has, as herdr reports them. Read-only context. */
export interface LiveNames {
  readonly workspaces: ReadonlyArray<string>;
  readonly tabs: ReadonlyArray<string>;
  readonly panes: ReadonlyArray<string>;
}

/** The work being started, in the words it was started with. */
export interface TaskContext {
  readonly workflow: string;
  /** What the Run is named after, whole — the plan directory, the issue, the goal. */
  readonly named: string;
  /** The short form of that, where the Input offered one. */
  readonly short: string;
  /** What the human said the Run is for, where they said anything. */
  readonly goal: string | null;
  /** The directory the work is rooted in; its last component is the repository. */
  readonly cwd: string;
}

/** A label of the form `<project> | <rest>`, which is what a reused prefix looks like. */
const PREFIXED = /^(.+?)\s\|\s(.+)$/;

/** Letters and digits only, for judging whether two names are the same word. */
function normal(text: string): string {
  return pipe_(Str.toLowerCase(text), Str.replace(/[^a-z0-9]+/g, ""));
}

/** The repository this work is in, which is the last component of its directory. */
export function repositoryOf(cwd: string): string {
  return Arr.filter(Str.split(cwd, "/"), (part) => part !== "").at(-1) ?? "";
}

/**
 * The project prefix this person already uses for this repository, where they use one:
 * the `<project> |` half of a live workspace label whose project names the same thing the
 * repository does. Spelled exactly as they spell it, because the point is recognition.
 */
export function establishedProject(live: LiveNames, repo: string): string | null {
  const wanted = normal(repo);
  if (wanted === "") return null;
  for (const prefix of prefixesIn(live)) if (names(normal(prefix), wanted)) return prefix;
  return null;
}

/** Every `<project> |` prefix on the person's live workspaces, as they spelled it. */
function prefixesIn(live: LiveNames): string[] {
  return Arr.flatMap(live.workspaces, (label) => {
    const prefix = Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(PREFIXED.exec(oneLine(label))), (present) =>
        Option.map(Option.fromNullishOr(present[1]), (present_) => Str.trim(present_)),
      ),
    );
    return prefix === undefined || normal(prefix) === "" ? [] : [prefix];
  });
}

/** Whether a normalised project names the same thing as a normalised repository. */
const names = (project: string, repo: string) =>
  project === repo || pipe_(project, Str.includes(repo)) || pipe_(repo, Str.includes(project));

/**
 * How much of a mechanical title is worth putting on a sidebar row. Not a rule anybody
 * agreed to and not a limit on what the model may answer: it bounds only the stand-in
 * below, which is built from a path or a slug and has no idea where the meaning stops.
 */
const FALLBACK_WORDS = 6;

/** Words a title may end on only by having been cut off. */
const DANGLING = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * A name without asking anybody: the project this person already uses for this
 * repository, else the repository itself, and the work's own short name as the title.
 *
 * Mechanical, and it is the stand-in rather than the mechanism — what a Task is called
 * when there is no evaluator to ask, or when it answered with nothing usable. A start
 * never fails because a name could not be inferred.
 */
export function fallbackName(context: TaskContext, live: LiveNames): TaskName {
  const repo = repositoryOf(context.cwd);
  const from = oneLine(context.short || context.goal || context.named || context.workflow);
  const words = /\s/.test(from)
    ? Arr.filter(
        Str.split(pipe_(Str.split(from, /(?<=[.!?])\s/)[0] ?? "", Str.replace(/[.!?]$/, "")), " "),
        (word) => word !== "" && !pipe_(word, Str.includes("://")),
      )
    : Arr.filter(Str.split(Str.split(from, "/").at(-1) ?? from, /[-_]+/), (word) => word !== "");
  const kept = words.slice(0, FALLBACK_WORDS);
  while (kept.length > 1 && DANGLING.has(Str.toLowerCase(kept.at(-1)!))) kept.pop();
  return {
    project: establishedProject(live, repo) ?? sentence(pipe_(repo, Str.replace(/[-_]+/g, " "))),
    title: sentence(Arr.join(kept, " ")),
  };
}

/** Words that say a piece of work exists without saying which. */
const FILLER = new Set([
  ...DANGLING,
  "new",
  "work",
  "task",
  "run",
  "plan",
  "planned",
  "planning",
  "implement",
  "implementation",
  "change",
  "changes",
  "workflow",
  "improvement",
  "general",
  "investigation",
  "this",
]);

/**
 * Whether a title names only the workflow it runs and words like "new work": `Plan new
 * work` and `Implement plan` say nothing two Tasks of one workflow do not both say.
 */
export function isGenericTitle(title: string, workflow: string): boolean {
  const said = (word: string) => FILLER.has(word) || own.has(word);
  const own = new Set(Str.split(Str.toLowerCase(workflow), /[^\p{L}\p{N}]+/u));
  return Arr.every(
    Str.split(Str.toLowerCase(title), /[^\p{L}\p{N}]+/u),
    (word) => word === "" || said(word) || said(pipe_(word, Str.replace(/s$/, ""))),
  );
}

const isText = Schema.is(Schema.String);

/** The most descriptive Input a start was given, whatever it is called or where it came. */
export function workNamedIn(inputs: Readonly<Record<string, Schema.Json>>): string {
  return Arr.reduce(
    Arr.flatMap(Rec.values(inputs), (value) => (isText(value) ? [Str.trim(value)] : [])),
    "",
    (longest, value) => (value.length > longest.length ? value : longest),
  );
}

/** A spec's own label, which says what the file is rather than what the work is. */
const SPEC_LABEL = /^(spec|work source)\b[^:]*(:\s*|$)/i;

/**
 * What a plan handed over by its path, absolute or from `cwd`, is about: the first heading
 * or Work source line of its spec, or of a Markdown file. Anything else is returned as given.
 */
export const objectiveOf = Effect.fn("tasknames.objectiveOf")(function* (
  named: string,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (Str.trim(named) === "" || pipe_(named, Str.includes("\n"))) return named;
  const at = path.resolve(cwd, named);
  const info = yield* fs.stat(at).pipe(Effect.option);
  if (info._tag === "None") return named;
  const file =
    info.value.type === "Directory"
      ? path.join(at, "SPEC.md")
      : pipe_(at, Str.endsWith(".md"))
        ? at
        : null;
  if (file === null) return named;
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  for (const line of Str.split(text, "\n")) {
    if (!/^#+\s/.test(line) && !SPEC_LABEL.test(line)) continue;
    const said = Str.trim(
      pipe_(Str.trim(pipe_(line, Str.replace(/^#+/, ""))), Str.replace(SPEC_LABEL, "")),
    );
    if (said !== "") return said;
  }
  return named;
});

/** A slug read as a phrase: what a person would have written, capitalised once. */
function sentence(text: string): string {
  return text === "" ? "" : `${Str.toUpperCase(text[0]!)}${pipe_(text, Str.slice(1))}`;
}

/** One list of the person's own names, quoted so a label cannot end the block. */
function listed(heading: string, names: ReadonlyArray<string>): string {
  const lines = [...new Set(Arr.filter(Arr.map(names, oneLine), (name) => name !== ""))];
  return Arr.join(
    [`### ${heading}`, ...(lines.length === 0 ? ["(none)"] : Arr.map(lines, (n) => `- ${n}`))],
    "\n",
  );
}

/** Everything the namer is shown, and it is all data. */
export function namePack(context: TaskContext, live: LiveNames): string {
  return Arr.join(
    [
      "## The work being started",
      "",
      `- workflow: ${oneLine(context.workflow)}`,
      `- repository: ${oneLine(repositoryOf(context.cwd))}`,
      `- named after: ${oneLine(context.named)}`,
      `- short name: ${oneLine(context.short)}`,
      `- goal: ${oneLine(context.goal ?? "")}`,
      "",
      "## The names this person already has",
      "",
      listed("Workspaces", live.workspaces),
      "",
      listed("Tabs", live.tabs),
      "",
      listed("Panes", live.panes),
      "",
    ],
    "\n",
  );
}

/**
 * The model's answer as a label may carry it: one line each, and an empty field replaced
 * by what the stand-in would have said. A model that answered with nothing has not named
 * the Task, and the stand-in is what a Task with no name would have been called anyway.
 */
export function cleanName(answer: TaskName, context: TaskContext, live: LiveNames): TaskName {
  const otherwise = fallbackName(context, live);
  // A prefix the person already uses belongs to the repository it names: borrowed for
  // another one, it files this work under somebody else's project on the board.
  // Any part of the path counts, since a worktree's last part is its branch's folder.
  const project = oneLine(answer.project);
  const parts = Arr.filter(
    Arr.map(Str.split(context.cwd, "/"), normal),
    (part) => part.length >= 3,
  );
  const borrowed =
    Arr.some(prefixesIn(live), (prefix) => normal(prefix) === normal(project)) &&
    !Arr.some(parts, (part) => names(normal(project), part));
  const title = oneLine(answer.title);
  const generic =
    isGenericTitle(title, context.workflow) && !isGenericTitle(otherwise.title, context.workflow);
  return {
    project: borrowed ? otherwise.project : project || otherwise.project,
    title: title === "" || generic ? otherwise.title : title,
  };
}

export type NamingDeps = BudgetedDeps;

/**
 * What to call this Task. Asked of the one place a model is asked anything, and answered
 * by the stand-in wherever that is unavailable, slow, or unusable — naming is the last
 * thing that should stop a person starting work.
 */
export const nameTask = Effect.fn("tasknames.nameTask")(function* (
  deps: NamingDeps | null,
  context: TaskContext,
  live: LiveNames,
) {
  if (deps === null) return fallbackName(context, live);
  const answer = yield* askOnce(deps, "naming", namePack(context, live));
  if (answer === null || !("project" in answer)) return fallbackName(context, live);
  return cleanName(answer, context, live);
});

/** Live labels are naming context; a failed read must not prevent a start. */
const liveNames = Effect.fn("tasknames.liveNames")(function* (herdr: Herdr, everything: boolean) {
  const workspaces = yield* herdr.workspaceList().pipe(Effect.orElseSucceed(() => []));
  const [tabs, panes] = everything
    ? yield* Effect.all([
        herdr.tabList().pipe(Effect.orElseSucceed(() => [])),
        herdr.paneList().pipe(Effect.orElseSucceed(() => [])),
      ])
    : [[], []];
  return {
    workspaces: Arr.map(workspaces, (workspace) => workspace.label),
    tabs: Arr.map(tabs, (tab) => tab.label),
    panes: Arr.flatMap(panes, (pane) => (pane.label === null ? [] : [pane.label])),
  } satisfies LiveNames;
});

/** What a start is about, as its caller gave it. */
export interface StartAbout {
  readonly workflow: string;
  /** Every Input the start was given, by name. */
  readonly inputs: Readonly<Record<string, Schema.Json>>;
  /** What the human said it is for, where they said anything. */
  readonly goal?: string | null | undefined;
  /** What the human called it, which names it unless it says nothing. */
  readonly title?: string | undefined;
}

/** Infer a fresh Task's label from its work; `asking: false` uses the stand-in. */
export const freshTaskLabel = Effect.fn("tasknames.freshTaskLabel")(function* (
  env: PluginEnv,
  about: StartAbout,
  asking = true,
) {
  const naming = asking
    ? yield* budgetedDeps(env, "namer.md", { maxSeconds: 30, maxOutputBytes: 4 * 1024 })
    : null;
  const context: TaskContext = {
    workflow: about.workflow,
    named: yield* objectiveOf(workNamedIn(about.inputs), env.cwd),
    short: "",
    goal: about.goal ?? null,
    cwd: env.cwd,
  };
  const live = yield* liveNames(new Herdr(env), naming !== null);
  const title = oneLine(about.title ?? "");
  if (title !== "" && !isGenericTitle(title, about.workflow))
    return taskWorkspaceLabel({ project: fallbackName(context, live).project, title });
  return taskWorkspaceLabel(yield* nameTask(naming, context, live));
});

/**
 * Renames each Task whose title names only its workflow, from its first Run's Inputs and
 * without asking a model — only where the label is still the one Collie wrote: on a live
 * workspace in the Task's own Herd that still carries it, or on the record of one that
 * Herd no longer has.
 */
export const retitleGenericTasks = Effect.fn("tasknames.retitleGenericTasks")(function* (
  env: PluginEnv,
  herdr: Herdr,
  runs: ReadonlyArray<RunFacts>,
) {
  const tasks = yield* listTasks(env.stateDir);
  const herds = yield* liveHerds(herdr, env);
  for (const task of tasks) {
    const [, project, title] = PREFIXED.exec(task.label) ?? [];
    const first = Arr.filter(runs, (run) => run.task === task.id).sort((one, other) =>
      pipe_(one.created, Str.localeCompare(other.created)),
    )[0];
    if (project === undefined || title === undefined || first === undefined) continue;
    if (!isGenericTitle(title, first.workflow)) continue;
    // Workspace ids are only unique within a session.
    const herd =
      task.herd === undefined
        ? herds.length === 1
          ? herds[0]
          : undefined
        : Option.getOrUndefined(Arr.findFirst(herds, (one) => one.herd === task.herd));
    if (herd === undefined) continue;
    const named = fallbackName(
      {
        workflow: first.workflow,
        named: yield* objectiveOf(workNamedIn(first.settled.inputs), task.cwd),
        short: "",
        goal: null,
        cwd: task.cwd,
      },
      { workspaces: [], tabs: [], panes: [] },
    );
    if (isGenericTitle(named.title, first.workflow)) continue;
    const label = `${project} | ${named.title}`;
    yield* withTaskLock(
      env.stateDir,
      task.id,
      Effect.gen(function* () {
        const now = yield* readTask(env.stateDir, task.id);
        if (now === null || now.label !== task.label) return;
        const listed = yield* herd.herdr.workspaceList().pipe(Effect.option);
        // Unread, a workspace a human renamed is indistinguishable from one that is gone.
        if (listed._tag === "None") return;
        const showing = Option.getOrUndefined(
          Arr.findFirst(listed.value, (one) => one.workspaceId === now.workspace),
        )?.label;
        if (showing !== undefined && showing !== now.label) return;
        const current = yield* readTask(env.stateDir, task.id);
        if (current === null || current.label !== now.label || current.workspace !== now.workspace)
          return;
        if (showing !== undefined) {
          const renamed = yield* herd.herdr
            .workspaceRename(now.workspace, label)
            .pipe(Effect.option);
          if (renamed._tag === "None") return;
        }
        const latest = yield* readTask(env.stateDir, task.id);
        if (latest === null || latest.label !== now.label || latest.workspace !== now.workspace)
          return;
        yield* writeTask(env.stateDir, { ...latest, label });
      }),
    ).pipe(Effect.catchTag("TaskBusy", () => Effect.void));
  }
});
