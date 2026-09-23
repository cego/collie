// What GitLab says about the merge requests the board is waiting on, asked in the
// background and never from a render: a merge the human did in GitLab is the strongest
// signal that the work landed, so Collie records the disposition itself.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { mrLabel, sectionOf, type MrState, type TaskView } from "./board";
import { latest, readDispositions, recordDisposition } from "./disposition";
import { liveTier, mrDetails, parseMrTarget, type MrRef, type Runner } from "./mr";
import { runDir } from "./engine";
import { nowIso } from "./time";

/** How long one merge request's answer stands before GitLab is asked again. */
export const MERGE_POLL_MS = 5 * 60_000;

/** Where the CLI's board reads what the pane's watch last learned. */
export const MR_STATES_FILE = "board/mr-states.json";

const StatesJson = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]),
  ),
);

/** `https://host/group/project/-/merge_requests/42` or `mr:host/group/project!42` as one ref. */
export function mrRefOf(mr: string): MrRef | null {
  const url = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(mr);
  if (url) return { project: `${url[1]}/${url[2]}`, iid: url[3]! };
  return parseMrTarget(mr.startsWith("mr:") ? mr : `mr:${mr}`);
}

function stateOf(state: string): MrState {
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
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
    const ref = mrRefOf(view.mr);
    if (ref === null) continue;
    opts.checked.set(label, opts.now);
    const panel = yield* mrDetails(ref, opts.cwd, opts.run);
    if (panel._tag !== "Details") continue;
    let state = stateOf(panel.state);
    if (state === "merged") {
      const tier = yield* liveTier(ref, panel.mergedSha, opts.cwd, opts.run);
      state = tier === "production" ? "in-prod" : tier === "staging" ? "on-stage" : "merged";
    }
    if (opts.states.get(label) !== state) learned = true;
    opts.states.set(label, state);
    if (state === "open" || state === "closed") continue;
    const dir = runDir(opts.stateDir, view.run);
    const already = latest(
      yield* readDispositions(dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    if (already !== null) continue;
    yield* recordDisposition(dir, {
      at: yield* nowIso(),
      by: "gitlab",
      kind: "merged",
      ref: label,
      note: null,
    });
  }
  if (learned) yield* writeMrStates(opts.stateDir, opts.states);
});

/**
 * Merged over what is there, never a replacement: every board pane keeps only what it has
 * itself asked, and a fresh pane writing its few answers over the file would take from the
 * CLI's board what an earlier pane had learned.
 */
export const writeMrStates = Effect.fn("Merges.write")(function* (
  stateDir: string,
  states: ReadonlyMap<string, MrState>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(stateDir, MR_STATES_FILE);
  const merged = new Map([...(yield* readMrStates(stateDir)), ...states]);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${Schema.encodeSync(StatesJson)(Object.fromEntries(merged))}\n`);
});

/** What the last watch wrote, or nothing: a board with no pane has never asked GitLab. */
export const readMrStates = Effect.fn("Merges.read")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(stateDir, MR_STATES_FILE))
    .pipe(Effect.catch(() => Effect.succeed("{}")));
  // An unreadable file is no memory, not a failure: the next watch rewrites it.
  const decoded = Option.getOrElse(Schema.decodeUnknownOption(StatesJson)(text), () => ({}));
  return new Map<string, MrState>(Object.entries(decoded));
});
