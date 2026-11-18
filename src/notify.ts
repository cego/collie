import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Context, type Effect } from "effect";
import { mrWords, parseMrUrl } from "./board-model";

export function openedSubject(url: string) {
  const mr = parseMrUrl(url);
  return mr === null ? undefined : `${mrWords(mr).sign}${mr.iid}`;
}

export const NOTIFICATION_KINDS = [
  "needs-you",
  "run-done",
  "run-failed",
  "run-healed",
  "mr-opened",
  "drift-unresolved",
  "correction-sent",
  "proposal-pending",
  "slice-ready",
  "intent-changed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type Sound = "none" | "done" | "request";

export const SOUND = {
  "needs-you": "request",
  "run-done": "done",
  "run-failed": "request",
  "run-healed": "done",
  "mr-opened": "done",
  "drift-unresolved": "request",
  "correction-sent": "request",
  "proposal-pending": "request",
  "slice-ready": "done",
  "intent-changed": "none",
} satisfies Record<NotificationKind, Sound>;

const HEADLINE = {
  "needs-you": () => "needs you",
  "run-done": () => "finished",
  "run-failed": () => "failed",
  "run-healed": () => "was healed",
  "mr-opened": (mr?: string) => (mr ? `opened ${mr}` : "opened a merge request"),
  "drift-unresolved": (what?: string) =>
    what ? `drifted from ${what} and could not be corrected` : "has drift nobody has settled",
  "correction-sent": (what?: string) =>
    what ? `was corrected about ${what}` : "was corrected by Collie",
  "proposal-pending": () => "has something waiting for your yes or no",
  "slice-ready": (how?: string) => `has a slice you can try (${how ?? "inspect-ready"})`,
  "intent-changed": () => "was given a new Intent",
} satisfies Record<NotificationKind, (subject?: string) => string>;

function repoOf(cwd: string) {
  return Str.split(pipe(cwd, Str.replace(/\/+$/, "")), "/").pop() ?? cwd;
}

export function notificationTitle(
  kind: NotificationKind,
  cwd: string,
  slug: string,
  subject?: string,
) {
  return `${repoOf(cwd)} · ${slug} ${HEADLINE[kind](subject)}`;
}

export type NotificationSettings = Readonly<Record<string, boolean>>;

export function wanted(settings: NotificationSettings, kind: NotificationKind) {
  return settings[kind] !== false;
}

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
