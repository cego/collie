// An agent's start, from `collie run start` or chat: nothing is inferred or routed, so it
// names its checkout and every Input, and a gap is refused with what would fill it
// (ADR-0033). The Launch flow is the human's front door and does not come through here.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { Found } from "./discovery";
import type { Given } from "./engine";
import type { PluginEnv } from "./env";
import { inferInput, shell } from "./inputs";
import { err, type Failure } from "./operations";
import { checkoutsUnder, PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { listRuns } from "./runs";
import { strategyMeaning } from "./strategies";
import { repositoryName } from "./worktree";

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
      }).pipe(Effect.orElseSucceed(() => null));
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
  const names = missing.map((one) => `"${one.name}"`).join(", ");
  const checkoutFix = checkoutNamed ? "" : ` ${checkout.fix}`;
  const listed = missing.map(
    (one) =>
      `- ${one.name}: ${one.meaning || "no description"}${one.facts.length === 0 ? "" : `; could be ${one.facts.join(", ")}`}`,
  );
  return err(
    "needs_input",
    [
      `${entry.id} needs ${names}. Nothing is inferred for an agent's start: give every Input, an optional one you leave empty as "".${checkoutFix}`,
      ...listed,
    ].join("\n"),
    {
      workflow: entry.id,
      path: entry.path,
      inputs: missing.map((one) => {
        const field = entry.inputs.find((input) => input.name === one.name);
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
