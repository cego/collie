// A conversation is where people paste things, so what is tested here is what never
// reaches the file: a live credential, and a path pointing somewhere the board would
// happily open. Plus that it survives the board closing, which is the whole reason it
// is on disk at all.

import { DateTime, Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  MAX_TURNS,
  append,
  conversationPath,
  insideKnown,
  keep,
  pendingProposals,
  read,
  redact,
  tail,
  type Turn,
} from "../src/conversation";
import { runEffect } from "./support/effect";

let stateDir: string;
let file: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-conversation-" });
      file = yield* conversationPath(stateDir, "herd-1");
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

test("a credential is replaced by what kind of credential it was", () => {
  const said = [
    "the deploy fails with glpat-abcdefghij1234567890",
    "and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "try Bearer eyJhbGciOiJIUzI1NiJ9aaaaaaaaaaaaaaaaaaaa",
    "GITLAB_TOKEN=hunter2hunter2hunter2",
    "AKIAIOSFODNN7EXAMPLE is in the env too",
  ].join("\n");
  const clean = redact(said);

  // The type survives, because "a GitLab token was in here" is the useful half.
  expect(clean).toContain("<gitlab token>");
  expect(clean).toContain("<github token>");
  expect(clean).toContain("Bearer <token>");
  expect(clean).toContain("GITLAB_TOKEN=<redacted>");
  expect(clean).toContain("<aws key id>");
  // And the value does not.
  expect(clean).not.toContain("glpat-abcdefghij1234567890");
  expect(clean).not.toContain("hunter2");
  expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE");

  // Ordinary prose is left alone.
  expect(redact("the exporter drops a column when the header is missing")).toBe(
    "the exporter drops a column when the header is missing",
  );
});

test("a path outside the Runs Collie knows about is not one it will show", () =>
  runEffect(
    Effect.gen(function* () {
      const roots = ["/state/runs/implement-1"];
      expect(insideKnown("/state/runs/implement-1/log.txt", roots)).toBe(true);
      expect(insideKnown("/state/runs/implement-1", roots)).toBe(true);
      // A sibling whose path merely starts the same way is not inside it.
      expect(insideKnown("/state/runs/implement-11/log.txt", roots)).toBe(false);
      expect(insideKnown("/etc/shadow", roots)).toBe(false);

      const turn = yield* append(
        file,
        {
          role: "collie",
          text: "look at /state/runs/implement-1/log.txt and also /etc/shadow",
        },
        roots,
      );
      expect(turn.text).toContain("/state/runs/implement-1/log.txt");
      expect(turn.text).not.toContain("/etc/shadow");
      expect(turn.text).toContain("<external>");
    }),
  ));

test("the journal is what the board reads back after it is closed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { role: "human", text: "why is it on main?", target: "r1" });
      yield* append(file, { role: "collie", text: "the branch input was empty", target: "r1" });
      yield* append(file, { role: "human", text: "and the other one?", target: "r2" });

      // A second process reading the same file is what "survives a restart" means here.
      const back = yield* read(file);
      expect(back.map((turn) => turn.role)).toEqual(["human", "collie", "human"]);
      expect((yield* tail(file, 10, "r1")).map((turn) => turn.text)).toEqual([
        "why is it on main?",
        "the branch input was empty",
      ]);
      expect(yield* tail(file, 1)).toHaveLength(1);
    }),
  ));

test("what is kept is the recent and the not-too-old", () => {
  const epoch = Date.parse("2026-09-09T00:00:00Z");
  const at = (daysAgo: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(epoch - daysAgo * 86_400_000));
  const turn = (id: string, daysAgo: number): Turn => ({
    id,
    at: at(daysAgo),
    role: "human",
    text: id,
  });
  const nowMs = epoch;

  expect(keep([turn("old", 40), turn("recent", 1)], nowMs).map((t) => t.id)).toEqual(["recent"]);

  const many = Array.from({ length: MAX_TURNS + 10 }, (_, i) => turn(`t${i}`, 0));
  const kept = keep(many, nowMs);
  expect(kept).toHaveLength(MAX_TURNS);
  // The newest, not the oldest: a trim that dropped what was just said would be useless.
  expect(kept.at(-1)?.id).toBe(`t${MAX_TURNS + 9}`);
});

test("the pending proposals are the ones this conversation raised and nobody answered", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { role: "collie", text: "one", target: "r1", proposal: "p-1" });
      yield* append(file, { role: "collie", text: "two", target: "r1", proposal: "p-2" });
      yield* append(file, { role: "human", text: "no proposal here" });

      expect(yield* pendingProposals(file, () => true)).toEqual(["p-1", "p-2"]);
      expect(yield* pendingProposals(file, (id) => id === "p-2")).toEqual(["p-2"]);
      expect(yield* pendingProposals(file, () => false)).toEqual([]);
    }),
  ));
