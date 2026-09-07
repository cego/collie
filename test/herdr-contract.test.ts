// Collie decodes herdr's JSON with hand-written structs. This checks them against
// herdr's own published schema (`herdr api schema --json`), so a renamed or retyped
// field turns a test red instead of a workflow.

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import type { SocketMethod } from "../src/herdr";
import { replySchemas, SOCKET_METHODS } from "../src/herdr";
import type { ReplyLocation } from "./support/contract";
import { loadContract } from "./support/contract";
import { runEffect } from "./support/effect";

const repoFile = (name: string) => new URL(`../${name}`, import.meta.url).pathname;

const pin = await runEffect(
  Effect.promise(() => Bun.file(repoFile("herdr-pin.json")).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ protocol: Schema.Number }))),
    Effect.orDie,
  ),
);

const contract = await runEffect(
  loadContract(Bun.env.HERDR_API_SCHEMA ?? repoFile("herdr-api-schema.json")),
);

/**
 * Every reply `herdr.ts` decodes, and where in herdr's schema that reply is described:
 * `envelope` names the `ResponseResult` variant herdr answers the call with, the other
 * two locate an envelope-level struct directly. The rule "adding a decoded call means
 * adding a row" is enforced by the first test below rather than left to a comment.
 */
const replies = {
  ErrorReply: { of: replySchemas.ErrorReply, at: { in: "error_response", def: "ErrorBody" } },
  SocketReply: { of: replySchemas.SocketReply, at: { schema: "success_response" } },
  TabCreateReply: { of: replySchemas.TabCreateReply, at: { envelope: "tab_created" } },
  WorkspaceListReply: { of: replySchemas.WorkspaceListReply, at: { envelope: "workspace_list" } },
  TabListReply: { of: replySchemas.TabListReply, at: { envelope: "tab_list" } },
  PaneListReply: { of: replySchemas.PaneListReply, at: { envelope: "pane_list" } },
  PaneSplitReply: { of: replySchemas.PaneSplitReply, at: { envelope: "pane_info" } },
  AgentListReply: { of: replySchemas.AgentListReply, at: { envelope: "agent_list" } },
  AgentStatusReply: { of: replySchemas.AgentStatusReply, at: { envelope: "agent_info" } },
  WorktreeListReply: { of: replySchemas.WorktreeListReply, at: { envelope: "worktree_list" } },
  WorktreeOpenReply: { of: replySchemas.WorktreeOpenReply, at: { envelope: "worktree_opened" } },
  PluginPaneReply: { of: replySchemas.PluginPaneReply, at: { envelope: "plugin_pane_opened" } },
  // `worktree create` answers under a different tag, and Collie decodes both with the one
  // struct, so it is checked against both variants. The tab that only `create` may answer
  // with is optional there for that reason: herdr describes `worktree_created` twice, with
  // those keys and without.
  "WorktreeOpenReply (create)": {
    of: replySchemas.WorktreeOpenReply,
    at: { envelope: "worktree_created" },
  },
} satisfies Record<string, { of: Schema.Top; at: ReplyLocation }>;

/**
 * The params each socket method in `src/herdr.ts` actually sends. Keyed by
 * `SocketMethod`, so a method added to `SOCKET_METHODS` without a row here does not
 * compile — and `rpc` takes nothing that is not in that list.
 */
const requests = {
  "workspace.focus": { workspace_id: "w28" },
  "tab.move": { tab_id: "1:2", insert_index: 0 },
  "agent.view.set": {
    source: "cego.collie",
    label: "plan/goal",
    filter: { op: "in", field: "pane_id", values: ["1-1", "1-2"] },
  },
  "agent.view.clear": { source: "cego.collie" },
  "popup.close": {},
} satisfies Record<SocketMethod, Schema.JsonObject>;

// Only meaningful for the committed snapshot; a fresh schema printed by some other
// herdr legitimately carries another protocol.
test.skipIf(Bun.env.HERDR_API_SCHEMA !== undefined)(
  "the snapshot is the protocol the pin records",
  () => expect(contract.protocol).toBe(pin.protocol),
);

test("every reply herdr.ts decodes has a row above", () => {
  expect(Object.keys(replySchemas).filter((name) => !(name in replies))).toEqual([]);
});

test("every socket method herdr.ts calls has a row above", () => {
  expect(SOCKET_METHODS.filter((method) => !(method in requests))).toEqual([]);
});

describe("reply structs accept everything herdr may send", () => {
  for (const [name, { of, at }] of Object.entries(replies)) {
    test(name, () => {
      expect(contract.replyFindings(name, of, at)).toEqual([]);
    });
  }
});

describe("socket requests satisfy herdr's request schema", () => {
  for (const [method, params] of Object.entries(requests)) {
    test(method, () => {
      expect(contract.requestFindings(method, params)).toEqual([]);
    });
  }
});

test("a struct requiring a field herdr marks optional is reported", () => {
  const wrong = Schema.Struct({
    result: Schema.Struct({
      // herdr declares `label` on an agent view, but does not guarantee it.
      active: Schema.Boolean,
      label: Schema.NullOr(Schema.String),
    }),
  });
  expect(contract.replyFindings("Wrong", wrong, { envelope: "agent_view" })).toEqual([
    "Wrong.result.label is required, but herdr does not guarantee it",
  ]);
});

test("a struct declaring the wrong primitive type is reported", () => {
  const wrong = Schema.Struct({
    result: Schema.Struct({ tabs: Schema.Array(Schema.Struct({ tab_id: Schema.Number })) }),
  });
  expect(contract.replyFindings("Wrong", wrong, { envelope: "tab_list" })).toEqual([
    "Wrong.result.tabs[].tab_id is number, but herdr sends string",
  ]);
});

// herdr writes a nullable struct as `anyOf: [<the struct>, null]`, and reading the
// wrapper's own `properties` found none — so every field under a nullable object went
// unchecked. `WorkspaceReply.worktree` is one of those.
test("drift inside a nullable object is reported", () => {
  const wrong = Schema.Struct({
    result: Schema.Struct({
      workspaces: Schema.Array(
        Schema.Struct({
          worktree: Schema.optionalKey(
            Schema.NullOr(Schema.Struct({ checkout_path: Schema.optionalKey(Schema.Number) })),
          ),
        }),
      ),
    }),
  });
  expect(contract.replyFindings("Wrong", wrong, { envelope: "workspace_list" })).toEqual([
    "Wrong.result.workspaces[].worktree.checkout_path is number, but herdr sends string",
  ]);
});

// Two or more branches carrying `properties` is a shape this check has no way to
// compare, and it used to pass over them in silence. `success_response.result` is one:
// herdr describes it as any of its reply variants. The count is not asserted — it is
// whatever herdr happens to answer today, and this test runs against the newest herdr
// in the scheduled jobs too. `SocketReply` maps here in the table above and is fine,
// because it decodes `result` as `Schema.Json` and so asks nothing of the object.
test("an object herdr describes as several alternatives is reported, not skipped", () => {
  const probe = Schema.Struct({ result: Schema.Struct({ tab_id: Schema.String }) });
  expect(contract.replyFindings("Probe", probe, { schema: "success_response" })).toEqual([
    expect.stringMatching(
      /^Probe\.result is \d+ alternative objects in herdr's schema, which this check cannot compare$/,
    ),
  ]);
});

// The mirror of the above on our own side: a struct that decodes one field as either of
// two objects gives the walker no single shape to compare, so it says so instead of
// picking the first and leaving the other unchecked. Nothing in `replySchemas` is shaped
// like this today — the point is that it cannot start being so unnoticed.
test("a struct offering several objects for one field is reported, not skipped", () => {
  const probe = Schema.Struct({
    result: Schema.Union([
      Schema.Struct({ tabs: Schema.Array(Schema.Struct({ tab_id: Schema.String })) }),
      Schema.Struct({ panes: Schema.Array(Schema.Struct({ pane_id: Schema.String })) }),
    ]),
  });
  expect(contract.replyFindings("Probe", probe, { envelope: "tab_list" })).toEqual([
    "Probe.result is 2 alternative objects in Collie's struct, which this check cannot compare",
  ]);
});

// A tuple has the same AST tag as an array but keeps its element schemas per position
// in `elements`, not in `rest`. Reading `rest` alone counted the field as compared and
// checked none of it. herdr describes array elements only with `items`, which applies to
// every position, so each element has to decode that same thing.
test("each element of a tuple is checked against what herdr sends", () => {
  const probe = Schema.Struct({
    result: Schema.Struct({
      tabs: Schema.Tuple([Schema.Struct({ tab_id: Schema.Number }), Schema.String]),
    }),
  });
  expect(contract.replyFindings("Probe", probe, { envelope: "tab_list" })).toEqual([
    "Probe.result.tabs[0].tab_id is number, but herdr sends string",
    "Probe.result.tabs[1] is string, but herdr sends object",
  ]);
});

// Literals are named by the same table as every other JSON value, which has no
// `integer` row: JSON has no integer type, and whether herdr's `integer` is satisfied is
// a question about a value, not a type name. A `bigint` literal is not JSON at all, so
// it could never match anything herdr sends, and refusing it beats quietly calling it an
// integer and comparing it as though it could.
test("a literal is compared as its JSON type, and a bigint literal is refused", () => {
  const inTabs = (tabId: Schema.Top) =>
    Schema.Struct({
      result: Schema.Struct({ tabs: Schema.Array(Schema.Struct({ tab_id: tabId })) }),
    });

  expect(
    contract.replyFindings("P", inTabs(Schema.Literal("x")), { envelope: "tab_list" }),
  ).toEqual([]);
  expect(contract.replyFindings("P", inTabs(Schema.Literal(1)), { envelope: "tab_list" })).toEqual([
    "P.result.tabs[].tab_id is number, but herdr sends string",
  ]);
  expect(() =>
    contract.replyFindings("P", inTabs(Schema.Literal(1n)), { envelope: "tab_list" }),
  ).toThrow();
});

test("a request carrying a param herdr's schema rejects is reported", () => {
  expect(contract.requestFindings("tab.move", { tab_id: "1:2", insert_index: "0" })).toEqual([
    "tab.move.insert_index is string, but herdr expects integer",
  ]);
});

// herdr declares `insert_index` as `integer` with `minimum: 0`. A JSON number is the
// right shape for both, so the type comparison alone passed anything numeric.
test("a request number outside what herdr's schema allows is reported", () => {
  expect(contract.requestFindings("tab.move", { tab_id: "1:2", insert_index: 1.5 })).toEqual([
    "tab.move.insert_index is 1.5, but herdr expects a whole number",
  ]);
  expect(contract.requestFindings("tab.move", { tab_id: "1:2", insert_index: -1 })).toEqual([
    "tab.move.insert_index is -1, but herdr's minimum is 0",
  ]);
});

test("a request missing a param herdr requires is reported", () => {
  expect(contract.requestFindings("tab.move", { tab_id: "1:2" })).toEqual([
    "tab.move.insert_index is required by herdr, but the request omits it",
  ]);
});
