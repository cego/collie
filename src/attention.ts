import { Effect, type FileSystem, type Path } from "effect";
import { currentReports, openReports, readDrift } from "./drift";
import { readCards } from "./cards";
import { settled, type RunFacts } from "./runs";

/**
 * What a Run wants from whoever is watching it. `none` is the ordinary case — the Run
 * is working and nobody has to do anything — and everything else is a reason to come
 * back to it.
 */
export type AttentionCategory = "none" | "question" | "drift" | "completed" | "interrupted";

export interface Attention {
  readonly category: AttentionCategory;
  /** Stable across releases; the code an agent branches on. */
  readonly reason: string;
  readonly explanation: string;
  /** The `run` subcommands that make sense here, by name. */
  readonly actions: ReadonlyArray<string>;
}

/**
 * The one classification every front door reads: chat, the board's detail and the CLI
 * render this rather than each deciding for themselves what a stopped Run means. A
 * question outranks everything, because it is the human being waited on.
 */
export const attentionFor = Effect.fn("attention.attentionFor")(function* (run: RunFacts) {
  const asked = run.asking[0];
  if (asked !== undefined)
    return {
      category: "question",
      reason: "question",
      explanation: `${run.id} is waiting on "${asked.name}": ${asked.prompt}`,
      actions: ["answer", "show"],
    } satisfies Attention;
  // Below a question, because a question is the human being waited on and this is the
  // human being told; above `completed`, because a Run that finished having drifted is
  // one whose result is not what was asked for.
  const unresolved = yield* driftUnresolved(run.dir);
  if (unresolved !== null)
    return {
      category: "drift",
      reason: "drift_unresolved",
      explanation: `${run.id} drifted from ${unresolved} and Collie could not correct it; \`run drift\` shows what it found.`,
      actions: ["drift", "steer", "show"],
    } satisfies Attention;
  if (settled(run) && (yield* crossRunPending(run.dir)))
    return {
      category: "drift",
      reason: "cross_run_pending",
      explanation: `${run.id} and its related runs were never checked against each other; nobody was left to do it.`,
      actions: ["drift", "steer", "show"],
    } satisfies Attention;
  // What can still be done to an imported Run is read it: nothing is left to resume it.
  const after = run.imported ? ["show"] : ["show", "actions"];
  switch (run.state) {
    case "succeeded":
      return {
        category: "completed",
        reason: "succeeded",
        explanation: `${run.id} succeeded.`,
        actions: after,
      } satisfies Attention;
    case "failed":
      return {
        category: "interrupted",
        reason: "failed",
        explanation: `${run.id} failed${run.note === null ? ", and nothing it recorded says why" : `: ${run.note}`}.`,
        actions: after,
      } satisfies Attention;
    case "stopped":
      return {
        category: "interrupted",
        reason: "stopped",
        explanation: `${run.id} was stopped.`,
        actions: after,
      } satisfies Attention;
    case "waiting":
      return {
        category: "interrupted",
        reason: "parked",
        explanation: `${run.id} parked its work${run.note === null ? "" : `: ${run.note}`}`,
        actions: ["show", "stop"],
      } satisfies Attention;
    case "running":
      return run.held
        ? ({
            category: "none",
            reason: "held",
            explanation: `${run.id} is held; \`run release\` to continue.`,
            actions: ["release", "stop", "show"],
          } satisfies Attention)
        : ({
            category: "none",
            reason: "working",
            // Open drift while a Run is still going is said out loud but is not attention:
            // it may still be corrected.
            explanation: `${run.id} is running.${yield* driftNote(run.dir)}`,
            actions: ["show", "stop"],
          } satisfies Attention);
  }
});

/**
 * The constraint a Run drifted from and nobody settled, or null. `escalated` is what the
 * correction loop writes when it has spent its bound.
 */
const driftUnresolved = (
  dir: string,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  readDrift(dir).pipe(
    Effect.map(
      (lines) =>
        currentReports(lines).find((report) => report.resolution === "escalated")?.constraint ??
        null,
    ),
    Effect.orElseSucceed(() => null),
  );

/** Whether this Run's newest card says the Herd still owes a cross-run evaluation. */
const crossRunPending = (
  dir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  readCards(dir).pipe(
    Effect.map((cards) => cards.at(-1)?.cross_run === "pending"),
    Effect.orElseSucceed(() => false),
  );

/** Open drift, as an addendum rather than a category: it may still be corrected. */
const driftNote = (dir: string): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  readDrift(dir).pipe(
    Effect.map((lines) => {
      const open = openReports(lines);
      if (open.length === 0) return "";
      const blocking = open.filter((report) => report.severity === "block").length;
      return ` ${open.length} open drift report${open.length === 1 ? "" : "s"}${blocking > 0 ? `, ${blocking} blocking` : ""}.`;
    }),
    Effect.orElseSucceed(() => ""),
  );
