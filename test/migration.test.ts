// Both directions of the move to native chat, against records an installation actually
// has. The thing that must not happen either way is loss: a Home nobody can own, a
// conversation nobody can read, a Run nobody can control.
//
// `migrate-up` is an installation from before the Home had a chat pane, opening this
// release. `migrate-down` is the same tree read by the release before this one — the
// rollback — which has to find its Home and its records exactly as it left them.

import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { append, conversationPath, read as readConversation } from "../src/conversation";
import { CHAT_PANE_TOKEN } from "../src/chat";
import type { PaneInfo, WorkspaceInfo } from "../src/herdr";
import {
  decide,
  ensureHome,
  HOME_TOKEN,
  homePath,
  readHome,
  UNREADABLE,
  writeHome,
  type HomeDeps,
  type HomeRecord,
} from "../src/home";
import { runEffect } from "./support/effect";

const KEY = "herd-abc";
let stateDir: string;

const workspace = (id: string, tokens: Record<string, string> = {}): WorkspaceInfo => ({
  workspaceId: id,
  label: "🐕 Collie",
  cwd: "/ns",
  worktree: null,
  tokens,
});

const pane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  paneId: "1-1",
  tabId: "1",
  label: "🐕 Collie",
  agent: null,
  workspaceId: "w1",
  cwd: "/ns",
  foregroundCwd: null,
  tokens: {},
  terminalId: "term-1",
  ...over,
});

/** A Home as the release before this one wrote it: a board pane, and no chat. */
const legacy = (): HomeRecord => ({
  workspaceId: "w1",
  tabId: "1",
  paneId: "1-1",
  terminalId: "term-1",
  createdAt: "2026-09-01T10:00:00Z",
  token: KEY,
  state: "ready",
  previous: [],
});

function fake(initial: { workspaces: WorkspaceInfo[]; panes: PaneInfo[] }) {
  const calls: string[] = [];
  const state = { ...initial };
  const deps: HomeDeps = {
    workspaces: Effect.sync(() => state.workspaces),
    panes: Effect.sync(() => state.panes),
    createWorkspace: () =>
      Effect.sync(() => {
        calls.push("createWorkspace");
        return "w-new";
      }),
    openPane: (workspaceId) =>
      Effect.sync(() => {
        calls.push(`openPane ${workspaceId}`);
        return { tabId: "1", paneId: "1-1" };
      }),
    splitPane: (opts) =>
      Effect.sync(() => {
        calls.push(`splitPane ${opts.paneId}`);
        const opened = pane({ paneId: "1-2", terminalId: "term-2" });
        state.panes = [...state.panes, opened];
        return opened.paneId;
      }),
    markWorkspace: () => Effect.void,
    markPane: (paneId, tokens) =>
      Effect.sync(() => {
        calls.push(`markPane ${paneId} ${Object.keys(tokens).sort().join(",")}`);
      }),
    closePane: (paneId) =>
      Effect.sync(() => {
        calls.push(`closePane ${paneId}`);
      }),
    log: () => Effect.void,
  };
  return { calls, deps };
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-migration-" });
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

test("migrate-up: an existing Home gains native chat and loses nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = yield* homePath(stateDir, KEY);
      yield* writeHome(file, legacy());
      // What such an installation also has: a conversation from the custom editor, and
      // whatever else this Herd's directory holds.
      const journal = yield* conversationPath(stateDir, KEY);
      yield* append(journal, { role: "human", text: "how is the flock?" });
      yield* append(journal, { role: "collie", text: "two runs are going" });
      const before = yield* fs.readFileString(journal);
      const proposals = path.join(path.dirname(journal), "proposals.jsonl");
      yield* fs.writeFileString(proposals, '{"kind":"proposal","id":"p-1"}\n');

      // Only the chat pane is missing, so only the chat pane is opened.
      expect(
        decide(legacy(), [workspace("w1", { [HOME_TOKEN]: KEY })], [pane()], KEY),
      ).toMatchObject({ kind: "reopen", missing: ["chat"] });

      const h = fake({ workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })], panes: [pane()] });
      expect((yield* ensureHome(stateDir, KEY, "/ns", h.deps)).kind).toBe("ready");
      expect(h.calls).toEqual([
        "splitPane 1-1",
        "markPane 1-2 collie_chat,collie_home",
        "markPane 1-1 collie_home",
      ]);
      const after = yield* readHome(file);
      expect(after).toMatchObject({ workspaceId: "w1", paneId: "1-1", chatPaneId: "1-2" });

      // The archive is untouched, byte for byte, and so is everything beside it.
      expect(yield* fs.readFileString(journal)).toBe(before);
      expect(yield* fs.readFileString(proposals)).toBe('{"kind":"proposal","id":"p-1"}\n');
      expect((yield* readConversation(journal)).map((turn) => turn.role)).toEqual([
        "human",
        "collie",
      ]);
    }),
  ));

/**
 * The record as the release before this one decodes it. Written out here rather than
 * imported, because that is the point: a rollback runs the *old* decoder against the
 * *new* file, and only a copy of the old shape can say whether that works.
 */
const OldRecord = Schema.fromJsonString(
  Schema.Struct({
    workspaceId: Schema.String,
    tabId: Schema.NullOr(Schema.String),
    paneId: Schema.NullOr(Schema.String),
    terminalId: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
    token: Schema.String,
    state: Schema.Literals(["creating", "ready"]),
    previous: Schema.Array(
      Schema.Struct({ workspaceId: Schema.String, archivedAt: Schema.String }),
    ),
  }),
);

test("migrate-down: the release before this one reads the same tree", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* homePath(stateDir, KEY);
      const journal = yield* conversationPath(stateDir, KEY);
      yield* append(journal, { role: "human", text: "how is the flock?" });

      // The tree this release leaves: a Home that also names a chat pane.
      const h = fake({ workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })], panes: [pane()] });
      yield* writeHome(file, legacy());
      yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      const now = yield* readHome(file);
      expect(now).not.toBe(UNREADABLE);

      // The old decoder still reads it: the two keys this release added are ones it
      // ignores, so a rollback finds its Home rather than an ownership question.
      const old = Schema.decodeUnknownOption(OldRecord)(yield* fs.readFileString(file));
      expect(old._tag).toBe("Some");
      if (old._tag === "Some")
        expect(old.value).toMatchObject({ workspaceId: "w1", paneId: "1-1", state: "ready" });

      // And the conversation the old board draws is still there to draw.
      expect((yield* readConversation(journal)).map((turn) => turn.text)).toEqual([
        "how is the flock?",
      ]);

      // The chat pane the rollback cannot use is marked as its own thing, so it can be
      // found and closed rather than mistaken for the board's.
      expect(h.calls).toContain(`markPane 1-2 ${[CHAT_PANE_TOKEN, HOME_TOKEN].sort().join(",")}`);
    }),
  ));
