import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect } from "effect";
import { currentReports, openReports, readDrift } from "./drift";
import { readCards } from "./cards";
import { settled, type RunFacts } from "./runs";
import type { Attention } from "./board-model";

export const attentionFor = Effect.fn("attention.attentionFor")(function* (run: RunFacts) {
  const asked = run.asking[0];
  if (asked !== undefined)
    return {
      category: "question",
      reason: "question",
      explanation: `${run.id} is waiting on "${asked.name}": ${asked.prompt}`,
      actions: ["answer", "show"],
    } satisfies Attention;
  // WARNING: below a question (the human is waited on) and above completed (a drifted finish is not what was asked).
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
  const after = ["show", "actions"];
  switch (run.state) {
    case "ended":
      return {
        category: "completed",
        reason: "ended",
        explanation: `${run.id} ended; outcome unavailable.`,
        actions: after,
      } satisfies Attention;
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
      if (!run.held && run.awaiting !== null)
        return {
          category: "none",
          reason: "awaiting",
          explanation: `${run.id} is waiting for ${run.awaiting.on}, which ${run.awaiting.who === null ? "comes by itself" : `${run.awaiting.who} acts on`}.`,
          actions: ["show", "stop"],
        } satisfies Attention;
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
            // WARNING: open drift on a running Run is said, but is not attention: it may still be corrected.
            explanation: `${run.id} is running.${yield* driftNote(run.dir)}`,
            actions: ["show", "stop"],
          } satisfies Attention);
  }
});

const driftUnresolved = (dir: string) =>
  readDrift(dir).pipe(
    Effect.map(
      (lines) =>
        Option.getOrUndefined(
          Arr.findFirst(currentReports(lines), (report) => report.resolution === "escalated"),
        )?.constraint ?? null,
    ),
    Effect.orElseSucceed(() => null),
  );

const crossRunPending = (dir: string) =>
  readCards(dir).pipe(
    Effect.map((cards) => cards.at(-1)?.cross_run === "pending"),
    Effect.orElseSucceed(() => false),
  );

const driftNote = (dir: string) =>
  readDrift(dir).pipe(
    Effect.map((lines) => {
      const open = openReports(lines);
      if (open.length === 0) return "";
      const blocking = Arr.filter(open, (report) => report.severity === "block").length;
      return ` ${open.length} open drift report${open.length === 1 ? "" : "s"}${blocking > 0 ? `, ${blocking} blocking` : ""}.`;
    }),
    Effect.orElseSucceed(() => ""),
  );
