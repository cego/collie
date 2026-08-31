// Executes a Run: one tab per Step, agents started with the right Harness,
// Model and Persona, gates and loops driven by Output files.

import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { nowIso, nowMillis } from "./time";

import type {
  ChoiceDef,
  Definitions,
  ResolvedStep,
  ResolvedWorkflow,
  RoundDef,
  StepRequirement,
  Variant,
} from "./definitions";
import { roundVariant, stepVariants, variantKeys } from "./definitions";
import type { Defaults } from "./config";
import { configValue, readConfig, writeConfigValue } from "./config";
import type { PluginEnv } from "./env";
import type { PickItem } from "./picker";
import { slugify } from "./template";
import { isYamlMap, YamlMapSchema, YamlValueSchema, type YamlMap, type YamlValue } from "./yaml";
import type { Herdr } from "./herdr";
import { HerdrError } from "./herdr";
import { HARNESSES, personaPrefix, startArgs } from "./harness";
import {
  findingKey,
  formatFindings,
  parseFindings,
  parseReviewOutput,
  parseSynthesis,
  renderReview,
  REVIEW_FILE,
  splitDisputed,
  type Finding,
  type ReviewOutput,
} from "./output";
import {
  agentName,
  disambiguate,
  displayName,
  evenRatio,
  GLYPH,
  paneLabel,
  shellQuote,
  stepLabel,
  tabLabel,
  tabNameOf,
  targetLabel,
  CONTROL_PLANE,
} from "./naming";
import { registerAgent, registryPath, scopeFor } from "./registry";
import {
  classifyWorkSource,
  inferInputs,
  resolveWorkSource,
  shell as shellRun,
  targetKind,
  type InputPrompts,
} from "./inputs";
import { RunStore } from "./run";
import {
  gitlabForProject,
  gitlabReadiness,
  mrFacts,
  parseMrTarget,
  repoArgs,
  type MrFacts,
  type Runner,
} from "./mr";
import { askRoute, liveRole, sendPlanChange, sendReview, type Session } from "./handoff";
import { renderTemplate } from "./template";
import { resolveWorkflow } from "./definitions";
import type { Run, RunStatus, StepStatus, VariantRecord } from "./run";

export const VIEW_SOURCE_PREFIX = "cego.collie:";

/** How a Choice step reaches the human. The runner pane supplies the picker TUI. */
export type EnginePrompts = InputPrompts<Error | PlatformError, FileSystem.FileSystem | Path.Path>;

export interface EngineOptions {
  herdr: Herdr;
  defs: Definitions;
  defaults: Defaults;
  wf: ResolvedWorkflow;
  run: Run;
  env: PluginEnv;
  out: (
    line: string,
  ) => Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem | Path.Path>;
  stepTimeoutMs?: number;
  /** How long to keep waiting for an Output after the agent hands off to the human. */
  handoffTimeoutMs?: number;
  outputPollMs?: number;
  /** Required by any Workflow with a Choice step. */
  prompts?: EnginePrompts;
}

interface VariantOutcome {
  record: VariantRecord;
  output: YamlValue | null;
  review: ReviewOutput | null;
}

/** What a failure says for a log line, the way a caught Error used to. */
function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const isString = Schema.is(Schema.String);
const JsonValue = Schema.fromJsonString(YamlValueSchema);
const choiceResult = (result: ChoiceResult): ChoiceResult => result;
const handoffResult = (
  result: false | { ok: boolean; message: string },
  fallback: string,
): { ok: boolean; message: string } => result || { ok: false, message: fallback };

const runShell: Runner<ChildProcessSpawner.ChildProcessSpawner> = shellRun;

/** What one execution accumulates as it goes: only this process's panes and agents. */
interface RunCtx {
  outputs: Map<string, VariantOutcome[]>;
  /** Panes this process created; a resumed run's recorded panes are gone. */
  panes: string[];
  ran: Set<string>;
  /** One agent per `agent:` group, so a resumed run still keeps one implementer. */
  groups: Map<string, VariantRecord>;
  viewSource: string;
  /** The Control Plane tab this run asks its questions in, when there is one. */
  workspaceTabId: string | null;
  /** Each of this run's tabs and the name it was given; the glyph is what moves. */
  tabNames: Map<string, string>;
}

export const executeRun = Effect.fn("Engine.executeRun")(function* (o: EngineOptions) {
  const { run, wf, out } = o;
  const viewSource = `${VIEW_SOURCE_PREFIX}${run.id}`;
  const ctx: RunCtx = {
    outputs: new Map(),
    panes: [],
    ran: new Set(),
    groups: new Map(),
    viewSource,
    workspaceTabId: null,
    tabNames: new Map(),
  };

  run.record.status = "running";
  run.record.finished_at = null;
  // The tab, the toast and the workspace view all name the run the same way.
  run.record.target_label = runTarget(wf, run.record);
  yield* run.save();

  // Before anything opens: this is where the run's own pane and its menus live.
  ctx.workspaceTabId = yield* ensureWorkspaceTab(o);
  yield* ensureTrusted(o);

  const indexOf = (id: string) => wf.steps.findIndex((s) => s.id === id);
  const repeats = wf.steps
    .map((s, at) =>
      s.repeat
        ? {
            at,
            from: indexOf(s.repeat.from),
            // The gate is `from`; the loop restarts at `back_to`, which may be earlier.
            back: indexOf(s.repeat.back_to ?? s.repeat.from),
            max: s.repeat.max ?? wf.maxIterations,
          }
        : null,
    )
    .filter((r): r is { at: number; from: number; back: number; max: number } => r !== null);

  let index = 0;
  while (index < wf.steps.length) {
    const step = wf.steps[index]!;
    const record = run.step(step.id);

    if (record.status === "done") {
      yield* out(`✓ ${step.id} — already done, skipped`);
      index += 1;
      continue;
    }

    // A step that needs something this machine or repo does not have is not a
    // failure: it is work that cannot be done here, and the run carries on.
    let extras: YamlMap | undefined;
    if ((step.requires?.length ?? 0) > 0) {
      const unmet = yield* unmetRequirement(o, step.requires!);
      if (unmet) {
        record.status = "done";
        record.note = `skipped: ${unmet}`;
        yield* run.save();
        yield* out(`◦ ${step.id} — skipped: ${unmet}`);
        index += 1;
        continue;
      }
      if (step.requires!.includes("gitlab")) {
        const facts = yield* mrFacts(
          {
            cwd: run.record.cwd,
            inputs: run.record.inputs,
            configuredAssignee: configValue(yield* readConfig(o.env.configDir), "gitlab.assignee"),
          },
          runShell,
        );
        extras = mrVars(facts);
      }
    }

    if ((step.choices?.length ?? 0) > 0) {
      record.status = "running";
      record.iteration = run.record.iteration;
      record.note = null;
      record.variants = [];
      yield* run.save();
      yield* out(`▶ ${step.id} — over to you`);
      const choiceResult = yield* runChoiceStep(o, step, ctx).pipe(Effect.result);
      if (Result.isFailure(choiceResult)) {
        const error = choiceResult.failure;
        record.status = "failed";
        record.note =
          error instanceof HerdrError
            ? `${error.message}: ${error.detail}`
            : error instanceof Error
              ? error.message
              : String(error);
        yield* run.save();
        yield* out(`✗ ${step.id} — ${record.note}`);
        return yield* finish(o, "failed", viewSource);
      }
      const result: ChoiceResult = choiceResult.success;
      ctx.ran.add(step.id);
      record.status = result.status;
      record.note = result.note;
      yield* run.save();
      if (result.status !== "done") {
        return yield* finish(o, "blocked", viewSource, `${step.id} needs you`);
      }
      // A chained Run takes over from here, so the parent stops where it is.
      if (result.chained) {
        for (const s of wf.steps.slice(index + 1)) {
          const rec = run.step(s.id);
          if (rec.status === "pending") rec.note = `not run: ${result.note}`;
        }
        yield* run.save();
        return yield* finish(o, "done", viewSource, result.note ?? undefined);
      }
      index += 1;
      continue;
    }

    const variants = stepVariants(step, o.defaults);
    const keys = variantKeys(variants);
    record.status = "running";
    record.iteration = run.record.iteration;
    // A step that failed and is being tried again must not keep the old note.
    record.note = null;
    yield* run.save();
    yield* out(
      `▶ ${step.id}${variants.length > 1 ? ` (${variants.length} in parallel)` : ""} — iteration ${run.record.iteration}`,
    );

    const stepResult = yield* runStep(o, step, variants, keys, ctx, extras).pipe(Effect.result);
    if (Result.isFailure(stepResult)) {
      const error = stepResult.failure;
      record.status = "failed";
      record.note =
        error instanceof HerdrError
          ? `${error.message}: ${error.detail}`
          : error instanceof Error
            ? error.message
            : String(error);
      yield* run.save();
      yield* out(`✗ ${step.id} — ${record.note}`);
      return yield* finish(o, "failed", viewSource);
    }
    const outcomes: VariantOutcome[] = stepResult.success;
    ctx.ran.add(step.id);

    record.variants = outcomes.map((v) => v.record);
    ctx.outputs.set(step.id, outcomes);

    const blocked = outcomes.filter((v) => v.record.status !== "done");
    record.status = blocked.length > 0 ? "blocked" : "done";
    yield* run.save();

    for (const v of outcomes) {
      const mark = v.record.status === "done" ? "✓" : v.record.status === "failed" ? "✗" : "⚠";
      yield* out(`  ${mark} ${v.record.label}${v.record.error ? ` — ${v.record.error}` : ""}`);
    }
    yield* markTab(
      o,
      ctx,
      outcomes.map((v) => v.record),
    );
    // The whole point of a synthesis is that a human can read it here.
    if (step.fanIn) yield* printReview(o);

    if (blocked.length > 0) {
      return yield* finish(o, "blocked", viewSource, `${step.id} needs you`);
    }

    const gate = repeats.find((r) => r.from === index);
    if (gate) {
      const verdict = verdictOf(outcomes, run.record.disputed);
      // A reviewer that answered a dispute reopens it: the argument has moved on.
      if (verdict.rebutted.length > 0) {
        const answered = new Set(verdict.rebutted.map(findingKey));
        run.record.disputed = run.record.disputed.filter((d) => !answered.has(findingKey(d)));
        yield* run.save();
        yield* out(`  ${verdict.rebutted.length} disputed finding(s) answered by a reviewer`);
      }
      if (verdict.settled.length > 0) {
        yield* out(
          `  ${verdict.settled.length} finding(s) already disputed — your call, not the loop's`,
        );
      }
      if (verdict.clean) {
        yield* out(`  reviews clean — skipping ${wf.steps[gate.at]!.id}`);
        for (const s of wf.steps.slice(index + 1, gate.at + 1)) {
          const rec = run.step(s.id);
          rec.status = "done";
          rec.note = "skipped: reviews clean";
        }
        yield* run.save();
        index = gate.at + 1;
        continue;
      }
      yield* out(`  ${verdict.findings.length} finding(s) to fix`);
    }

    const mine = repeats.find((r) => r.at === index);
    if (mine) {
      if (run.record.iteration < mine.max) {
        run.record.iteration += 1;
        for (const s of wf.steps.slice(mine.back, index + 1)) {
          const rec = run.step(s.id);
          rec.status = "pending";
          rec.note = null;
        }
        yield* run.save();
        yield* out(
          `  looping back to ${wf.steps[mine.back]!.id} (iteration ${run.record.iteration})`,
        );
        index = mine.back;
        continue;
      }
      // Committing work the reviewers still object to would be worse than stopping.
      const still = verdictOf(ctx.outputs.get(wf.steps[mine.from]!.id) ?? [], run.record.disputed);
      run.record.outstanding = still.findings;
      run.step(step.id).note =
        `stopped at max_iterations ${mine.max} with ${still.findings.length} finding(s)`;
      yield* run.save();
      yield* out(`  max_iterations (${mine.max}) reached with ${still.findings.length} finding(s)`);
      return yield* finish(o, "blocked", viewSource, `max_iterations reached with findings`);
    }

    index += 1;
  }

  return yield* finish(o, "done", viewSource);
});

const runStep = Effect.fn("Engine.runStep")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  variants: Variant[],
  keys: (string | null)[],
  ctx: RunCtx,
  extraVars?: YamlMap,
) {
  const { herdr, run } = o;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // A step that has not run in this process gets fresh agents: a resumed Run
  // never reattaches, and the recorded panes may not exist any more.
  const previous = ctx.ran.has(step.id) ? run.step(step.id).variants : [];
  const fanIn = fanInPane(step, ctx);
  const records: VariantRecord[] = [];

  // Start (or reuse) every agent first, then prompt them all, so they work at once.
  for (const [i, variant] of variants.entries()) {
    const key = keys[i]!;
    const label = stepLabel(run.record.slug, step.id, key);
    const prior = previous[i] ?? borrowedAgent(o, step, ctx);
    const reuse = prior !== null && !step.fresh;
    const record: VariantRecord = {
      // A step that keeps an earlier agent runs on that agent's model, whatever its
      // own says: recording its own would name a model this step never ran on.
      harness: reuse ? prior!.harness : variant.harness,
      model: reuse ? prior!.model : variant.model,
      effort: (reuse ? prior!.effort : variant.effort) ?? null,
      agent: prior?.agent ?? agentName(run.record.slug, step.id, key, run.record.seq),
      label: prior?.label ?? label,
      tabId: prior?.tabId ?? null,
      paneId: prior?.paneId ?? null,
      status: "running",
      output: null,
      error: null,
    };

    // A pane says only what its tab cannot; a lone pane in its own tab says nothing.
    const paneName = paneLabel(variant, step.id, variants.length, !!step.fanIn);
    if (reuse) {
      // An `agent:` step opens nothing, and renames nothing: the pane it inherited
      // is alone in its tab, and the tab already names the run.
      if (paneName && record.paneId) yield* herdr.paneRename(record.paneId, paneName);
      if (record.tabId)
        yield* herdr.tabRename(record.tabId, runTab(o, ctx, record.tabId, GLYPH.running));
    } else {
      if (prior?.paneId) {
        // fresh: replace the pane so `agent start` sees a shell prompt again. The
        // replacement inherits the slot, so the step keeps its tab across iterations.
        const replacement = yield* herdr.paneSplit({
          paneId: prior.paneId,
          direction: "right",
          cwd: run.record.cwd,
        });
        yield* herdr.paneClose(prior.paneId);
        record.paneId = replacement;
        record.tabId = prior.tabId;
      } else if (i === 0 && fanIn) {
        // A fan-in step belongs with the Outputs it reconciles: under the last of
        // them, in their tab. A third column would only make all three unreadable.
        const source = fanIn;
        record.paneId = yield* herdr.paneSplit({
          paneId: source.paneId!,
          direction: "down",
          ratio: 0.5,
          cwd: run.record.cwd,
        });
        record.tabId = source.tabId;
      } else if (i > 0) {
        // Variants of one step sit side by side in that step's tab, evenly.
        record.paneId = yield* herdr.paneSplit({
          paneId: records[i - 1]!.paneId!,
          direction: "right",
          ratio: evenRatio(i, variants.length),
          cwd: run.record.cwd,
        });
        record.tabId = records[i - 1]!.tabId;
      } else {
        const name = yield* freeTabName(o, ctx, step);
        const tab = yield* herdr.tabCreate({
          label: tabLabel(GLYPH.running, name),
          cwd: run.record.cwd,
        });
        record.tabId = tab.tabId;
        record.paneId = tab.paneId;
        if (record.tabId) ctx.tabNames.set(record.tabId, name);
      }
      if (record.tabId)
        yield* herdr.tabRename(record.tabId, runTab(o, ctx, record.tabId, GLYPH.running));
      if (paneName && record.paneId) yield* herdr.paneRename(record.paneId, paneName);

      // herdr 0.7.5 ignores --cwd on tab create and pane split, so cd explicitly.
      if (record.paneId) yield* herdr.paneRun(record.paneId, `cd ${shellQuote(run.record.cwd)}`);

      const adapter = HARNESSES[variant.harness]!;
      yield* startAgent(o, step, {
        name: record.agent,
        kind: adapter.kind,
        paneId: record.paneId!,
        args: startArgs(
          adapter,
          variant.model,
          yield* personaFile(o, step, variant.harness),
          variant.effort,
        ),
      });
      if (record.paneId) {
        ctx.panes.push(record.paneId);
        yield* setView(o, ctx.viewSource, ctx.panes);
        // A group's first agent outlives its step, so the Session may hand it work.
        if (groupHead(o.wf, step.id)) yield* register(o, step, record);
      }
      // The first step of an `agent:` group lends its agent to the rest of it.
      if (step.agent && !ctx.groups.has(step.agent)) ctx.groups.set(step.agent, record);
    }

    records.push(record);
  }

  // Recorded as soon as they exist, not when the step ends: the Control Plane reads
  // its agents out of the run record, and a step that is still working — or one that
  // failed on its way — would otherwise have started agents nothing knows about.
  // Appended, because a Choice step's rounds accumulate here across the whole step.
  const recorded = run.step(step.id).variants;
  for (const record of records) if (!recorded.includes(record)) recorded.push(record);
  yield* run.save();

  // Only when a body asks: this costs herdr a round trip, and most steps do not.
  const vars = /\{\{\s*session\./.test(`${step.preamble}\n${step.prompt}`)
    ? { ...extraVars, session: { ask: yield* askRoute(sessionOf(o)) } }
    : extraVars;

  for (const [i, record] of records.entries()) {
    const variant = variants[i]!;
    const key = keys[i]!;
    // A multi-line prompt cannot be typed into a harness reliably, so the prompt
    // goes to a file in the run dir and the agent is pointed at it.
    const path = pathService.join(
      yield* run.stepDir(step.id, key),
      `prompt-${run.record.iteration}.md`,
    );
    yield* fs.writeFileString(
      path,
      `${yield* buildPrompt(o, step, variant, key, ctx.outputs, vars)}\n`,
    );
    yield* run.log(`prompt ${record.agent} -> ${pathService.relative(run.dir, path)}`);
    // A skill marked `disable-model-invocation` refuses an agent that invokes it
    // itself; `agent prompt` is the human's channel, so a slash command here runs.
    const command = step.skill ? `${skillFor(variants[i]!.harness).call(null, step.skill)} ` : "";
    yield* herdr.agentPrompt(
      record.agent,
      `${command}Your task for this step is in ${path} — read it and follow it.`,
    );
  }

  const outcomes: VariantOutcome[] = [];
  for (const [i, record] of records.entries()) {
    const key = keys[i]!;
    // The agent may settle before herdr reports `working`; that is not an error.
    yield* Effect.ignore(
      o.herdr.agentWait(record.agent, { until: ["working"], timeoutMs: 10_000 }),
    );
    yield* o.herdr.agentWait(record.agent, {
      until: ["idle", "done", "blocked"],
      timeoutMs: o.stepTimeoutMs,
    });
    outcomes.push(yield* collect(o, step, record, key));
  }
  return outcomes;
});

interface ChoiceResult {
  status: StepStatus;
  note: string | null;
  /** True when a child Run took over, so the parent should stop. */
  chained?: boolean;
}

/**
 * A Choice step: a menu in the runner pane instead of an agent. A `prompt` choice
 * runs one agent round and offers the menu again; `run` and `stop` end the step.
 */
const runChoiceStep = Effect.fn("Engine.runChoiceStep")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  ctx: RunCtx,
) {
  const { run, out } = o;
  const prompts = o.prompts;
  if (!prompts) {
    return choiceResult({
      status: "failed",
      note: `${step.id} needs a menu, and this run has no terminal`,
    });
  }
  const choices = step.choices ?? [];

  for (;;) {
    const taken = (title: string) =>
      run.record.choices.filter((c) => c.step === step.id && c.title === title).length;
    // What this Session and this environment can actually offer right now: a
    // hand-off needs its agent live, `unless:` needs it not to be, and `requires:`
    // is the same vocabulary a step uses.
    const offered: ChoiceDef[] = [];
    for (const choice of choices) {
      if (choice.max !== undefined && taken(choice.title) >= choice.max) continue;
      if (choice.handoff && !(yield* liveRole(sessionOf(o), choice.handoff))) continue;
      if (choice.unless && (yield* liveRole(sessionOf(o), choice.unless))) continue;
      if (choice.requires && (yield* unmetRequirement(o, choice.requires))) continue;
      offered.push(choice);
    }
    // Everything that could have done something is unavailable, so the only choices
    // left are endings: that is not a question worth asking. A menu authored as
    // endings — "stop here" or "carry on" — still is one.
    const lost = choices.filter((c) => !c.stop && !offered.includes(c));
    if (offered.every((c) => c.stop) && lost.length > 0) {
      const why = lost.map((c) => c.title).join(", ");
      yield* out(`◦ ${step.id} — nothing to decide (not available: ${why})`);
      return choiceResult({ status: "done", note: `skipped: nothing to decide (${why})` });
    }
    const items: PickItem[] = offered.map((c) => ({
      id: c.title,
      title: c.title,
      subtitle: choiceHint(c),
    }));

    yield* callAttention(o, ctx, `${step.id}: pick what happens next`, step.id);
    const picked = yield* prompts.menu(items, {
      header: `${run.record.slug} — ${step.id}`,
      footer: "↑↓ move · Enter choose · Esc leave the run open",
    });
    run.record.awaiting = null;
    yield* run.save();
    if (!picked) return choiceResult({ status: "blocked", note: "no choice taken" });

    const choice = offered.find((c) => c.title === picked.id)!;
    run.record.choices.push({ step: step.id, title: choice.title, at: yield* nowIso() });
    yield* run.save();
    yield* out(`  ▸ ${choice.title}`);

    if (choice.stop) return choiceResult({ status: "done", note: `chose "${choice.title}"` });

    if (choice.handoff) {
      const result = yield* handOff(o, choice.handoff);
      yield* out(`  ${result.message}`);
      yield* run.log(result.message);
      // A hand-off that did not land is not an answer, so the menu comes back.
      if (!result.ok) continue;
      return choiceResult({ status: "done", note: `chose "${choice.title}" — ${result.message}` });
    }

    if (choice.post) {
      const result = yield* postReview(o);
      yield* out(`  ${result.message}`);
      yield* run.log(result.message);
      // A note that did not land is not an answer, so the menu comes back.
      if (!result.ok) continue;
      return choiceResult({ status: "done", note: `chose "${choice.title}" — ${result.message}` });
    }

    if (choice.run) {
      const child = yield* chain(o, choice, prompts);
      if (!child) continue;
      return choiceResult({
        status: "done",
        note: `chose "${choice.title}" → ${choice.run} run ${child}`,
        chained: true,
      });
    }

    if (choice.config) yield* ensureConfig(o, prompts, choice.config);

    const round = choice.round!;
    const key = `${slugify(choice.title)}-${taken(choice.title)}`;
    // A round that rewrites the plan has to tell whoever is building from it.
    const before = yield* snapshotPlan(o, key);
    const first = yield* runRound(o, step, round, key, ctx);
    if (first.record.status !== "done") {
      yield* out(`  ⚠ ${first.record.label} — ${first.record.error ?? "did not finish"}`);
      continue;
    }
    yield* reportPlanChange(o, before, first.output);
    const findings = first.review?.findings ?? [];
    if (choice.followUp && findings.length > 0) {
      const next = yield* runRound(o, step, choice.followUp, `${key}-then`, ctx, {
        findings: formatFindings(findings),
      });
      if (next.record.status !== "done") {
        yield* out(`  ⚠ ${next.record.label} — ${next.record.error ?? "did not finish"}`);
      }
    }
  }
});

/**
 * Starts the chosen Workflow as a child Run in this workspace and links it to this
 * one. Returns null when the human abandoned it at a question, so the menu comes back.
 */
const chain = Effect.fn("Engine.chain")(function* (
  o: EngineOptions,
  choice: ChoiceDef,
  prompts: EnginePrompts,
) {
  const { run, out } = o;
  const child = resolveWorkflow(choice.run!, o.defs, o.defaults);
  const vars = {
    run: { dir: run.dir, id: run.id, slug: run.record.slug },
    inputs: run.record.inputs,
    cwd: run.record.cwd,
  };
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(choice.inputs ?? {})) {
    forwarded[key] = renderTemplate(value, vars).text;
  }

  const inputs: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const r of yield* inferInputs(child.inputs, {
    cwd: run.record.cwd,
    stateDir: o.env.stateDir,
  })) {
    if (forwarded[r.name] !== undefined) {
      inputs[r.name] = forwarded[r.name]!;
      sources[r.name] = `chained from ${run.id}`;
      // A forwarded Input still owes the prompts its kind, exactly as the picker would
      // have recorded it: the child's own body branches on it.
      if (r.strategy === "work-source")
        inputs[`${r.name}_kind`] = (yield* classifyWorkSource(forwarded[r.name]!)).kind;
      if (r.strategy === "diff-target") inputs[`${r.name}_kind`] = targetKind(forwarded[r.name]!);
      continue;
    }
    if (r.needsAsking) {
      // A work-source is chosen from what this repo offers; everything else is typed.
      if (r.candidates) {
        if (!(yield* resolveWorkSource(r, prompts))) {
          yield* out(`  ${choice.run} needs "${r.name}" — nothing started`);
          return null;
        }
      } else {
        const answer = yield* prompts.ask(r.question);
        if (answer === null || answer.trim() === "") {
          yield* out(`  ${choice.run} needs "${r.name}" — nothing started`);
          return null;
        }
        r.value = answer.trim();
        r.source = "asked";
      }
    }
    inputs[r.name] = r.value;
    sources[r.name] = r.source;
    if (r.kind) {
      inputs[`${r.name}_kind`] = r.kind;
      sources[`${r.name}_kind`] = r.source;
    }
  }

  // The parent already names the work, so the child inherits its name.
  const prefix = `${run.record.workflow}-`;
  const tail = run.record.slug.startsWith(prefix)
    ? run.record.slug.slice(prefix.length)
    : run.record.slug;
  const childRun = yield* new RunStore(o.env.stateDir).create({
    workflow: child.name,
    cwd: run.record.cwd,
    session: o.env.socketPath,
    workspace: o.env.workspaceId,
    // A child starts where its parent is, so it inherits the workspace it recorded.
    workspaceLabel: run.record.workspace_label,
    workspaceWorktree: run.record.workspace_worktree,
    inputs,
    inputSources: sources,
    stepIds: child.steps.map((s) => s.id),
    maxIterations: child.maxIterations,
    primaryInput: tail,
    parent: run.id,
  });
  yield* childRun.log(`chained from ${run.id}`);
  run.record.children.push(childRun.id);
  yield* run.save();
  yield* out(`  ▸ ${child.name} run ${childRun.id}`);

  yield* o.herdr.pluginPaneOpen({
    entrypoint: "runner",
    env: { COLLIE_RUN: childRun.id, COLLIE_CWD: run.record.cwd },
    focus: true,
    workspaceId: o.env.workspaceId,
    cwd: run.record.cwd,
  });
  return childRun.id;
});

/** One agent round inside a Choice: a Step in every way except its own id. */
const runRound = Effect.fn("Engine.runRound")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  round: RoundDef,
  key: string,
  ctx: RunCtx,
  extraVars?: YamlMap,
) {
  const synth: ResolvedStep = {
    ...round,
    id: step.id,
    persona: round.persona ?? step.persona,
    origin: step.origin,
    preamble: step.preamble,
    prompt: round.prompt,
    known: step.known,
    choices: undefined,
  };
  const variant = roundVariant(round, step, o.defaults);
  const outcomes = yield* runStep(o, synth, [variant], [key], ctx, extraVars);
  const outcome = outcomes[0]!;
  // runStep has already recorded it; a second push here would list it twice.
  ctx.outputs.set(step.id, [outcome]);
  yield* o.run.save();
  yield* markTab(o, ctx, [outcome.record]);
  return outcome;
});

/**
 * The review reaches the merge request as one note, and the engine sends it: asking
 * an agent to repeat a file it has already written is how "verbatim" stops being true.
 */
const postReview = Effect.fn("Engine.postReview")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(o.run.dir, REVIEW_FILE);
  if (!(yield* fs.exists(path)))
    return { ok: false, message: `there is no ${REVIEW_FILE} to post` };
  const target = o.run.record.inputs.target ?? "";
  const mr = parseMrTarget(target);
  if (!mr) return { ok: false, message: `${target || "this run"} is not a merge request` };

  // `--repo` is what lets this work from a directory that is not that checkout.
  const note = yield* shellRun(
    "glab",
    ["mr", "note", mr.iid, ...repoArgs(mr.project), "--message", yield* fs.readFileString(path)],
    o.run.record.cwd,
  );
  const where = mr.project ? `${mr.project}!${mr.iid}` : `!${mr.iid}`;
  return note.code === 0
    ? { ok: true, message: `posted the review to ${where}` }
    : { ok: false, message: `glab mr note ${where} failed (exit ${note.code})` };
});

function choiceHint(choice: ChoiceDef): string {
  if (choice.run) return `runs ${choice.run}`;
  if (choice.post) return "one note on the merge request";
  if (choice.handoff) return `to the ${choice.handoff} already working here`;
  if (choice.stop) return "ends here";
  return choice.round?.agent ? `prompts ${choice.round.agent}` : "a fresh agent";
}

const PLAN_DIR = "plan";

/**
 * A copy of the plan directory before a round touches it, so a change can be shown
 * as a diff afterwards. Null when this run has no plan of its own to change.
 */
const snapshotPlan = Effect.fn("Engine.snapshotPlan")(function* (o: EngineOptions, key: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const plan = pathService.join(o.run.dir, PLAN_DIR);
  if (!(yield* fs.exists(plan))) return null;
  const before = pathService.join(o.run.dir, "steps", "plan-before", key);
  return yield* Effect.gen(function* () {
    yield* fs.remove(before, { recursive: true, force: true });
    yield* fs.makeDirectory(before, { recursive: true });
    yield* fs.copy(plan, before);
    return before;
  }).pipe(Effect.catch((e) => o.run.log(`plan snapshot: ${reason(e)}`).pipe(Effect.as(null))));
});

/**
 * Once per change, and only when someone is building from this plan: the diff of
 * `plan/` and whatever the planner said it did.
 */
const reportPlanChange = Effect.fn("Engine.reportPlanChange")(function* (
  o: EngineOptions,
  before: string | null,
  output: YamlValue | null,
) {
  if (!before) return;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const plan = pathService.join(o.run.dir, PLAN_DIR);
  // `git diff --no-index` exits 1 when the two differ, which is how "changed" is read.
  const diff = yield* shellRun(
    "git",
    ["diff", "--no-index", "--no-color", "--", before, plan],
    o.run.record.cwd,
  );
  if (diff.code === 0 || diff.stdout.trim() === "") return;

  const path = pathService.join(before, "..", `${pathService.basename(before)}.patch`);
  yield* fs.writeFileString(path, diff.stdout);
  const changelog = isYamlMap(output) && isString(output.changelog) ? output.changelog : "";
  const result = handoffResult(
    yield* sendPlanChange(sessionOf(o), o.run, {
      planDir: plan,
      diff: path,
      changelog,
    }),
    "could not send the plan change",
  );
  yield* o.run.log(`plan changed: ${result.message}`);
  if (result.ok) yield* o.out(`  ▸ ${result.message}`);
});

/** This Run's Session, as the register and the hand-offs key it. */
function sessionOf(o: EngineOptions): Session {
  return {
    herdr: o.herdr,
    stateDir: o.env.stateDir,
    ...scopeFor(o.env, o.run.record.cwd),
  };
}

/** Gives this Run's review to the Session's live agent for that role. */
const handOff = Effect.fn("Engine.handOff")(function* (o: EngineOptions, role: string) {
  if (role !== "implementer") return { ok: false, message: `nothing to hand to a ${role}` };
  return handoffResult(yield* sendReview(sessionOf(o), o.run), "could not send the review");
});

/** A value the human is asked for once and that stays in config.json. */
const ensureConfig = Effect.fn("Engine.ensureConfig")(function* (
  o: EngineOptions,
  prompts: EnginePrompts,
  cfg: { key: string; question: string },
) {
  if (configValue(yield* readConfig(o.env.configDir), cfg.key) !== undefined) return;
  const answer = yield* prompts.ask(cfg.question);
  if (answer === null || answer.trim() === "") return;
  yield* writeConfigValue(o.env.configDir, cfg.key, answer.trim());
  yield* o.out(`  saved ${cfg.key} in config.json`);
});

/** A step some later step continues, i.e. the one that starts a long-lived agent. */
function groupHead(wf: ResolvedWorkflow, stepId: string): boolean {
  return wf.steps.some((s) => s.agent === stepId);
}

/** Puts one long-lived agent on the Session's register, for a later Run to find. */
const register = Effect.fn("Engine.register")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  record: VariantRecord,
) {
  const path = yield* registryPath(o.env.stateDir, scopeFor(o.env, o.run.record.cwd));
  yield* Effect.gen(function* () {
    yield* registerAgent(path, {
      role: step.persona ?? step.id,
      agent: record.agent,
      paneId: record.paneId!,
      workspaceId: o.env.workspaceId,
      runId: o.run.id,
      workflow: o.run.record.workflow,
      at: yield* nowIso(),
    });
    yield* o.run.log(`registered ${record.agent} as ${step.persona ?? step.id}`);
  }).pipe(
    // A register nobody can write is a hand-off nobody gets, not a failed run.
    Effect.catch((e) => o.run.log(`register ${record.agent} failed: ${reason(e)}`)),
  );
});

/**
 * The Session's own tab, found by its label and created when it is not there, and
 * moved to the front of the workspace either way. It is the only pane this plugin
 * keeps open in a workspace: the driver has no pane, and every question it asks is
 * rendered there. Returns the tab id, or null when there is no workspace to own one.
 */
const ensureWorkspaceTab = Effect.fn("Engine.ensureWorkspaceTab")(function* (o: EngineOptions) {
  return yield* Effect.gen(function* () {
    const view = yield* findOrOpenView(o);
    if (!view) return null;
    // First tab, every run: the Session's board is where `prefix+1` should land,
    // and a tab that drifts down the list is one the human stops looking at.
    yield* o.herdr
      .tabMove(view.tabId, 0)
      .pipe(Effect.catch((e) => o.run.log(`workspace tab order: ${reason(e)}`)));
    return view.tabId;
  }).pipe(
    // Without the tab the run still runs; it just has nowhere to ask.
    Effect.catch((e) => o.run.log(`workspace tab: ${reason(e)}`).pipe(Effect.as(null))),
  );
});

const findOrOpenView = Effect.fn("Engine.findOrOpenView")(function* (o: EngineOptions) {
  if (!o.env.workspaceId) return null;
  const open = Effect.fn("Engine.openWorkspaceView")(function* (
    placement: "tab" | "split",
    targetPaneId?: string,
  ) {
    const opened = yield* o.herdr.pluginPaneOpen({
      entrypoint: "workspace",
      placement,
      targetPaneId,
      direction: placement === "split" ? "down" : undefined,
      focus: false,
      workspaceId: o.env.workspaceId,
      cwd: o.run.record.cwd,
      env: { COLLIE_CWD: o.run.record.cwd },
    });
    if (!opened.paneId) return null;
    yield* o.herdr.paneRename(opened.paneId, CONTROL_PLANE);
    return opened;
  });

  const tab = (yield* o.herdr.tabList()).find((t) => t.label === CONTROL_PLANE);
  if (!tab) {
    const opened = yield* open("tab");
    if (!opened?.tabId) return null;
    yield* o.herdr.tabRename(opened.tabId, CONTROL_PLANE);
    return opened;
  }
  // The tab is there; its view pane may not be, if someone closed just that pane.
  const panes = (yield* o.herdr.paneList()).filter((p) => p.tabId === tab.tabId);
  const view = panes.find((p) => p.label === CONTROL_PLANE);
  if (view) return { tabId: tab.tabId, paneId: view.paneId };
  if (panes.length === 0) return null;
  const opened = yield* open("split", panes[0]!.paneId);
  return opened ? { tabId: tab.tabId, paneId: opened.paneId } : null;
});

/**
 * A question nobody sees is a run that has silently stopped, so it is said
 * twice: a toast, and the Session's tab brought to the front.
 */
const callAttention = Effect.fn("Engine.callAttention")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  detail: string,
  stepId: string,
) {
  o.run.record.awaiting = stepId;
  yield* o.run.save();
  // A missing toast must not fail the run.
  yield* Effect.ignore(o.herdr.notify(`${o.run.record.slug} needs you`, detail, "request"));
  if (!ctx.workspaceTabId) return;
  // A tab that will not focus is still a tab the human can reach.
  yield* Effect.ignore(o.herdr.tabFocus(ctx.workspaceTabId));
});

/**
 * A harness that asks before it will work in a directory asks in its own pane, where
 * it is easy to miss and impossible to answer for someone else. So the question is put
 * here instead, once per directory, before a single tab opens.
 */
const ensureTrusted = Effect.fn("Engine.ensureTrusted")(function* (o: EngineOptions) {
  if (o.defaults.trust === "never") return;
  const cwd = o.run.record.cwd;
  const seen = new Set<string>();

  for (const step of o.wf.steps) {
    for (const variant of stepVariants(step, o.defaults)) {
      if (seen.has(variant.harness)) continue;
      seen.add(variant.harness);
      const trust = HARNESSES[variant.harness]?.trust?.(o.env.home, o.env.stateDir);
      if (!trust || (yield* trust.state(cwd)) !== "untrusted") continue;

      if (o.defaults.trust === "ask") {
        if (!o.prompts) continue;
        const answer = yield* o.prompts!.menu(
          [
            {
              id: "trust",
              title: "Trust it now",
              subtitle: "records it where the harness looks",
            },
            {
              id: "ask",
              title: "Let claude ask me in its tab",
              subtitle: "the run waits for you",
            },
          ],
          {
            header: `${variant.harness} has not worked in ${cwd} before`,
            footer: "↑↓ move · Enter choose",
          },
        );
        if (answer?.id !== "trust") continue;
      }
      const result = yield* trust.grant(cwd);
      yield* o.out(`  ${result.message}`);
      yield* o.run.log(`trust ${variant.harness}: ${result.message}`);
    }
  }
});

/** herdr says this when the harness stopped on a prompt before it was ready to work. */
function blockedAtStartup(e: HerdrError): boolean {
  return /agent_not_ready|blocked during startup/.test(e.detail);
}

/**
 * herdr says this when the pane exists but its shell has not come up yet. A pane
 * split and `cd`-ed a moment ago is sometimes still starting, which killed two live
 * runs at the fan-in step before this was here.
 */
function paneNotReady(e: HerdrError): boolean {
  return /agent_pane_busy|not an available shell/.test(e.detail);
}

/**
 * A harness may stop on a first-run prompt — claude asks before it will work in a
 * directory it has not been trusted with, and the dialog cannot be answered from here:
 * it shuffles its options, so there is no safe key to send. The agent exists and is
 * blocked, so this waits for the human exactly as a Step waits for an Output.
 */
const startAgent = Effect.fn("Engine.startAgent")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  opts: { name: string; kind: string; paneId: string; args: string[] },
) {
  const startError = yield* startWhenReady(o, opts).pipe(
    Effect.as(Option.none<HerdrError>()),
    Effect.catchTag("HerdrError", (error) => Effect.succeed(Option.some(error))),
  );
  if (Option.isNone(startError)) return;
  const error = startError.value;
  if (!blockedAtStartup(error)) return yield* Effect.fail(error);

  const budget = o.handoffTimeoutMs ?? 0;
  yield* o.out(`  ⏸ ${opts.name} is waiting for you in its pane — answer the prompt there`);
  yield* o.run.log(`${opts.name}: blocked at startup, waiting for the human`);
  o.run.record.awaiting = step.id;
  yield* o.run.save();
  yield* o.herdr
    .notify(
      `${o.run.record.slug} needs you`,
      `${step.id}: answer the prompt in its pane`,
      "request",
    )
    .pipe(Effect.catchTag("HerdrError", () => Effect.void));

  const deadline = (yield* nowMillis()) + budget;
  while ((yield* nowMillis()) < deadline) {
    yield* Effect.sleep(
      Math.min(o.outputPollMs ?? 2000, Math.max(1, deadline - (yield* nowMillis()))),
    );
    if ((yield* o.herdr.agentStatus(opts.name)) !== "blocked") {
      yield* o.out(`  ▸ ${opts.name} is ready`);
      o.run.record.awaiting = null;
      yield* o.run.save();
      return;
    }
  }
  return yield* Effect.fail(error);
});

/** `agent start`, waiting out a pane whose shell is still coming up. */
const startWhenReady = Effect.fn("Engine.startWhenReady")(function* (
  o: EngineOptions,
  opts: { name: string; kind: string; paneId: string; args: string[] },
) {
  const tries = 6;
  for (let attempt = 1; ; attempt++) {
    const failure = yield* o.herdr.agentStart(opts).pipe(
      Effect.as(Option.none<HerdrError>()),
      Effect.catchTag("HerdrError", (error) => Effect.succeed(Option.some(error))),
    );
    if (Option.isNone(failure)) return;
    const error = failure.value;
    if (!paneNotReady(error) || attempt === tries) return yield* Effect.fail(error);
    yield* o.run.log(
      `${opts.name}: pane ${opts.paneId} is not a shell yet, retrying (${attempt}/${tries})`,
    );
    yield* Effect.sleep(Math.min(o.outputPollMs ?? 1000, 1000));
  }
});

/**
 * A settled agent does not mean a finished Step: an interviewing agent goes idle
 * waiting for the human. The Output file is the completion signal, so keep
 * waiting for it and toast once so the human knows they are needed.
 */
const awaitOutput = Effect.fn("Engine.awaitOutput")(function* (
  o: EngineOptions,
  agent: string,
  stepId: string,
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* fs.exists(path)) return;
  const budget = o.handoffTimeoutMs ?? 0;
  if (budget <= 0) return;

  yield* o.out(`  ⏸ ${agent} is waiting for you in its tab`);
  o.run.record.awaiting = stepId;
  yield* o.run.save();
  // A missing toast must not fail the run.
  yield* Effect.ignore(
    o.herdr.notify(
      `${o.run.record.slug} needs you`,
      `${stepId}: answer the agent in its tab`,
      "request",
    ),
  );
  const poll = o.outputPollMs ?? 2000;
  const deadline = (yield* nowMillis()) + budget;
  while (!(yield* fs.exists(path)) && (yield* nowMillis()) < deadline) {
    yield* Effect.sleep(Math.min(poll, Math.max(1, deadline - (yield* nowMillis()))));
  }
  if (yield* fs.exists(path)) yield* o.out(`  ▸ ${agent} produced its Output`);
  o.run.record.awaiting = null;
  yield* o.run.save();
});

const collect = Effect.fn("Engine.collect")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  record: VariantRecord,
  variantKey: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  if (!step.output) {
    const status = yield* o.herdr.agentStatus(record.agent);
    record.status = status === "blocked" ? "blocked" : "done";
    if (record.status === "blocked") record.error = "agent is blocked and needs input";
    return { record, output: null, review: null };
  }

  const path = yield* o.run.outputPath(step.id, variantKey, step.output);
  record.output = pathService.relative(o.run.dir, path);
  yield* awaitOutput(o, record.agent, step.id, path);
  if (!(yield* fs.exists(path))) {
    record.status = "blocked";
    record.error = `no Output at ${record.output}`;
    return { record, output: null, review: null };
  }

  const text = yield* fs.readFileString(path);
  let parsed: YamlValue;
  try {
    parsed = Schema.decodeUnknownSync(JsonValue)(text);
  } catch (e) {
    record.status = "failed";
    record.error = `${record.output}: not valid JSON (${e instanceof Error ? e.message : String(e)})`;
    return { record, output: null, review: null };
  }

  const hasVerdict = isYamlMap(parsed) && "verdict" in parsed;
  if (step.fanIn && !hasVerdict) {
    record.status = "failed";
    record.error = `${record.output}: a fan-in Output needs a verdict`;
    return { record, output: parsed, review: null };
  }

  let review: ReviewOutput | null = null;
  if (hasVerdict && step.fanIn) {
    const result = parseSynthesis(text, record.output);
    if (!result.ok) {
      record.status = "failed";
      record.error = result.error;
      return { record, output: parsed, review: null };
    }
    review = result.value;
    yield* fs.writeFileString(pathService.join(o.run.dir, REVIEW_FILE), renderReview(result.value));
    // A hand-off gives the implementer both the prose and the findings it came from.
    o.run.record.synthesis = record.output;
  } else if (hasVerdict) {
    const result = parseReviewOutput(text, record.output);
    if (!result.ok) {
      record.status = "failed";
      record.error = result.error;
      return { record, output: parsed, review: null };
    }
    review = result.value;
  }
  if (review) {
    // The shape of a review is the engine's to decide, so every one reads alike.
    collectList(o, "deferred", parsed);
    collectMr(o, parsed);
    // A re-run step must not double-report what it disputed last time.
    for (const finding of review.disputed) {
      const key = findingKey(finding);
      if (!o.run.record.disputed.some((d) => findingKey(d) === key)) {
        o.run.record.disputed.push(finding);
      }
    }
  }

  record.status = "done";
  return { record, output: parsed, review };
});

/** A tab keeps the name it was given; only the glyph moves. */
function runTab(o: EngineOptions, ctx: RunCtx, tabId: string | null, glyph: string): string {
  const name = (tabId && ctx.tabNames.get(tabId)) ?? o.run.record.workflow;
  return tabLabel(glyph, name);
}

/**
 * What to call a new tab: the workflow for the run's own first tab, the step for
 * every tab after it. Where a live tab in this workspace already carries that
 * name — another run of the same workflow — the target is appended to tell them
 * apart, which is the only place a target appears on a tab.
 */
const freeTabName = Effect.fn("Engine.freeTabName")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  step: ResolvedStep,
) {
  const plain = ctx.tabNames.size === 0 ? o.run.record.workflow : step.id;
  let taken: string[] = [];
  // Without the list a plain name is the better guess than a decorated one.
  taken = yield* o.herdr.tabList().pipe(
    Effect.map((tabs) => tabs.map((t) => tabNameOf(t.label))),
    Effect.catch((e) => o.run.log(`tab names: ${reason(e)}`).pipe(Effect.as(taken))),
  );
  // Compared as a human reads them, so the capitalisation cannot hide a collision.
  if (!taken.includes(displayName(plain))) return plain;
  return disambiguate(plain, runTarget(o.wf, o.run.record));
});

/**
 * A target names the run only where the workflow owns it. `implement` inherits
 * `target` from the review it embeds, and is not "implement · worktree" — it is
 * whatever it is building.
 */
export function runTarget(
  wf: { name: string; embeddedInputs: string[] },
  record: { workflow: string; slug: string; inputs: Record<string, string> },
): string {
  const own = !wf.embeddedInputs.includes("target");
  return targetLabel(record.workflow, record.slug, own ? record.inputs : {});
}

/** The MR step reports what it opened; the summary is where the human looks for it. */
function collectMr(o: EngineOptions, parsed: YamlValue): void {
  if (!isYamlMap(parsed)) return;
  if (isString(parsed.mr_url) && parsed.mr_url.trim() !== "")
    o.run.record.mr_url = parsed.mr_url.trim();
  if (Array.isArray(parsed.linear_issues)) {
    for (const id of parsed.linear_issues) {
      if (isString(id) && id !== "" && !o.run.record.linear_issues.includes(id)) {
        o.run.record.linear_issues.push(id);
      }
    }
  }
}

/** What the MR prompt is given: never null, so a missing value reads as a gap, not "undefined". */
function mrVars(facts: MrFacts): YamlMap {
  return {
    mr: {
      assignee: facts.assignee ?? "",
      template: facts.template ?? "",
      issues: facts.issues.join(", "),
      has_issues: facts.issues.length > 0 ? "yes" : "no",
    },
  };
}

/** Appends an Output's `deferred` entries to the run, without repeating one. */
function collectList(o: EngineOptions, key: "deferred", parsed: YamlValue): void {
  if (!isYamlMap(parsed)) return;
  const raw = parsed[key];
  if (!Array.isArray(raw)) return;
  const result = parseFindings(raw, `${key}`);
  if (!result.ok) return;
  for (const finding of result.value) {
    const id = findingKey(finding);
    if (!o.run.record[key].some((f) => findingKey(f) === id)) o.run.record[key].push(finding);
  }
}

/** Whether this run can give a step what it declared it needs, and why not. */
const unmetRequirement = Effect.fn("Engine.unmetRequirement")(function* (
  o: EngineOptions,
  requires: StepRequirement[],
) {
  const target = o.run.record.inputs.target ?? "";
  for (const need of requires) {
    if (need === "gitlab") {
      // A step pointed at a merge request needs glab for that project; a step that
      // pushes needs this directory to be the checkout. `mr-target` says which.
      const mr = requires.includes("mr-target") ? parseMrTarget(target) : null;
      const ready = yield* mr
        ? gitlabForProject(mr.project, o.run.record.cwd, runShell)
        : gitlabReadiness(o.run.record.cwd, runShell);
      if (!ready.ok) return ready.reason;
    }
    if (need === "mr-target" && o.run.record.inputs.target_kind !== "mr") {
      return `${target || "this run"} is not a merge request`;
    }
  }
  return null;
});

/** The pane a fan-in step splits from: the last of the Outputs it reconciles. */
function fanInPane(step: ResolvedStep, ctx: RunCtx): VariantRecord | null {
  if (!step.fanIn) return null;
  const source = ctx.outputs.get(step.fanIn)?.at(-1)?.record;
  return source?.paneId ? source : null;
}

/** The Output files a fan-in step reconciles, for its own prompt to read. */
const fanInFiles = Effect.fn("Engine.fanInFiles")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  outputs: Map<string, VariantOutcome[]>,
) {
  if (!step.fanIn) return "";
  const pathService = yield* Path.Path;
  return (outputs.get(step.fanIn) ?? [])
    .map((v) => (v.record.output ? `- ${pathService.join(o.run.dir, v.record.output)}` : null))
    .filter((line): line is string => line !== null)
    .join("\n");
});

/** The synthesised review, in the run's own pane, where the human is already looking. */
const printReview = Effect.fn("Engine.printReview")(function* (o: EngineOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = pathService.join(o.run.dir, REVIEW_FILE);
  if (!(yield* fs.exists(path))) return;
  yield* o.out("");
  yield* o.out((yield* fs.readFileString(path)).trimEnd());
  yield* o.out("");
});

/** The agent of an earlier step, but only one this process actually started. */
function borrowedAgent(o: EngineOptions, step: ResolvedStep, ctx: RunCtx): VariantRecord | null {
  if (!step.agent) return null;
  if (ctx.ran.has(step.agent)) return o.run.step(step.agent).variants[0] ?? null;
  // On a resumed run the named step is long gone; the group's first agent stands in.
  return ctx.groups.get(step.agent) ?? null;
}

/** A Persona as the harness that will read it sees it, skills and all. */
function personaBody(o: EngineOptions, step: ResolvedStep, harness: string): string {
  const raw = step.persona ? (o.defs.personas.get(step.persona)?.body ?? "") : "";
  if (raw === "") return "";
  return renderTemplate(raw, {}, { skill: skillFor(harness) }).text;
}

/**
 * The Persona as a file, since herdr will not pass multi-line agent arguments. One
 * file per harness: the same persona asks for its skills in that harness's syntax,
 * and the run dir should show what each agent was actually given.
 */
const personaFile = Effect.fn("Engine.personaFile")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  harness: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* o.run.personaPath(step.persona ?? "none", harness);
  yield* fs.writeFileString(path, `${personaBody(o, step, harness)}\n`);
  return path;
});

/** How one harness is asked for a skill; unknown harnesses fall back to claude's. */
function skillFor(harness: string): (name: string) => string {
  const adapter = HARNESSES[harness];
  return (name) => (adapter ? adapter.skillRef(name) : `/${name}`);
}

const buildPrompt = Effect.fn("Engine.buildPrompt")(function* (
  o: EngineOptions,
  step: ResolvedStep,
  variant: Variant,
  variantKey: string | null,
  outputs: Map<string, VariantOutcome[]>,
  extraVars?: YamlMap,
) {
  const adapter = HARNESSES[variant.harness]!;
  const outputPath = step.output ? yield* o.run.outputPath(step.id, variantKey, step.output) : "";
  const vars: YamlMap = {
    inputs: o.run.record.inputs,
    outputs: Schema.decodeUnknownSync(YamlMapSchema)(
      Object.fromEntries(
        [...outputs.entries()].map(([id, list]) => [
          id,
          list.length === 1 ? list[0]!.output : list.map((v) => v.output),
        ]),
      ),
    ),
    findings: formatFindings(lastFindings(o, step, outputs)),
    // `--repo <project>` for an MR target, so a prompt can be followed from anywhere.
    target_repo: repoArgs(parseMrTarget(o.run.record.inputs.target ?? "")?.project ?? null).join(
      " ",
    ),
    fan_in: yield* fanInFiles(o, step, outputs),
    disputed: formatFindings(o.run.record.disputed),
    run: { dir: o.run.dir, id: o.run.id, slug: o.run.record.slug },
    output_path: outputPath,
    iteration: String(o.run.record.iteration),
    max_iterations: String(o.run.record.max_iterations),
    cwd: o.run.record.cwd,
    step: step.id,
    harness: variant.harness,
    model: variant.model,
    effort: variant.effort ?? "",
    config: yield* readConfig(o.env.configDir),
    ...extraVars,
  };

  const parts: string[] = [];
  const prefix = personaPrefix(adapter, personaBody(o, step, variant.harness));
  if (prefix) parts.push(prefix);
  const rendered = renderTemplate(
    [step.preamble, step.prompt].filter((p) => p.trim()).join("\n\n"),
    vars,
    { skill: skillFor(variant.harness) },
  );
  if (rendered.missing.length > 0) {
    yield* o.run.log(`unknown template keys in ${step.id}: ${rendered.missing.join(", ")}`);
  }
  parts.push(rendered.text);
  if (outputPath) {
    parts.push(
      `When you are done, write your result as JSON to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${outputPath}`,
    );
  }
  return parts.join("\n\n");
});

function lastFindings(
  o: EngineOptions,
  step: ResolvedStep,
  outputs: Map<string, VariantOutcome[]>,
): Finding[] {
  const from = step.repeat?.from;
  const source = from ? outputs.get(from) : undefined;
  return source ? verdictOf(source, o.run.record.disputed).findings : [];
}

interface Verdict {
  clean: boolean;
  /** What the fix step gets: everything except what is already settled. */
  findings: Finding[];
  settled: Finding[];
  rebutted: Finding[];
}

function verdictOf(outcomes: VariantOutcome[], disputed: Finding[]): Verdict {
  const reviews = outcomes.map((v) => v.review).filter((r): r is ReviewOutput => r !== null);
  // The gate reads one synthesised review: reconciling several reviewers is the
  // synthesiser's job now, not a union taken here.
  const split = splitDisputed(
    reviews.flatMap((r) => r.findings),
    disputed,
  );
  // Clean means "nothing left for the implementer", not "nobody said anything":
  // a finding the implementer already rejected with a reason is the human's call.
  return {
    clean: reviews.length > 0 && split.live.length === 0,
    findings: split.live,
    settled: split.settled,
    rebutted: split.rebutted,
  };
}

/**
 * The step's tab wears the state of every pane in it: ✓ only once they are all
 * done, ✗ when one stopped, ⚠ when one is waiting for the human.
 */
const markTab = Effect.fn("Engine.markTab")(function* (
  o: EngineOptions,
  ctx: RunCtx,
  records: VariantRecord[],
) {
  const glyph = records.every((r) => r.status === "done")
    ? GLYPH.done
    : records.some((r) => r.status === "failed")
      ? GLYPH.failed
      : records.some((r) => r.status === "blocked")
        ? GLYPH.waiting
        : GLYPH.running;
  for (const tabId of new Set(records.map((r) => r.tabId).filter((t): t is string => !!t))) {
    yield* o.herdr.tabRename(tabId, runTab(o, ctx, tabId, glyph));
  }
});

const setView = Effect.fn("Engine.setView")(function* (
  o: EngineOptions,
  source: string,
  panes: string[],
) {
  // A filtered sidebar is a nicety; losing it must not fail the run.
  yield* o.herdr
    .agentViewSet(source, o.run.record.slug, panes)
    .pipe(Effect.catch((e) => o.run.log(`agent.view.set failed: ${reason(e)}`)));
});

const finish = Effect.fn("Engine.finish")(function* (
  o: EngineOptions,
  status: RunStatus,
  viewSource: string,
  detail?: string,
) {
  const { run, out } = o;
  run.record.status = status;
  run.record.finished_at = yield* nowIso();
  run.record.awaiting = null;
  run.record.summary = summarise(o, status);
  yield* run.save();
  yield* out("");
  yield* out(run.record.summary);
  // The sidebar filter is a nicety.
  yield* Effect.ignore(o.herdr.agentViewClear(viewSource));
  const title = status === "done" ? `${run.record.slug} finished` : `${run.record.slug} ${status}`;
  // A missing toast must not fail the run.
  yield* Effect.ignore(
    o.herdr.notify(
      title,
      detail ?? run.record.summary.split("\n")[0],
      status === "done" ? "done" : "request",
    ),
  );
  return status;
});

export function summarise(o: EngineOptions, status: RunStatus): string {
  const { run } = o;
  const lines = [`Run ${run.id} — ${status} after ${run.record.iteration} iteration(s)`];
  for (const step of run.record.steps) {
    const marks = {
      pending: "·",
      running: "…",
      done: "✓",
      blocked: "⚠",
      failed: "✗",
    } satisfies Record<StepStatus, string>;
    const detail = step.note ? ` (${step.note})` : "";
    const errors = step.variants
      .filter((v) => v.error)
      .map((v) => `\n    ${v.label}: ${v.error}`)
      .join("");
    lines.push(`  ${marks[step.status]} ${step.id}${detail}${errors}`);
  }
  if (run.record.outstanding.length > 0) {
    lines.push("", "Findings still open:", formatFindings(run.record.outstanding));
  }
  if (run.record.choices.length > 0) {
    lines.push("", "Choices:", ...run.record.choices.map((c) => `  ${c.step}: ${c.title}`));
  }
  if (run.record.children.length > 0) {
    lines.push("", `Chained: ${run.record.children.join(", ")}`);
  }
  if (run.record.mr_url) {
    const tickets =
      run.record.linear_issues.length > 0 ? ` (${run.record.linear_issues.join(", ")})` : "";
    lines.push("", `Merge request: ${run.record.mr_url}${tickets}`);
  }
  if (run.record.deferred.length > 0) {
    lines.push(
      "",
      "Deferred (the architect did not apply these):",
      formatFindings(run.record.deferred),
    );
  }
  if (run.record.disputed.length > 0) {
    lines.push(
      "",
      "Disputed findings (the implementer did not apply these; the loop stopped arguing about them):",
      formatFindings(run.record.disputed),
    );
  }
  return lines.join("\n");
}
