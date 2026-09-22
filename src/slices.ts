// A list of work and the hand-off between its items, for a declared `each:` and for a
// module that writes its own loop.
//
// An item is known by an identity, never by where it sits in the list: that is what
// makes a reordered plan reuse the work it already has rather than hand one item's
// result to another. Two items that cannot be told apart are refused here, before any
// of them is started, because one result answering for both is a lie nobody can see.

import { unsafePathComponent } from "./naming";

/** One item of work that finished, and what it left for the ones after it. */
export interface Handed {
  /** Its identity: the name its results, its Output and its prompt are all kept under. */
  readonly item: string;
  readonly title: string;
  readonly commits: ReadonlyArray<string>;
  /** What was verified while it ran, as `name: result`; nothing where nothing was. */
  readonly verifications?: ReadonlyArray<string>;
}

/** What the items before this one left behind: their work, their commits, their evidence. */
export function renderProgress(done: ReadonlyArray<Handed>): string {
  if (done.length === 0) return "(this is the first ticket)";
  return done
    .map((entry) => {
      const commits =
        entry.commits.length === 0
          ? "    (no commit)"
          : entry.commits.map((subject) => `    ${subject}`).join("\n");
      const proved = entry.verifications ?? [];
      const verified =
        proved.length === 0 ? "    verified: nothing" : `    verified: ${proved.join(", ")}`;
      return `- ${entry.item} — ${entry.title}\n${commits}\n${verified}`;
    })
    .join("\n");
}

/**
 * Why these identities cannot key a list of work, or null where they can. An identity is
 * a name of its own — it becomes a directory entry and an agent's work — and no two items
 * may share one.
 */
export function identityProblem(keys: ReadonlyArray<string>): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    const unsafe = unsafePathComponent(key);
    if (unsafe !== null) return `"${key}" cannot identify work: it ${unsafe}`;
    if (seen.has(key)) {
      return `two items of work are called "${key}", so one result would answer for both`;
    }
    seen.add(key);
  }
  return null;
}
