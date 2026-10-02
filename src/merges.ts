// What GitLab and GitHub say about the merge requests the board is waiting on, asked in
// the background and never from a render: a merge the human did on the forge is the
// strongest signal that the work landed, so Collie records the disposition itself. The
// forge's own checks are kept beside the state, for the card to say whether it is ready.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  mrLabel,
  sectionOf,
  type ForgeChecks,
  type ForgeFacts,
  type MrState,
  type TaskView,
} from "./board";
import { latest, readDispositions, recordDisposition } from "./disposition";
import { liveTier, mrDetails, parseMrTarget, type MrRef, type Runner } from "./mr";
import { runDir } from "./engine";
import { nowIso } from "./time";

/** How long one merge request's answer stands before GitLab is asked again. */
export const MERGE_POLL_MS = 5 * 60_000;

/** Where the CLI's board reads what the pane's watch last learned. */
export const MR_STATES_FILE = "board/mr-states.json";

const StateSchema = Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]);
const ForgeChecksSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["passed", "running", "unknown"]) }),
  Schema.Struct({ state: Schema.Literal("failed"), name: Schema.String }),
]);
const EntrySchema = Schema.Struct({
  state: StateSchema,
  checks: Schema.optionalKey(ForgeChecksSchema),
  head: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const StatesJson = Schema.fromJsonString(Schema.Record(Schema.String, EntrySchema));
/** The shape written before checks were kept: a bare state per merge request. */
const OldStatesJson = Schema.fromJsonString(Schema.Record(Schema.String, StateSchema));
type Entry = typeof EntrySchema.Type;

/** GitLab's head pipeline status, as the card reads it. */
export function pipelineChecks(status: string): ForgeChecks {
  if (status === "success" || status === "passed") return { state: "passed" };
  if (status === "failed") return { state: "failed", name: "pipeline" };
  if (
    ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(
      status,
    )
  )
    return { state: "running" };
  return { state: "unknown" };
}

/** `https://github.com/owner/repo/pull/30` as its repository and number. */
export function pullOf(mr: string): { readonly repo: string; readonly number: string } | null {
  const pull = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(mr);
  return pull ? { repo: pull[1]!, number: pull[2]! } : null;
}

const PullJson = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    headRefOid: Schema.optionalKey(Schema.NullOr(Schema.String)),
    mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
    statusCheckRollup: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            name: Schema.optionalKey(Schema.NullOr(Schema.String)),
            context: Schema.optionalKey(Schema.NullOr(Schema.String)),
            status: Schema.optionalKey(Schema.NullOr(Schema.String)),
            conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
            state: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
);
type Pull = typeof PullJson.Type;

const RED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** A pull request's check rollup: a check run's conclusion, or a status context's state. */
export function rollupChecks(rollup: Pull["statusCheckRollup"]): ForgeChecks {
  const checks = rollup ?? [];
  if (checks.length === 0) return { state: "unknown" };
  const verdicts = checks.map((one) => ({
    name: one.name ?? one.context ?? "a check",
    // A check run has a conclusion once it completes; a status context has only a state.
    said:
      one.conclusion ??
      (one.status != null && one.status !== "COMPLETED" ? "PENDING" : (one.state ?? "PENDING")),
  }));
  const red = verdicts.find((one) => RED.has(one.said));
  if (red !== undefined) return { state: "failed", name: red.name };
  if (verdicts.some((one) => !GREEN.has(one.said))) return { state: "running" };
  return { state: "passed" };
}

/** What `gh` says about one pull request, or null where it cannot be asked: no gh, no login. */
const pullFacts = Effect.fn("Merges.pullFacts")(function* <R>(
  pull: { readonly repo: string; readonly number: string },
  cwd: string,
  run: Runner<R>,
) {
  const view = yield* run(
    "gh",
    [
      "pr",
      "view",
      pull.number,
      "--repo",
      pull.repo,
      "--json",
      "state,mergeCommit,headRefOid,statusCheckRollup",
    ],
    cwd,
  );
  if (view.code !== 0) return null;
  return Option.getOrNull(Schema.decodeUnknownOption(PullJson)(view.stdout));
});

/** `https://host/group/project/-/merge_requests/42` or `mr:host/group/project!42` as one ref. */
export function mrRefOf(mr: string): MrRef | null {
  const url = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(mr);
  if (url) return { project: `${url[1]}/${url[2]}`, iid: url[3]! };
  return parseMrTarget(mr.startsWith("mr:") ? mr : `mr:${mr}`);
}

function stateOf(state: string): MrState {
  const said = state.toLowerCase();
  if (said === "merged") return "merged";
  if (said === "closed") return "closed";
  return "open";
}

/**
 * One round: every Task waiting on a merge request whose answer is stale is asked about,
 * a merged one gets its `merged` disposition recorded as GitLab's word, and what was
 * learned is written where `collie --json board` reads it. `checked` and `states` are the
 * caller's memory between rounds; the file is everyone else's.
 */
export const settleMerges = Effect.fn("Merges.settle")(function* <R>(opts: {
  stateDir: string;
  cwd: string;
  run: Runner<R>;
  views: ReadonlyArray<TaskView>;
  now: number;
  checked: Map<string, number>;
  states: Map<string, MrState>;
}) {
  // What earlier panes learned, under this pane's own answers: a new pane's empty memory
  // must not ask production again about what an earlier one already saw land there.
  for (const [label, state] of yield* readMrStates(opts.stateDir))
    if (!opts.states.has(label)) opts.states.set(label, state);
  const forge = new Map(yield* readForge(opts.stateDir));
  let learned = false;
  for (const view of opts.views) {
    // Anything that ended and nobody disposed of: the waiting cards, and a card that
    // already reads as landed from an earlier answer but has no disposition saying so.
    const section = sectionOf(view);
    if (view.mr === null || section === "working" || section === "needs-you") continue;
    // A merged one is still followed to its deploy jobs, until production has it.
    if (view.disposition !== null && !view.disposition.startsWith("merged")) continue;
    const label = mrLabel(view.mr);
    if (opts.states.get(label) === "in-prod") continue;
    if ((opts.checked.get(label) ?? 0) + MERGE_POLL_MS > opts.now) continue;
    if (pullOf(view.mr) === null && mrRefOf(view.mr) === null) continue;
    // Stamped before asking: a forge that cannot be asked is not asked again every tick.
    opts.checked.set(label, opts.now);
    const answered = yield* forgeAnswer(view.mr, opts.cwd, opts.run);
    if (answered === null) continue;
    const { state, facts, by } = answered;
    const before = forge.get(label);
    if (opts.states.get(label) !== state || !sameFacts(before, facts)) learned = true;
    opts.states.set(label, state);
    forge.set(label, facts);
    if (state === "open" || state === "closed") continue;
    const dir = runDir(opts.stateDir, view.run);
    const already = latest(
      yield* readDispositions(dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    if (already !== null) continue;
    yield* recordDisposition(dir, {
      at: yield* nowIso(),
      by,
      kind: "merged",
      ref: label,
      note: null,
    });
  }
  if (learned) yield* writeMrStates(opts.stateDir, opts.states, forge);
});

const sameFacts = (a: ForgeFacts | undefined, b: ForgeFacts) =>
  a !== undefined &&
  a.head === b.head &&
  a.checks.state === b.checks.state &&
  ("name" in a.checks ? a.checks.name : "") === ("name" in b.checks ? b.checks.name : "");

/**
 * One merge request's state and checks, from whichever forge it is on, or null where that
 * forge cannot be asked. Never an error: a card with no answer reads `unchecked`.
 */
const forgeAnswer = Effect.fn("Merges.forgeAnswer")(function* <R>(
  mr: string,
  cwd: string,
  run: Runner<R>,
) {
  const pull = pullOf(mr);
  if (pull !== null) {
    const said = yield* pullFacts(pull, cwd, run);
    if (said === null) return null;
    return {
      state: stateOf(said.state),
      facts: { checks: rollupChecks(said.statusCheckRollup), head: said.headRefOid ?? null },
      by: "github",
    };
  }
  const ref = mrRefOf(mr);
  if (ref === null) return null;
  const panel = yield* mrDetails(ref, cwd, run);
  if (panel._tag !== "Details") return null;
  let state = stateOf(panel.state);
  if (state === "merged") {
    const tier = yield* liveTier(ref, panel.mergedSha, cwd, run);
    state = tier === "production" ? "in-prod" : tier === "staging" ? "on-stage" : "merged";
  }
  return {
    state,
    facts: { checks: pipelineChecks(panel.pipeline), head: panel.head === "" ? null : panel.head },
    by: "gitlab",
  };
});

/**
 * Merged over what is there, never a replacement: every board pane keeps only what it has
 * itself asked, and a fresh pane writing its few answers over the file would take from the
 * CLI's board what an earlier pane had learned.
 */
export const writeMrStates = Effect.fn("Merges.write")(function* (
  stateDir: string,
  states: ReadonlyMap<string, MrState>,
  forge: ReadonlyMap<string, ForgeFacts> = new Map(),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, MR_STATES_FILE);
  const entries = new Map(yield* readEntries(stateDir));
  for (const [label, state] of states) {
    const facts = forge.get(label) ?? factsOf(entries.get(label));
    entries.set(
      label,
      facts === null ? { state } : { state, checks: facts.checks, head: facts.head },
    );
  }
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    `${Schema.encodeSync(StatesJson)(Object.fromEntries(entries))}\n`,
  );
});

/** What the last watch wrote, or nothing: a board with no pane has never asked a forge. */
const readEntries = Effect.fn("Merges.readEntries")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(stateDir, MR_STATES_FILE))
    .pipe(Effect.catch(() => Effect.succeed("{}")));
  const decoded = Schema.decodeUnknownOption(StatesJson)(text);
  if (Option.isSome(decoded)) return new Map<string, Entry>(Object.entries(decoded.value));
  // An unreadable file is no memory, not a failure: the next watch rewrites it.
  const old = Option.getOrElse(Schema.decodeUnknownOption(OldStatesJson)(text), () => ({}));
  return new Map<string, Entry>(Object.entries(old).map(([label, state]) => [label, { state }]));
});

const factsOf = (entry: Entry | undefined): ForgeFacts | null =>
  entry?.checks === undefined ? null : { checks: entry.checks, head: entry.head ?? null };

/** Each merge request's state, as the last watch learned it. */
export const readMrStates = Effect.fn("Merges.read")(function* (stateDir: string) {
  const entries = yield* readEntries(stateDir);
  return new Map([...entries].map(([label, entry]) => [label, entry.state]));
});

/** What the forge said of each merge request's checks; an entry in the old shape has none. */
export const readForge = Effect.fn("Merges.readForge")(function* (stateDir: string) {
  const found = new Map<string, ForgeFacts>();
  for (const [label, entry] of yield* readEntries(stateDir)) {
    const facts = factsOf(entry);
    if (facts !== null) found.set(label, facts);
  }
  return found;
});
