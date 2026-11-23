// WARNING: items are keyed by identity, never position; identical identities are refused before any item starts.
import * as Arr from "effect/Array";
import { unsafePathComponent } from "./naming";

export interface Handed {
  readonly item: string;
  readonly title: string;
  readonly commits: ReadonlyArray<string>;
  readonly verifications?: ReadonlyArray<string>;
}

export function renderProgress(done: ReadonlyArray<Handed>) {
  if (done.length === 0) {
    return "(this is the first ticket)";
  }
  return Arr.join(
    Arr.map(done, (entry) => {
      const commits =
        entry.commits.length === 0
          ? "    (no commit)"
          : Arr.join(
              Arr.map(entry.commits, (subject) => `    ${subject}`),
              "\n",
            );
      const proved = entry.verifications ?? [];
      const verified =
        proved.length === 0 ? "    verified: nothing" : `    verified: ${Arr.join(proved, ", ")}`;
      return `- ${entry.item} — ${entry.title}\n${commits}\n${verified}`;
    }),
    "\n",
  );
}

export function identityProblem(keys: ReadonlyArray<string>) {
  const seen = new Set<string>();
  for (const key of keys) {
    const unsafe = unsafePathComponent(key);
    if (unsafe !== null) {
      return `"${key}" cannot identify work: it ${unsafe}`;
    }
    if (seen.has(key)) {
      return `two items of work are called "${key}", so one result would answer for both`;
    }
    seen.add(key);
  }
  return null;
}
