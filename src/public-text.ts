// Public text: what Collie sends outside Collie in the human's name (ADR-draft-public-text-reads-as-the-humans).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";

export interface Leak {
  readonly phrase: string;
  readonly reason: string;
}

const SUBCOMMANDS = [
  "workflow",
  "persona",
  "run",
  "task",
  "settings",
  "steer",
  "confirm",
  "decline",
  "proposal",
  "verify",
  "measure",
  "board",
  "chat",
  "tools",
  "mcp",
  "upgrade",
  "onboard",
  "doctor",
  "cleanup",
  "usage",
  "models",
  "connections",
  "schedule",
  "host",
  "bridge",
  "machine",
];

const PHRASES: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /Posted by Collie/g, reason: "signs the post as Collie's" },
  { pattern: /\bCollie\b/g, reason: "names Collie" },
  {
    pattern: new RegExp(`\\bcollie (?:${Arr.join(SUBCOMMANDS, "|")})\\b`, "g"),
    reason: "is a collie command",
  },
  { pattern: /\brun-[0-9a-f]{8}(?:\.[\w.-]+)?/g, reason: "is a Run id" },
  { pattern: /\b(?:[Tt]his|[Tt]he|[Aa]) Run\b/g, reason: "names a Run" },
  { pattern: /\btautolog\w*/gi, reason: "is Collie's review vocabulary" },
  { pattern: /\breview-step\b/gi, reason: "names a Collie step" },
  { pattern: /\bfailing-first\b/gi, reason: "holds the reader to Collie's evidence rule" },
  { pattern: /Not settled by the run/gi, reason: "is Collie's framing of open questions" },
  { pattern: /\bassumed in \d{2}-/g, reason: "names a plan ticket" },
  { pattern: /\b\d{2}-[a-z0-9][a-z0-9-]*\.md\b/g, reason: "is a plan ticket's file name" },
  { pattern: /\/herdr\/plugins\//g, reason: "is a path in Collie's state" },
  { pattern: /\.collie\//g, reason: "is a path in Collie's own directory" },
];

/** Each phrase in `text` that names Collie or its process, once, in the order of the list. */
export const leaksIn = (text: string): ReadonlyArray<Leak> =>
  Arr.dedupeWith(
    Arr.flatMap(PHRASES, ({ pattern, reason }) =>
      Arr.map(Arr.fromIterable(pipe(text, Str.matchAll(pattern))), (match) => ({
        phrase: match[0],
        reason,
      })),
    ),
    (a, b) => a.phrase === b.phrase,
  );

export const refusal = (leaks: ReadonlyArray<Leak>) =>
  `this text names Collie or its process, so it is not sent in the human's name: ${Arr.join(
    Arr.map(leaks, (leak) => `"${leak.phrase}" ${leak.reason}`),
    "; ",
  )}. Reword it for the repository's own readers.`;

/** The hidden marker Collie's own post ends with, which no reader sees. */
export const marker = (runId: string) => `<!-- collie:${runId} -->`;

/** The repository the installation's releases come from, as an `MrRef`'s `host/path`. */
export const ownRepository = (releases: string) =>
  pipe(releases, Str.replace(/^https?:\/\//, ""), Str.replace(/\/releases\/?$/, ""));
