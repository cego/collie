import { describe, expect, test } from "bun:test";
import { inField } from "../desktop/src/shared/board-clicks";
import {
  FOLLOWING_LOG,
  type KeyFacts,
  keyAction,
  landingOf,
  logPlaceOf,
  logScrollTop,
  recordTabs,
  rememberScroll,
  scrollToRestore,
  type SummaryFacts,
  summaryOf,
  type TabFacts,
  tabBeside,
  tabShown,
  tabsKept,
  typedIn,
  videoPlays,
} from "../desktop/src/shared/record";

const everything: TabFacts = {
  loaded: true,
  plan: true,
  reviewText: true,
  findings: true,
  target: false,
  diff: true,
  terminal: true,
  mr: "MR !12",
};

const values = (facts: Partial<TabFacts>) =>
  recordTabs({ ...everything, ...facts }).map(({ value }) => value);

describe("the record's tabs", () => {
  test("Flow comes before Summary when the host supplies it", () => {
    const tabs = recordTabs({ ...everything, flow: true });
    expect(tabs.slice(0, 2)).toEqual([
      { label: "Flow", value: "flow" },
      { label: "Summary", value: "summary" },
    ]);
    expect(tabShown(tabs, undefined)).toBe("flow");
  });
  test("for a Run with everything start with Summary and end with Facts", () => {
    expect(recordTabs(everything)).toEqual([
      { label: "Summary", value: "summary" },
      { label: "Plan", value: "plan" },
      { label: "Review", value: "review" },
      { label: "Diff", value: "diff" },
      { label: "Evidence", value: "evidence" },
      { label: "Log", value: "log" },
      { label: "Terminal", value: "terminal" },
      { label: "MR !12", value: "mr" },
      { label: "Facts", value: "facts" },
    ]);
  });

  test("leave out Plan and Diff where there are none", () => {
    expect(values({ plan: false, diff: false })).toEqual([
      "summary",
      "review",
      "evidence",
      "log",
      "terminal",
      "mr",
      "facts",
    ]);
  });

  test("keep Review for a followed target alone", () => {
    expect(values({ reviewText: false, findings: false })).not.toContain("review");
    expect(values({ reviewText: false, findings: false, target: true })).toContain("review");
  });

  test("are only Log, Terminal and Facts without the Run's details", () => {
    expect(
      values({
        loaded: false,
        plan: false,
        reviewText: false,
        findings: false,
        diff: false,
        mr: null,
      }),
    ).toEqual(["log", "terminal", "facts"]);
    expect(values({ loaded: false, target: true, terminal: false, mr: null })).toEqual([
      "log",
      "facts",
    ]);
  });
});

describe("the tab shown", () => {
  const tabs = recordTabs(everything);

  test("is Summary when none is chosen", () => {
    expect(tabShown(tabs, undefined)).toBe("summary");
  });

  test("is the chosen tab while it is present", () => {
    expect(tabShown(tabs, "diff")).toBe("diff");
  });

  test("falls back to the first tab when the chosen one goes", () => {
    expect(tabShown(recordTabs({ ...everything, diff: false }), "diff")).toBe("summary");
    expect(tabShown(recordTabs({ ...everything, loaded: false }), "plan")).toBe("log");
  });
});

describe("what the Summary shows", () => {
  const bare: SummaryFacts = {
    status: "running",
    attention: { category: "none", reason: "working", explanation: "It is working.", actions: [] },
    outcome: { kind: null, gaps: [], obstacle: null, next: null, delivered: null },
    steps: [],
    inputs: [],
  };
  const full: SummaryFacts = {
    status: "waiting",
    attention: {
      category: "question",
      reason: "decision",
      explanation: "The implementer asks which `base` to use.",
      actions: ["answer"],
    },
    outcome: {
      kind: "feature",
      gaps: ["check: bun run check"],
      obstacle: "A question is open.",
      next: "Answer it with `collie run answer`.",
      delivered: "Nothing yet.",
    },
    steps: [
      { id: "plan", status: "done", note: "3 tickets", took: "4m", agents: ["planner-r1"] },
      { id: "build", status: "running", note: "", took: null, agents: [] },
    ],
    inputs: [
      { name: "plan-dir", value: "/runs/r/plan", source: "given" },
      { name: "outcome", value: "feature", source: "inferred" },
    ],
  };

  test("for a full Run are status, attention, outcome and Inputs, without obsolete steps", () => {
    expect(summaryOf(full)).toEqual([
      { section: "status", status: "waiting" },
      {
        section: "attention",
        category: "question",
        explanation: "The implementer asks which `base` to use.",
      },
      {
        section: "outcome",
        kind: "feature",
        gaps: ["check: bun run check"],
        obstacle: "A question is open.",
        next: "Answer it with `collie run answer`.",
        delivered: "Nothing yet.",
      },
      {
        section: "inputs",
        inputs: [
          { name: "plan-dir", value: "/runs/r/plan", source: "given" },
          { name: "outcome", value: "feature", source: "inferred" },
        ],
      },
    ]);
  });

  test("leave out attention whose category is none", () => {
    expect(summaryOf({ ...full, attention: bare.attention }).map(({ section }) => section)).toEqual(
      ["status", "outcome", "inputs"],
    );
  });

  test("keep an outcome with no gaps, with nothing to list", () => {
    const outcome = summaryOf({ ...full, outcome: { ...full.outcome, gaps: [] } }).find(
      ({ section }) => section === "outcome",
    );
    expect(outcome).toEqual({
      section: "outcome",
      kind: "feature",
      gaps: [],
      obstacle: "A question is open.",
      next: "Answer it with `collie run answer`.",
      delivered: "Nothing yet.",
    });
  });

  test("for a Run with only a status are its status", () => {
    expect(summaryOf(bare)).toEqual([{ section: "status", status: "running" }]);
  });
});

describe("scroll memory", () => {
  const none = new Map<string, number>();

  test("starts a tab's first visit at the top", () => {
    expect(scrollToRestore(none, "plan")).toBe(0);
  });

  test("restores a tab where it was left", () => {
    expect(scrollToRestore(rememberScroll(none, "plan", 640), "plan")).toBe(640);
  });

  test("keeps two tabs apart", () => {
    const memory = rememberScroll(rememberScroll(none, "plan", 640), "diff", 2400);
    expect(scrollToRestore(memory, "plan")).toBe(640);
    expect(scrollToRestore(memory, "diff")).toBe(2400);
    expect(scrollToRestore(rememberScroll(memory, "plan", 0), "diff")).toBe(2400);
  });

  test("never records or restores Terminal", () => {
    const memory = rememberScroll(none, "terminal", 300);
    expect(memory.has("terminal")).toBe(false);
    expect(scrollToRestore(memory, "terminal")).toBeNull();
  });
});

describe("the tabs kept mounted", () => {
  const none = new Set<string>();

  test("are every tab visited, so what was opened in one is there on return", () => {
    const kept = tabsKept(tabsKept(tabsKept(none, "plan"), "evidence"), "plan");
    expect([...kept]).toEqual(["plan", "evidence"]);
  });

  test("never include Terminal or Log, which keep their own place", () => {
    expect([...tabsKept(tabsKept(none, "terminal"), "log")]).toEqual([]);
  });
});

describe("an Evidence video", () => {
  test("plays only while Evidence is shown, so one read after leaving it stays still", () => {
    expect(videoPlays("evidence")).toBe(true);
    expect(videoPlays("summary")).toBe(false);
  });
});

describe("the Log's place", () => {
  test("follows the end at first", () => {
    expect(logScrollTop(FOLLOWING_LOG, 5000)).toBe(5000);
  });

  test("is where the human scrolled up to read, shown there again", () => {
    const place = logPlaceOf({ scrollTop: 100, clientHeight: 400, scrollHeight: 5000 });
    expect(place).toEqual({ top: 100, following: false });
    expect(logScrollTop(place, 5200)).toBe(100);
  });

  test("follows the end again once scrolled back down to it", () => {
    const place = logPlaceOf({ scrollTop: 4599, clientHeight: 400, scrollHeight: 5000 });
    expect(place.following).toBe(true);
    expect(logScrollTop(place, 5200)).toBe(5200);
  });
});

describe("where a jump lands", () => {
  const files = ["src/host.ts", "docs/using.md"];

  test("at its line in the diff", () => {
    expect(landingOf({ file: "src/host.ts", line: 12 }, files)).toEqual({
      tab: "diff",
      at: "line",
      file: "src/host.ts",
      line: 12,
    });
  });

  test("at the file in the diff, when there is no line", () => {
    expect(landingOf({ file: "docs/using.md", line: null }, files)).toEqual({
      tab: "diff",
      at: "file",
      file: "docs/using.md",
    });
  });

  test("in the read-only file view on Diff, when the file is not in the diff", () => {
    expect(landingOf({ file: "README.md", line: 3 }, files)).toEqual({
      tab: "diff",
      at: "source",
      file: "README.md",
      line: 3,
    });
  });

  test("in the read-only file view on Review, when there is no diff", () => {
    expect(landingOf({ file: "src/host.ts", line: null }, null)).toEqual({
      tab: "review",
      at: "source",
      file: "src/host.ts",
      line: null,
    });
  });
});

describe("a key in the record", () => {
  const plain: KeyFacts = {
    key: "]",
    ctrlOrMeta: false,
    inField: false,
    overlay: false,
    tab: "diff",
    inRecord: true,
  };
  const action = (facts: Partial<KeyFacts>) => keyAction({ ...plain, ...facts });

  test("[ and ] give the previous and next tab", () => {
    expect(action({ key: "[" })).toBe("previous-tab");
    expect(action({ key: "]" })).toBe("next-tab");
    expect(action({ key: "]", tab: "plan" })).toBe("next-tab");
  });

  test("j and k give the next and previous file on Diff", () => {
    expect(action({ key: "j" })).toBe("next-file");
    expect(action({ key: "k" })).toBe("previous-file");
  });

  test("j and k give nothing off Diff, or in uppercase", () => {
    expect(action({ key: "j", tab: "plan" })).toBeNull();
    expect(action({ key: "k", tab: "review" })).toBeNull();
    expect(action({ key: "J" })).toBeNull();
    expect(action({ key: "K" })).toBeNull();
  });

  test("gives nothing with Ctrl or Meta, but Alt does not stop it", () => {
    expect(action({ ctrlOrMeta: true })).toBeNull();
    expect(action({ key: "j", ctrlOrMeta: true })).toBeNull();
    // What Alt or AltGr typed is the key itself: `]` on a Nordic layout.
    expect(action({ key: "]" })).toBe("next-tab");
  });

  test("gives nothing typed in a field, with an overlay open, on Terminal or outside the record", () => {
    expect(action({ inField: true })).toBeNull();
    expect(action({ overlay: true })).toBeNull();
    expect(action({ tab: "terminal" })).toBeNull();
    expect(action({ inRecord: false })).toBeNull();
  });

  test("gives nothing for any other key, Escape included", () => {
    expect(action({ key: "Escape" })).toBeNull();
    expect(action({ key: "x" })).toBeNull();
  });
});

describe("the element a key was typed in", () => {
  const found = { getAttribute: () => null, hasAttribute: () => false };
  const field = {
    closest: (selectors: string) => (selectors.includes("textarea") ? found : null),
  };
  const shadowHost = { closest: () => null };

  test("is the first of the composed path, a field inside a shadow root", () => {
    const path = [field, null, shadowHost];
    expect(inField(typedIn(path))).toBe(true);
    expect(inField(typedIn([shadowHost]))).toBe(false);
  });

  test("is nothing when the path does not start with an element", () => {
    expect(typedIn([])).toBeNull();
    expect(typedIn([null, shadowHost])).toBeNull();
  });
});

describe("the tab beside the one shown", () => {
  const tabs = recordTabs(everything);

  test("steps through the tabs, skipping Terminal", () => {
    expect(tabBeside(tabs, "summary", 1)).toBe("plan");
    expect(tabBeside(tabs, "plan", -1)).toBe("summary");
    expect(tabBeside(tabs, "log", 1)).toBe("mr");
    expect(tabBeside(tabs, "mr", -1)).toBe("log");
  });

  test("stops at the first and last tab", () => {
    expect(tabBeside(tabs, "summary", -1)).toBeNull();
    expect(tabBeside(tabs, "facts", 1)).toBeNull();
  });
});
