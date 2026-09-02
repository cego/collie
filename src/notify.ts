// Every toast Collie raises, and the only place one is formatted. A decided Run
// finishes with nobody watching, so a notification is the whole channel from the Run
// to the person who started it — and the corollary is that anything not worth
// interrupting for must not be sent, or the ones that matter get muted.

import { Effect } from "effect";
import type { Herdr } from "./herdr";
import type { Run } from "./run";

/**
 * The taxonomy is the contract: a new notification means a new entry here with a
 * defended answer to "is this worth interrupting a human for?". What is worth
 * *showing* belongs on the board instead.
 */
export const NOTIFICATION_KINDS = [
  "needs-you",
  "decision-lost",
  "run-done",
  "run-stuck",
  "run-failed",
  "step-stuck",
  "output-unusable",
  "mr-opened",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** `request` means a human must act; `done` means it finished well. Nothing else. */
const SOUND = {
  "needs-you": "request",
  "decision-lost": "request",
  "run-done": "done",
  "run-stuck": "request",
  "run-failed": "request",
  "step-stuck": "request",
  "output-unusable": "request",
  "mr-opened": "done",
} satisfies Record<NotificationKind, "none" | "done" | "request">;

/**
 * What the title says happened. Two kinds name the thing they are about — which step
 * went quiet, which merge request was opened — because a toast that arrives while
 * nobody is watching has to identify itself without the board open beside it.
 */
const HEADLINE = {
  "needs-you": () => "needs you",
  "decision-lost": () => "is asking after all",
  "run-done": () => "finished",
  "run-stuck": () => "stopped with findings",
  "run-failed": () => "failed",
  "step-stuck": (step?: string) => `stopped: ${step ?? "a step"} went quiet`,
  "output-unusable": () => "stopped on an unusable Output",
  "mr-opened": (mr?: string) => (mr ? `opened ${mr}` : "opened a merge request"),
} satisfies Record<NotificationKind, (subject?: string) => string>;

/** One herdr session runs several checkouts, so the repo is part of every title. */
function repoOf(cwd: string): string {
  return cwd.replace(/\/+$/, "").split("/").pop() ?? cwd;
}

export function notificationTitle(
  kind: NotificationKind,
  cwd: string,
  slug: string,
  /** What this one is about, where the kind names it: a step id, an MR's `!<iid>`. */
  subject?: string,
): string {
  return `${repoOf(cwd)} · ${slug} ${HEADLINE[kind](subject)}`;
}

/** What was already said about this Run, so a resumed Driver does not say it again. */
export function alreadySent(run: Run, kind: NotificationKind, step: string | null): boolean {
  return run.record.notified.includes(sentKey(kind, step));
}

function sentKey(kind: NotificationKind, step: string | null): string {
  return `${kind}:${step ?? ""}`;
}

/** Which kinds are wanted; a kind absent from the map is on. */
export type NotificationSettings = Readonly<Record<string, boolean>>;

export function wanted(settings: NotificationSettings, kind: NotificationKind): boolean {
  return settings[kind] !== false;
}

/**
 * Raises one notification, at most once per `(run, kind, step)`. A Run that waits at
 * the same step, is answered, and waits there again does not toast twice; one that
 * reaches a different step does. A missing toast must never fail a Run.
 */
export const notify = Effect.fn("Notify.notify")(function* (
  herdr: Herdr,
  run: Run,
  opts: {
    kind: NotificationKind;
    body: string;
    /** What the toast is about, so the same question at a later step says so again. */
    step?: string | null;
    /** Named in the title where the kind says which one: a step id, an `!<iid>`. */
    subject?: string;
    settings?: NotificationSettings;
  },
) {
  const step = opts.step ?? null;
  // Returns whether it actually said anything, so a caller that suppresses a second
  // toast about the same event does not go silent when the first one was turned off.
  if (!wanted(opts.settings ?? {}, opts.kind)) return false;
  if (alreadySent(run, opts.kind, step)) return false;
  run.record.notified.push(sentKey(opts.kind, step));
  yield* Effect.ignore(run.save());
  yield* Effect.ignore(
    herdr.notify(
      notificationTitle(opts.kind, run.record.cwd, run.record.slug, opts.subject),
      opts.body,
      SOUND[opts.kind],
    ),
  );
  return true;
});
