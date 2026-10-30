// An agent's start, from `collie run start` or chat: nothing is inferred or routed, so it
// names its checkout and every Input, and a gap is refused with what would fill it
// (ADR-0033). The Launch flow is the human's front door and does not come through here.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Option, Path, Schema, flow, Result } from "effect";
import { gitlabHostOf } from "./config";
import type { Found } from "./discovery";
import type { Given } from "./engine";
import type { PluginEnv } from "./env";
import { forgeHttpLayer } from "./forge/http";
import { inferInput, shell } from "./inputs";
import { err, type Failure } from "./operations";
import { checkoutsUnder, PROJECTS_ROOT_OPTION, projectsRoot, repositoryCheckout } from "./projects";
import { listRuns } from "./runs";
import { RESERVED_INPUTS } from "./sdk";
import { strategyMeaning } from "./strategies";
import { repositoryName } from "./worktree";

/**
 * What the host supplies at launch, split from what the author declared. A module may not
 * declare one of these names — `checkEntry` refuses that at load — so a value under one is
 * the host's option and never an input, and nothing of the host's reaches the payload.
 */
export function hostOptions(given: Given) {
  return {
    input: {
      json: Rec.fromEntries(Arr.filter(Rec.toEntries(given.json), ([name]) => !isOption(name))),
      text: Rec.fromEntries(Arr.filter(Rec.toEntries(given.text), ([name]) => !isOption(name))),
    },
    options: Rec.fromEntries([
      ...Arr.filter(Rec.toEntries(given.text), ([name]) => isOption(name)),
      ...Arr.map(
        Arr.filter(Rec.toEntries(given.json), ([name]) => isOption(name)),
        ([name, value]) => [name, asOptionText(value)] as const,
      ),
    ]),
  };
}

const isOption = (name: string) => name in RESERVED_INPUTS;

/** A host option is text; one that arrived as typed JSON is written back down as it came. */
export const asOptionText = (value: Schema.Json) => (isText(value) ? value : asJsonText(value));
const isText = Schema.is(Schema.String);
const asJsonText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

/** How many plan directories a refusal offers for a work source. */
const PLANS_OFFERED = 5;

const CHECKOUT_MEANING = `Which checkout the Run starts in: its absolute path, or \`${PROJECTS_ROOT_OPTION}\` for the Projects root`;

/** How a CLI start names its checkout. */
export const CLI_CHECKOUT_FIX = `Name the checkout with --input workspace=<absolute path> or workspace=${PROJECTS_ROOT_OPTION}.`;

/** How a chat start names its checkout. */
export const CHAT_CHECKOUT_FIX = `Name the checkout in the action's workspace: a workspace id, its label, an absolute path, a repository's name under the Projects root, or ${PROJECTS_ROOT_OPTION}.`;

/** Whether a start from `cwd` has named its checkout by being in one. */
export const insideCheckout = (cwd: string) =>
  repositoryName(shell, cwd).pipe(
    Effect.map((name) => name !== null),
    Effect.orElseSucceed(() => false),
  );

/**
 * The refusal for an agent's start that leaves anything unsaid, or null where it names
 * everything. The checkout is the front door's to say — a CLI start in a checkout has
 * named it, a chat start names one only through its `workspace` — and so is the sentence
 * that tells its caller how to name one.
 */
export const agentStartRefusal = Effect.fn("AgentStart.refusal")(function* (
  env: PluginEnv,
  entry: Found,
  given: Given,
  checkout: {
    /** The directory the start names, or null where it names none. */
    readonly named: string | null;
    readonly fix: string;
  },
) {
  const checkoutNamed = checkout.named !== null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const missing: Array<{ name: string; meaning: string; facts: string[] }> = [];
  if (!checkoutNamed) {
    const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
    const checkouts = root === null ? [] : yield* checkoutsUnder(root.path);
    missing.push({
      name: "workspace",
      meaning: CHECKOUT_MEANING,
      facts: [...checkouts, PROJECTS_ROOT_OPTION],
    });
  }
  for (const field of entry.inputs) {
    if (given.text[field.name] !== undefined || given.json[field.name] !== undefined) continue;
    const facts: string[] = [];
    if (checkoutNamed && field.strategy === "diff-target") {
      const inferred = yield* inferInput(field.name, "diff-target", {
        cwd: checkout.named ?? env.cwd,
        gitlabHost: yield* gitlabHostOf(env).pipe(Effect.orElseSucceed(() => undefined)),
      }).pipe(
        Effect.provide(forgeHttpLayer),
        Effect.orElseSucceed(() => null),
      );
      if (inferred !== null && !inferred.needsAsking && inferred.value !== "")
        facts.push(`${inferred.value} (${inferred.source})`);
    }
    if (field.strategy === "work-source" || field.strategy === "plan-dir") {
      const runs = yield* listRuns(env).pipe(Effect.orElseSucceed(() => []));
      for (const run of runs) {
        if (facts.length >= PLANS_OFFERED) break;
        if (run.state !== "succeeded") continue;
        const plan = path.join(run.dir, "plan");
        if (yield* fs.exists(path.join(plan, "SPEC.md")).pipe(Effect.orElseSucceed(() => false)))
          facts.push(plan);
      }
    }
    missing.push({ name: field.name, meaning: meaningOf(field), facts });
  }
  if (missing.length === 0) return null;
  const names = Arr.join(
    Arr.map(missing, (one) => `"${one.name}"`),
    ", ",
  );
  const checkoutFix = checkoutNamed ? "" : ` ${checkout.fix}`;
  const listed = Arr.map(
    missing,
    (one) =>
      `- ${one.name}: ${one.meaning || "no description"}${one.facts.length === 0 ? "" : `; could be ${Arr.join(one.facts, ", ")}`}`,
  );
  return err(
    "needs_input",
    Arr.join(
      [
        `${entry.id} needs ${names}. Nothing is inferred for an agent's start: give every Input, an optional one you leave empty as "".${checkoutFix}`,
        ...listed,
      ],
      "\n",
    ),
    {
      workflow: entry.id,
      path: entry.path,
      inputs: Arr.map(missing, (one) => {
        const field = Option.getOrUndefined(
          Arr.findFirst(entry.inputs, (input) => input.name === one.name),
        );
        return {
          ...one,
          question: `${entry.title} — ${one.name}?`,
          required: field?.required ?? true,
          schema: field?.schema ?? null,
          limits: [...(field?.limits ?? [])],
        };
      }),
    },
  ) satisfies Failure;
});

/** What a field is for: the schema's own description, else what its strategy means. */
function meaningOf(field: Found["inputs"][number]): string {
  const described = Option.getOrUndefined(describedIn(field.schema))?.description ?? "";
  if (described !== "") return described;
  return field.strategy === null ? "" : strategyMeaning(field.strategy);
}

const describedIn = Schema.decodeUnknownOption(Schema.Struct({ description: Schema.String }));

export const startCheckout = Effect.fn("AgentStart.checkout")(function* (
  env: PluginEnv,
  project: string,
  options: Readonly<Record<string, string>> | undefined,
  remote: boolean,
) {
  const named = options?.workspace ?? project;
  const repository = yield* repositoryCheckout(env, named);
  if (repository !== null && "error" in repository) return repository;
  let cwd = repository?.path ?? project;
  if (
    repository === null &&
    options?.workspace &&
    options.workspace !== PROJECTS_ROOT_OPTION &&
    options.workspace !== "new"
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const namedPath = pipe(options.workspace, Str.startsWith("~/"))
      ? path.join(env.home, pipe(options.workspace, Str.slice(2)))
      : options.workspace;
    const at = path.resolve(env.cwd, namedPath);
    const found = yield* fs.stat(at).pipe(Effect.option);
    if (Option.isNone(found) || found.value.type !== "Directory")
      return { error: `workspace: ${at} is not a directory` };
    cwd = at;
  }
  const launch = { ...options };
  if (
    repository !== null ||
    (remote &&
      launch.branch &&
      options?.workspace !== undefined &&
      options.workspace !== "new" &&
      options.workspace !== PROJECTS_ROOT_OPTION)
  )
    delete launch.workspace;
  let branchBase: string | undefined;
  if (remote && launch.branch) {
    const valid = yield* shell("git", ["check-ref-format", "--branch", launch.branch], cwd);
    if (valid.code !== 0) return { error: `"${launch.branch}" is not a branch name.` };
    const from = repository?.remote ?? "origin";
    const ref = `refs/remotes/${from}/${launch.branch}`;
    const fetched = yield* shell(
      "git",
      ["fetch", from, `+refs/heads/${launch.branch}:${ref}`],
      cwd,
    );
    if (fetched.code !== 0)
      return {
        error: `Could not fetch branch "${launch.branch}" from ${from} in ${cwd}: ${Str.trim(fetched.stderr ?? "")}`,
      };
    const head = yield* shell("git", ["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (head.code !== 0) return { error: `Could not read the fetched branch in ${cwd}.` };
    branchBase = Str.trim(head.stdout);
  }
  const root =
    remote && options?.workspace === PROJECTS_ROOT_OPTION
      ? (yield* projectsRoot(env)).path
      : undefined;
  return {
    project: root ?? (remote ? cwd : (repository?.path ?? project)),
    options: launch,
    branchBase,
    root,
  };
});
