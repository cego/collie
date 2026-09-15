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

import { Effect } from "effect";
import { evaluate, type EvaluatorDeps, type TaskName } from "./evaluator";
import { oneLine } from "./naming";
import { reserve, settle as settleBudget } from "./steering";
import { newRequestId } from "./operations";

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
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The repository this work is in, which is the last component of its directory. */
export function repositoryOf(cwd: string): string {
  return (
    cwd
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? ""
  );
}

/**
 * The project prefix this person already uses for this repository, where they use one:
 * the `<project> |` half of a live workspace label whose project names the same thing the
 * repository does. Spelled exactly as they spell it, because the point is recognition.
 */
export function establishedProject(live: LiveNames, repo: string): string | null {
  const wanted = normal(repo);
  if (wanted === "") return null;
  for (const label of live.workspaces) {
    const prefix = PREFIXED.exec(oneLine(label))?.[1]?.trim();
    if (prefix === undefined) continue;
    const project = normal(prefix);
    if (
      project !== "" &&
      (project === wanted || project.includes(wanted) || wanted.includes(project))
    )
      return prefix;
  }
  return null;
}

/**
 * How much of a mechanical title is worth putting on a sidebar row. Not a rule anybody
 * agreed to and not a limit on what the model may answer: it bounds only the stand-in
 * below, which is built from a path or a slug and has no idea where the meaning stops.
 */
const FALLBACK_WORDS = 6;

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
  const from = context.short || context.goal || context.named || context.workflow;
  const words = oneLine(from.split("/").at(-1) ?? from)
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter((word) => word !== "");
  return {
    project: establishedProject(live, repo) ?? sentence(repo.replace(/[-_]+/g, " ")),
    title: sentence(words.slice(0, FALLBACK_WORDS).join(" ")),
  };
}

/** A slug read as a phrase: what a person would have written, capitalised once. */
function sentence(text: string): string {
  return text === "" ? "" : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** One list of the person's own names, quoted so a label cannot end the block. */
function listed(heading: string, names: ReadonlyArray<string>): string {
  const lines = [...new Set(names.map(oneLine).filter((name) => name !== ""))];
  return [`### ${heading}`, ...(lines.length === 0 ? ["(none)"] : lines.map((n) => `- ${n}`))].join(
    "\n",
  );
}

/** Everything the namer is shown, and it is all data. */
export function namePack(context: TaskContext, live: LiveNames): string {
  return [
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
  ].join("\n");
}

/**
 * The model's answer as a label may carry it: one line each, and an empty field replaced
 * by what the stand-in would have said. A model that answered with nothing has not named
 * the Task, and the stand-in is what a Task with no name would have been called anyway.
 */
export function cleanName(answer: TaskName, context: TaskContext, live: LiveNames): TaskName {
  const otherwise = fallbackName(context, live);
  return {
    project: oneLine(answer.project) || otherwise.project,
    title: oneLine(answer.title) || otherwise.title,
  };
}

export interface NamingDeps {
  readonly evaluator: EvaluatorDeps;
  /** Where this call is written down as usage, before it is made and after. */
  readonly budget: string;
}

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
  const callId = yield* newRequestId();
  const asked = yield* Effect.result(
    Effect.gen(function* () {
      yield* reserve(deps.budget, { id: callId, run: null }, deps.evaluator.limits);
      const answer = yield* evaluate(deps.evaluator, "naming", namePack(context, live));
      yield* settleBudget(deps.budget, callId, {
        outcome:
          answer.spent.outcome === "ok" && answer.error !== null ? "failed" : answer.spent.outcome,
        usd: answer.spent.usd,
        seconds: answer.spent.seconds,
        bytes: answer.spent.bytes,
      });
      return answer.value;
    }),
  );
  if (asked._tag === "Failure" || asked.success === null || !("project" in asked.success))
    return fallbackName(context, live);
  return cleanName(asked.success, context, live);
});
