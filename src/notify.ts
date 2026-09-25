// Every toast Collie raises, and the only place one is formatted. A decided Run
// finishes with nobody watching, so a notification is the whole channel from the Run
// to the person who started it — and the corollary is that anything not worth
// interrupting for must not be sent, or the ones that matter get muted.

import { Context, type Effect } from "effect";

/**
 * The taxonomy is the contract: a new notification means a new entry here with a
 * defended answer to "is this worth interrupting a human for?". What is worth
 * *showing* belongs on the board instead.
 */
export const NOTIFICATION_KINDS = [
  "needs-you",
  "run-done",
  "run-failed",
  "output-unusable",
  "mr-opened",
  /**
   * Drift that Collie could not settle: the correction bound was spent, or nobody was
   * live to evaluate it. `request`, because it is the case where nothing else is going
   * to happen without the human.
   */
  "drift-unresolved",
  /**
   * Collie sent a correction to an agent by itself. `request` on purpose: the human
   * granted `auto_correct`, which is not the same as wanting it done behind their back.
   */
  "correction-sent",
  /** Something is waiting for a yes or a no, and nothing else will happen until it gets one. */
  "proposal-pending",
  /**
   * A slice of work a human could actually try. `done`, because it is good news — and
   * only for a slice there is something to look at: an agent's claim on its own never
   * toasts, because a claim is not a thing you can go and try.
   */
  "slice-ready",
  /** The Intent moved. Silent: it matters when the board is closed, and not before then. */
  "intent-changed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type Sound = "none" | "done" | "request";

/** `request` means a human must act; `done` means it finished well. Nothing else. */
export const SOUND = {
  "needs-you": "request",
  "run-done": "done",
  "run-failed": "request",
  "output-unusable": "request",
  "mr-opened": "done",
  "drift-unresolved": "request",
  "correction-sent": "request",
  "proposal-pending": "request",
  "slice-ready": "done",
  "intent-changed": "none",
} satisfies Record<NotificationKind, Sound>;

/**
 * What the title says happened. Some kinds name the thing they are about — which merge
 * request was opened, what drifted — because a toast that arrives while nobody is
 * watching has to identify itself without the board open beside it.
 */
const HEADLINE = {
  "needs-you": () => "needs you",
  "run-done": () => "finished",
  "run-failed": () => "failed",
  "output-unusable": () => "stopped on an unusable Output",
  "mr-opened": (mr?: string) => (mr ? `opened ${mr}` : "opened a merge request"),
  "drift-unresolved": (what?: string) =>
    what ? `drifted from ${what} and could not be corrected` : "has drift nobody has settled",
  "correction-sent": (what?: string) =>
    what ? `was corrected about ${what}` : "was corrected by Collie",
  "proposal-pending": () => "has something waiting for your yes or no",
  "slice-ready": (how?: string) => `has a slice you can try (${how ?? "inspect-ready"})`,
  "intent-changed": () => "was given a new Intent",
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

/** Which kinds are wanted; a kind absent from the map is on. */
export type NotificationSettings = Readonly<Record<string, boolean>>;

export function wanted(settings: NotificationSettings, kind: NotificationKind): boolean {
  return settings[kind] !== false;
}

/**
 * Raises one toast about a Run, at most once per kind and `key`: a Run that asks the same
 * question on every replay says so once, and one that asks another says so again. A toast
 * that cannot be raised never fails the Run.
 */
export class Notifier extends Context.Service<
  Notifier,
  {
    readonly notify: (
      runId: string,
      kind: NotificationKind,
      body: string,
      about?: { readonly key?: string; readonly subject?: string },
    ) => Effect.Effect<void>;
  }
>()("collie/Notifier") {}
