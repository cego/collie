// Two things must never happen: a second Home created because a token expired, and
// somebody else's workspace adopted because it looks like one. Everything here is a way
// of arriving at one of those, and the answer being `ownership_unknown` instead.

import { Clock, DateTime, Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  HOME_TOKEN,
  LEGACY_PANE_TOKEN,
  closable,
  decide,
  ensureHome,
  originPath,
  readOrigin,
  writeOrigin,
  homePath,
  missingRuntime,
  ownershipProof,
  UNREADABLE,
  readHome,
  serverPath,
  writeHome,
  writeServer,
  type HomeDeps,
  type HomeRecord,
} from "../src/home";
import type { PaneInfo, WorkspaceInfo } from "../src/herdr";
import { BOARD_RATIO } from "../src/chat";
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

/** The Home's two panes: the board, and native chat beside it. */
const panes = (over: Partial<PaneInfo> = {}): PaneInfo[] => [
  pane(over),
  pane({ paneId: "1-2", terminalId: "term-2", ...over }),
];

const record = (over: Partial<HomeRecord> = {}): HomeRecord => ({
  workspaceId: "w1",
  tabId: "1",
  paneId: "1-1",
  terminalId: "term-1",
  chatPaneId: "1-2",
  chatTerminalId: "term-2",
  createdAt: "2026-09-09T10:00:00Z",
  token: KEY,
  state: "ready",
  previous: [],
  ...over,
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-home-" });
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

test("a live token proves ownership, and so does the pane that was opened", () => {
  // The ordinary case.
  expect(ownershipProof(record(), [workspace("w1", { [HOME_TOKEN]: KEY })], panes(), KEY)).toBe(
    "token",
  );
  // The token lapsed, but the pane Collie opened is still there with its own terminal:
  // the claim was true and the TTL merely ran out. Healed, not re-decided.
  expect(ownershipProof(record(), [workspace("w1")], panes(), KEY)).toBe("pane");
  // A different terminal in that pane is a different thing in the same place.
  expect(
    ownershipProof(record(), [workspace("w1")], [pane({ terminalId: "term-9" })], KEY),
  ).toBeNull();
  // Another Herd's token is not this Herd's proof.
  expect(
    ownershipProof(record(), [workspace("w1", { [HOME_TOKEN]: "another-herd" })], [], KEY),
  ).toBeNull();
});

test("a label is never consulted, however much it looks like the Home", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = new URL("../src/home.ts", import.meta.url).pathname;
      const text = yield* fs.readFileString(source);
      // The label appears once, as the label a created workspace is *given*. It is never
      // read back to decide anything: two workspaces can say the same thing.
      expect(text).not.toContain("workspace.label ===");
      expect(text).not.toContain(".label ===");
      expect(text).not.toContain("isCollieTab");
    }),
  ));

test("every uncertain case stops rather than guessing", () => {
  // A token nobody has a record for: a previous Collie's Home, or another state dir's.
  expect(decide(null, [workspace("w1", { [HOME_TOKEN]: KEY })], [], KEY)).toMatchObject({
    kind: "ownership_unknown",
    candidates: ["w1"],
  });
  // The recorded workspace exists but proves nothing.
  expect(decide(record(), [workspace("w1")], [], KEY)).toMatchObject({
    kind: "ownership_unknown",
    candidates: ["w1"],
  });
  // A crash mid-create is the one uncertain case that does not stop: the record is named
  // as an orphan candidate and a Home is made, so a crash in that window does not need a
  // human before Collie can be used at all (SPEC §7.12 case 5).
  expect(decide(record({ state: "creating", paneId: null }), [workspace("w1")], [], KEY)).toEqual({
    kind: "create",
    orphan: "w1",
  });
  // Two workspaces claiming it: the recorded one is named first, and both are listed.
  expect(
    decide(
      record(),
      [workspace("w1", { [HOME_TOKEN]: KEY }), workspace("w2", { [HOME_TOKEN]: KEY })],
      panes(),
      KEY,
    ),
  ).toMatchObject({ kind: "ownership_unknown", candidates: ["w1", "w2"] });
});

test("a record that cannot be read is never read as no record", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* homePath(stateDir, KEY);
      yield* fs.makeDirectory(stateDir + "/x", { recursive: true });
      yield* writeHome(file, record());
      yield* fs.writeFileString(file, "{ half a record");

      expect(yield* readHome(file)).toBe(UNREADABLE);
      // The token has lapsed and the workspace is still there. Read as absent this would
      // create a second Home beside the first; it has to stop instead.
      const h = fake({ workspaces: [workspace("w1")], panes: panes() });
      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured.kind).toBe("ownership_unknown");
      expect(h.calls).toEqual([]);
    }),
  ));

test("nothing is created because a token expired, and the pane is reopened rather than replaced", () => {
  // Expired token, pane still there: adopt.
  expect(decide(record(), [workspace("w1")], panes(), KEY)).toMatchObject({
    kind: "adopt",
    proof: "pane",
  });
  // Token live, pane gone: reopen the pane in the workspace that is still ours.
  expect(decide(record(), [workspace("w1", { [HOME_TOKEN]: KEY })], [], KEY)).toMatchObject({
    kind: "reopen",
  });
  // The workspace itself is gone, and nothing else claims the Herd: genuinely nothing
  // to adopt.
  expect(decide(record(), [workspace("w9")], [], KEY)).toMatchObject({ kind: "create" });
  // Nothing at all.
  expect(decide(null, [], [], KEY)).toMatchObject({ kind: "create" });
});

test("a vanished workspace is not a licence to make a second board beside a live token", () => {
  // The record names w1, which is gone — but w2 carries this Herd's token, so either a
  // human adopted it or the record is behind. Creating w3 here is the one thing SPEC
  // §7.12 exists to stop: two boards, both saying they are this Herd's.
  expect(decide(record(), [workspace("w2", { [HOME_TOKEN]: KEY })], [], KEY)).toMatchObject({
    kind: "ownership_unknown",
    candidates: ["w2"],
  });
  // Same for a record left mid-create: the crash is not the only fact about the Herd.
  expect(
    decide(
      record({ state: "creating", paneId: null, terminalId: null }),
      [workspace("w1"), workspace("w2", { [HOME_TOKEN]: KEY })],
      [],
      KEY,
    ),
  ).toMatchObject({ kind: "ownership_unknown", candidates: ["w1", "w2"] });
  // And with nothing else claiming it, a mid-create record still creates without asking.
  expect(
    decide(
      record({ state: "creating", paneId: null, terminalId: null }),
      [workspace("w1")],
      [],
      KEY,
    ),
  ).toMatchObject({ kind: "create", orphan: "w1" });
});

/** A herdr that records what it was asked, with whatever it currently has. */
function fake(initial: { workspaces?: WorkspaceInfo[]; panes?: PaneInfo[] } = {}) {
  const calls: string[] = [];
  const state = { workspaces: initial.workspaces ?? [], panes: initial.panes ?? [] };
  const deps = {
    workspaces: Effect.sync(() => state.workspaces),
    panes: Effect.sync(() => state.panes),
    createWorkspace: (opts) =>
      Effect.sync(() => {
        calls.push(`createWorkspace ${opts.cwd} ${opts.label}`);
        state.workspaces = [...state.workspaces, workspace("w-new")];
        // herdr gives a new workspace a shell of its own, which is the tab a Home must
        // not be left with beside its own.
        state.panes = [
          ...state.panes,
          pane({ paneId: "9-shell", tabId: "9-shell", workspaceId: "w-new" }),
        ];
        return "w-new";
      }),
    openPane: (workspaceId, _cwd, beside = null) =>
      Effect.sync(() => {
        calls.push(`openPane ${workspaceId}${beside === null ? "" : ` beside ${beside}`}`);
        const opened = pane({ paneId: "9-1", tabId: "9", workspaceId, terminalId: "term-9" });
        state.panes = [...state.panes, opened];
        return { tabId: opened.tabId, paneId: opened.paneId };
      }),
    splitPane: (opts) =>
      Effect.sync(() => {
        calls.push(`splitPane ${opts.paneId} ${opts.ratio.toFixed(3)}`);
        const source = state.panes.find((entry) => entry.paneId === opts.paneId);
        const opened = pane({
          paneId: `${opts.paneId}-chat`,
          tabId: source?.tabId ?? "9",
          workspaceId: source?.workspaceId ?? "w-new",
          terminalId: `term-${opts.paneId}-chat`,
        });
        state.panes = [...state.panes, opened];
        return opened.paneId;
      }),
    markWorkspace: (workspaceId, tokens) =>
      Effect.sync(() => {
        calls.push(
          `markWorkspace ${workspaceId} ${Object.entries(tokens)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")}`,
        );
      }),
    markPane: (paneId) =>
      Effect.sync(() => {
        calls.push(`markPane ${paneId}`);
      }),
    closePane: (paneId) =>
      Effect.sync(() => {
        calls.push(`closePane ${paneId}`);
        state.panes = state.panes.filter((entry) => entry.paneId !== paneId);
      }),
    log: () => Effect.void,
  } satisfies { -readonly [K in keyof HomeDeps]: HomeDeps[K] };
  return { calls, deps, state };
}

test("a first ensure creates one Home, and records it before the pane exists", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured.kind).toBe("ready");

      // The order is the point: the record names the workspace before anything is opened
      // in it, so a crash between the two leaves something attributable.
      expect(h.calls[0]).toBe("createWorkspace /ns 🐕 Collie");
      // Tokened before the pane, so a pane herdr refuses still leaves a workspace that
      // says whose it is.
      expect(h.calls[1]).toBe(`markWorkspace w-new collie_home=${KEY}`);
      expect(h.calls[2]).toBe("openPane w-new");
      expect(h.calls.filter((call) => call.startsWith("createWorkspace"))).toHaveLength(1);

      const written = yield* readHome(yield* homePath(stateDir, KEY));
      expect(written).toMatchObject({
        workspaceId: "w-new",
        paneId: "9-1",
        terminalId: "term-9",
        state: "ready",
      });
    }),
  ));

test("a workspace herdr would not create is not written down as a Home", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      // Every failure of `workspace.create` arrives as an empty id. Written down as a
      // `ready` Home it would send callers to focus a workspace that is not there, and
      // every later ensure would decide `create` again — one more attempt per launch.
      h.deps.createWorkspace = () =>
        Effect.sync(() => {
          h.calls.push("createWorkspace refused");
          return "";
        });

      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured).toMatchObject({ kind: "ownership_unknown", candidates: [] });
      expect(h.calls).not.toContain("openPane ");
      // Nothing on disk: the record stays whatever it was, for a human to settle.
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toBeNull();
    }),
  ));

test("a pane herdr would not open leaves a creating record the next ensure finishes", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      let refuse = true;
      const open = h.deps.openPane;
      const deps: HomeDeps = {
        ...h.deps,
        openPane: (workspaceId, cwd, beside) =>
          refuse
            ? Effect.sync(() => {
                h.calls.push(`openPane ${workspaceId} refused`);
                return { tabId: null, paneId: null };
              })
            : open(workspaceId, cwd, beside),
      };

      // The workspace was made and is tokened as this Herd's; the pane was not. That is
      // not a Home, and it is not a human's to reconcile either.
      const first = yield* ensureHome(stateDir, KEY, "/ns", deps);
      expect(first).toMatchObject({ kind: "incomplete", record: { workspaceId: "w-new" } });
      expect(h.calls).toContain(`markWorkspace w-new collie_home=${KEY}`);
      const left = yield* readHome(yield* homePath(stateDir, KEY));
      expect(left).toMatchObject({ workspaceId: "w-new", state: "creating", paneId: null });
      // The fake's markWorkspace records the call and not the token, so the Herd's claim
      // on the workspace is what the next look at herdr has to show.
      h.state.workspaces = [{ ...workspace("w-new"), tokens: { collie_home: KEY } }];

      // Next time: the same workspace, its pane opened, and `ready` — no second workspace.
      refuse = false;
      const second = yield* ensureHome(stateDir, KEY, "/ns", deps);
      expect(second).toMatchObject({
        kind: "ready",
        record: { workspaceId: "w-new", paneId: "9-1" },
      });
      expect(h.calls.filter((call) => call.startsWith("createWorkspace"))).toHaveLength(1);
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({ state: "ready" });
    }),
  ));

test("a reopened Home records the terminal of the pane it just opened", () =>
  runEffect(
    Effect.gen(function* () {
      // Token live, pane gone: `reopen`. The terminal of the new pane is what ownership
      // proof (ii) rests on once the token lapses, so a null here is a Home that can
      // only prove itself until the TTL runs out.
      yield* writeHome(yield* homePath(stateDir, KEY), record({ terminalId: "term-old" }));
      const h = fake({ workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })], panes: [] });
      expect((yield* ensureHome(stateDir, KEY, "/ns", h.deps)).kind).toBe("ready");
      expect(h.calls).toContain("openPane w1");
      expect(h.calls.filter((call) => call.startsWith("createWorkspace"))).toHaveLength(0);
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({
        workspaceId: "w1",
        paneId: "9-1",
        terminalId: "term-9",
        state: "ready",
      });
    }),
  ));

test("an expired token on a Home whose pane is still there refreshes it, and creates nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeHome(yield* homePath(stateDir, KEY), record());
      // No token on the workspace: it lapsed. The pane is still what Collie opened.
      const h = fake({ workspaces: [workspace("w1")], panes: panes() });

      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured.kind).toBe("ready");
      expect(h.calls.some((call) => call.startsWith("createWorkspace"))).toBe(false);
      expect(h.calls).toContain(`markWorkspace w1 ${HOME_TOKEN}=${KEY}`);
    }),
  ));

test("a workspace this Herd never recorded is not adopted, whatever it carries", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ workspaces: [workspace("someone-elses", { [HOME_TOKEN]: KEY })] });
      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured).toMatchObject({
        kind: "ownership_unknown",
        candidates: ["someone-elses"],
      });
      // Nothing was created either: two boards for one Herd is the other failure.
      expect(h.calls).toEqual([]);
    }),
  ));

test("the server record notices herdr moving, and invents no epoch for it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* serverPath(stateDir, KEY);
      expect(yield* writeServer(file, { socket: "/s", version: "0.9.0", protocol: 20 })).toBeNull();
      expect(yield* writeServer(file, { socket: "/s", version: "0.9.0", protocol: 20 })).toBeNull();
      expect(yield* writeServer(file, { socket: "/s", version: "0.10.0", protocol: 21 })).toContain(
        "0.9.0 (protocol 20) to 0.10.0 (protocol 21)",
      );

      // No pid and no start time: `status server` exposes neither, so recording one
      // would be inventing it.
      const written = yield* fs.readFileString(file);
      expect(written).not.toContain("pid");
      expect(written).not.toContain("started");
    }),
  ));

test("a herdr without what the Home rests on is refused, with no label-only fallback", () => {
  const properties = (fields: ReadonlyArray<string>) =>
    Object.fromEntries(fields.map((field) => [field, { type: "string" }]));
  const schema = (workspaceInfo: ReadonlyArray<string>, paneInfo: ReadonlyArray<string>): string =>
    JSON.stringify({
      methods: ["workspace.report_metadata", "pane.report_metadata", "workspace.create"],
      schemas: {
        request: {
          $defs: {
            WorkspaceInfo: { properties: properties(workspaceInfo) },
            PaneInfo: { properties: properties(paneInfo) },
          },
        },
      },
    });
  const complete = schema(["tokens"], ["tokens", "terminal_id"]);
  expect(missingRuntime(complete)).toEqual([]);

  // A method missing is named as itself.
  expect(missingRuntime(complete.replace("workspace.report_metadata", ""))).toEqual([
    "workspace.report_metadata",
  ]);
  // The fields are wanted on the types the ownership proof reads them from, and nowhere
  // else: a binary that names them on something else has nothing Collie can use.
  expect(missingRuntime(schema([], ["tokens", "terminal_id"]))).toEqual(["WorkspaceInfo.tokens"]);
  expect(missingRuntime(schema(["tokens"], ["tokens"]))).toEqual(["PaneInfo.terminal_id"]);
  // Not a schema at all: every typed field is missing rather than assumed.
  expect(missingRuntime("workspace.report_metadata pane.report_metadata workspace.create")).toEqual(
    [
      "WorkspaceInfo",
      "PaneInfo",
      "WorkspaceInfo.tokens",
      "PaneInfo.tokens",
      "PaneInfo.terminal_id",
    ],
  );
});

test("cleanup closes a legacy pane that is alone, and only lists one that is not", () => {
  const legacy = { [LEGACY_PANE_TOKEN]: "legacy" };
  const panes = [
    pane({ paneId: "a-1", tabId: "a", tokens: legacy }),
    pane({ paneId: "b-1", tabId: "b", tokens: legacy }),
    // Somebody else's pane, sharing tab b: closing b-1 would take their window away.
    pane({ paneId: "b-2", tabId: "b", tokens: {} }),
    pane({ paneId: "c-1", tabId: "c", tokens: {} }),
  ];
  expect(closable(panes)).toEqual({ close: ["a-1"], listed: ["b-1"] });
});

test("the shortcut records where it was pressed, and forgets it a minute later", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectory();
      const file = yield* originPath(stateDir, KEY);

      // Nothing recorded is nothing to narrow to, not an error.
      expect(yield* readOrigin(file)).toBeNull();

      yield* writeOrigin(file, { workspaceId: "w7", cwd: "/w/collie", filter: null });
      const fresh = yield* readOrigin(file);
      expect(fresh).toEqual({ workspaceId: "w7", cwd: "/w/collie", filter: null });

      // Stale: the shortcut is what records it, so an origin nobody pressed a minute
      // ago says nothing about the board somebody is looking at now.
      const old = yield* fs.readFileString(file);
      const long = DateTime.formatIso(
        DateTime.subtract(DateTime.makeUnsafe(yield* Clock.currentTimeMillis), { minutes: 2 }),
      );
      yield* fs.writeFileString(file, old.replace(/"at":"[^"]+"/, `"at":"${long}"`));
      expect(yield* readOrigin(file)).toBeNull();
    }),
  ));

test("the Home is one tab: the board on the left, native chat on the right", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const ensured = yield* ensureHome(stateDir, KEY, "/ns", h.deps);
      expect(ensured.kind).toBe("ready");
      // One workspace, one pane opened, and the second made by splitting the first —
      // not a second tab and not a second plugin pane.
      expect(h.calls.filter((call) => call.startsWith("openPane"))).toHaveLength(1);
      expect(h.calls).toContain(`splitPane 9-1 ${BOARD_RATIO.toFixed(3)}`);
      // And the shell herdr made the workspace with is gone: a normal Home is one tab,
      // not Collie's beside a blank one nobody asked for.
      expect(h.calls).toContain("closePane 9-shell");
      expect(h.state.panes.map((entry) => entry.paneId)).not.toContain("9-shell");
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({
        paneId: "9-1",
        chatPaneId: "9-1-chat",
        chatTerminalId: "term-9-1-chat",
        tabId: "9",
      });
    }),
  ));

test("a Home recorded before native chat gains the pane without losing the board", () =>
  runEffect(
    Effect.gen(function* () {
      // What an installation upgrading onto this release has: a board pane, and no chat.
      const { chatPaneId: _pane, chatTerminalId: _terminal, ...legacy } = record();
      yield* writeHome(yield* homePath(stateDir, KEY), legacy);

      expect(decide(legacy, [workspace("w1", { [HOME_TOKEN]: KEY })], [pane()], KEY)).toMatchObject(
        { kind: "reopen", missing: ["chat"] },
      );

      const h = fake({ workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })], panes: [pane()] });
      expect((yield* ensureHome(stateDir, KEY, "/ns", h.deps)).kind).toBe("ready");
      // The board pane is the one that was there: reopening it would have replaced a
      // live board to add a pane beside it.
      expect(h.calls.filter((call) => call.startsWith("openPane"))).toEqual([]);
      expect(h.calls).toContain(`splitPane 1-1 ${BOARD_RATIO.toFixed(3)}`);
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({
        paneId: "1-1",
        chatPaneId: "1-1-chat",
      });
    }),
  ));

test("opening a live Home again changes nothing about its layout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeHome(yield* homePath(stateDir, KEY), record());
      const h = fake({ workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })], panes: panes() });
      expect((yield* ensureHome(stateDir, KEY, "/ns", h.deps)).kind).toBe("ready");
      // Neither pane is reopened and nothing is split: a human who dragged the divider
      // keeps where they put it.
      expect(h.calls.some((call) => call.startsWith("openPane"))).toBe(false);
      expect(h.calls.some((call) => call.startsWith("splitPane"))).toBe(false);
      // And nothing is closed: only a workspace Collie has just made has a shell of
      // herdr's to tidy, and a tab a human added later is theirs.
      expect(h.calls.some((call) => call.startsWith("closePane"))).toBe(false);
    }),
  ));

test("a split herdr will not do leaves a board that still works", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const deps: HomeDeps = { ...h.deps, splitPane: () => Effect.succeed("") };
      const ensured = yield* ensureHome(stateDir, KEY, "/ns", deps);
      // A Home with no conversation is still a control plane. Recorded as having none,
      // so the next launch tries again rather than adopting whatever is in that slot.
      expect(ensured).toMatchObject({ kind: "ready" });
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({
        paneId: "9-1",
        chatPaneId: null,
      });
    }),
  ));

test("a board reopened while its chat is still there is split into the chat's tab", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeHome(yield* homePath(stateDir, KEY), record());
      // The board pane went; the chat pane did not. Reopening in a tab of its own would
      // leave the Home as two tabs, which is not a Home.
      const h = fake({
        workspaces: [workspace("w1", { [HOME_TOKEN]: KEY })],
        panes: [pane({ paneId: "1-2", terminalId: "term-2" })],
      });
      expect((yield* ensureHome(stateDir, KEY, "/ns", h.deps)).kind).toBe("ready");
      expect(h.calls).toContain("openPane w1 beside 1-2");
      expect(yield* readHome(yield* homePath(stateDir, KEY))).toMatchObject({
        paneId: "9-1",
        chatPaneId: "1-2",
        state: "ready",
      });
    }),
  ));
