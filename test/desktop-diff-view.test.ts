import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../src/board-model";
import {
  activeFile,
  choiceForEvery,
  closedFolders,
  type DiffTreeNode,
  diffTree,
  filterTree,
  fileBeside,
  fileOpen,
  fileSelected,
  foldersOn,
  type Folders,
  openFolders,
  paneStepped,
  paneWidth,
  reachBy,
  readingHeight,
  rowFacts,
  rowHover,
  rowRoom,
  TREE,
  ticksStillTrue,
  tickViewed,
  untickViewed,
  viewedCount,
  viewedFiles,
} from "../desktop/src/shared/diff-view";

const file = (path: string): DiffFile => ({ path, status: "modified", added: 1, removed: 0 });

const depthFirst = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<string> =>
  Arr.flatMap(nodes, (node) => (node.kind === "file" ? [node.key] : depthFirst(node.children)));

describe("the diff's tree", () => {
  test("lists its files in the order the tree reads, around a folder sharing their prefix", () => {
    const { tree, files } = diffTree(
      Arr.map(["a/b.ts", "a/b/c.ts", "a/b-c.ts", "a/b/d.ts", "a/b0.ts"], file),
    );
    expect(Arr.map(files, ({ path }) => path)).toEqual([
      "a/b.ts",
      "a/b/c.ts",
      "a/b/d.ts",
      "a/b-c.ts",
      "a/b0.ts",
    ]);
    expect(depthFirst(tree)).toEqual(Arr.map(files, ({ path }) => path));
    expect(Arr.map(tree, ({ key }) => key)).toEqual(["a/"]);
  });
});

describe("the diff's tree, merging folder chains", () => {
  const labelled = (nodes: ReadonlyArray<DiffTreeNode>): ReadonlyArray<unknown> =>
    Arr.map(nodes, (node) =>
      node.kind === "file"
        ? node.label
        : { [`${node.label} (${node.key})`]: labelled(node.children) },
    );

  test("draws a chain of single-folder folders as one row, keyed by its deepest folder", () => {
    const { tree, folders } = diffTree(
      Arr.map(
        ["packages/core/modules/nimbus/runtime/a.ts", "packages/core/modules/nimbus/runtime/b.ts"],
        file,
      ),
    );
    expect(labelled(tree)).toEqual([
      {
        "packages/core/modules/nimbus/runtime (packages/core/modules/nimbus/runtime/)": [
          "a.ts",
          "b.ts",
        ],
      },
    ]);
    expect(folders).toEqual(["packages/core/modules/nimbus/runtime/"]);
  });

  test("ends a chain at a folder with two children, and splits it when a file arrives part-way", () => {
    const before = diffTree(Arr.map(["a/b/c/x.ts", "a/b/c/y.ts"], file));
    expect(labelled(before.tree)).toEqual([{ "a/b/c (a/b/c/)": ["x.ts", "y.ts"] }]);
    const after = diffTree(Arr.map(["a/b/c/x.ts", "a/b/c/y.ts", "a/b/z.ts"], file));
    expect(labelled(after.tree)).toEqual([
      { "a/b (a/b/)": [{ "c (a/b/c/)": ["x.ts", "y.ts"] }, "z.ts"] },
    ]);
    expect(after.folders).toEqual(["a/b/", "a/b/c/"]);
  });

  test("leaves a folder holding only a file, and a file at the root, as they are", () => {
    const { tree, folders } = diffTree(Arr.map(["src/only/one.ts", "README.md"], file));
    expect(labelled(tree)).toEqual([{ "src/only (src/only/)": ["one.ts"] }, "README.md"]);
    expect(folders).toEqual(["src/only/"]);
  });

  test("keeps the files' depth-first order", () => {
    const paths = ["p/c/m/n/r/a.ts", "p/c/s/r/b.ts", "p/c/m/n/r/c.ts", "p/c/s/x.ts", "top.md"];
    const { tree, files } = diffTree(Arr.map(paths, file));
    expect(Arr.map(files, ({ path }) => path)).toEqual([
      "p/c/m/n/r/a.ts",
      "p/c/m/n/r/c.ts",
      "p/c/s/r/b.ts",
      "p/c/s/x.ts",
      "top.md",
    ]);
    expect(depthFirst(tree)).toEqual(Arr.map(files, ({ path }) => path));
    expect(labelled(tree)).toEqual([
      {
        "p/c (p/c/)": [
          { "m/n/r (p/c/m/n/r/)": ["a.ts", "c.ts"] },
          { "s (p/c/s/)": [{ "r (p/c/s/r/)": ["b.ts"] }, "x.ts"] },
        ],
      },
      "top.md",
    ]);
  });

  test("merges the chain a filter leaves the same way", () => {
    const { tree } = diffTree(
      Arr.map(
        [
          "packages/core/configs/clients/a.ts",
          "packages/core/configs/clients/b.ts",
          "packages/core/src/runtime/c.ts",
        ],
        file,
      ),
    );
    expect(labelled(filterTree(tree, "packages/core/configs/clients/"))).toEqual([
      { "packages/core/configs/clients (packages/core/configs/clients/)": ["a.ts", "b.ts"] },
    ]);
  });
});

describe("a row's hover text", () => {
  test("is a file's path, then its status and counts", () => {
    expect(
      rowHover({
        kind: "file",
        key: "src/host.ts",
        label: "host.ts",
        file: { path: "src/host.ts", status: "modified", added: 35, removed: 10 },
      }),
    ).toBe("src/host.ts\nmodified, +35 \u221210");
  });

  test("says binary for a file without counts", () => {
    expect(
      rowHover({
        kind: "file",
        key: "logo.png",
        label: "logo.png",
        file: { path: "logo.png", status: "added", added: null, removed: null },
      }),
    ).toBe("logo.png\nadded, binary");
  });

  test("is a folder's full path, merged or not", () => {
    const [merged] = diffTree(Arr.map(["packages/core/modules/nimbus/runtime/a.ts"], file)).tree;
    expect(rowHover(merged!)).toBe("packages/core/modules/nimbus/runtime/");
    const [split] = diffTree(Arr.map(["src/a.ts", "src/b.ts"], file)).tree;
    expect(rowHover(split!)).toBe("src/");
  });
});

describe("the folders on a path", () => {
  test("are every folder above the file, outermost first", () => {
    expect(foldersOn("desktop/view/app/DiffTab.vue")).toEqual([
      "desktop/",
      "desktop/view/",
      "desktop/view/app/",
    ]);
  });

  test("are none for a file at the root", () => {
    expect(foldersOn("README.md")).toEqual([]);
  });
});

describe("the active file", () => {
  const LINE = 40;
  const drawn = [
    { path: "a.ts", top: -300, bottom: -20 },
    { path: "b.ts", top: -8, bottom: 500 },
    { path: "c.ts", top: 512, bottom: 900 },
  ];

  test("is the file whose section spans the reading line", () => {
    expect(activeFile({ sections: drawn, readingLine: LINE, atEnd: false, held: null })).toBe(
      "b.ts",
    );
  });

  const at = (over: Partial<Parameters<typeof activeFile>[0]>) =>
    activeFile({ sections: drawn, readingLine: LINE, atEnd: false, held: null, ...over });

  test("is the file above when the reading line falls in the gap between two", () => {
    expect(at({ readingLine: 505 })).toBe("b.ts");
  });

  test("is the first file while the reading line is above it", () => {
    expect(
      at({
        sections: Arr.map(drawn, (section) => ({
          ...section,
          top: section.top + 400,
          bottom: section.bottom + 400,
        })),
      }),
    ).toBe("a.ts");
  });

  test("is the last file at the end of the scroll, though too short to reach the line", () => {
    const end = [...drawn, { path: "d.ts", top: 912, bottom: 950 }];
    expect(at({ sections: end, readingLine: 600 })).toBe("c.ts");
    expect(at({ sections: end, readingLine: 600, atEnd: true })).toBe("d.ts");
  });

  test("counts a collapsed file by its header", () => {
    const collapsed = [
      { path: "a.ts", top: -60, bottom: -20 },
      { path: "b.ts", top: -8, bottom: 32 },
      { path: "c.ts", top: 44, bottom: 84 },
    ];
    expect(at({ sections: collapsed, readingLine: 20 })).toBe("b.ts");
    expect(at({ sections: collapsed, readingLine: LINE })).toBe("b.ts");
    expect(at({ sections: collapsed, readingLine: 50 })).toBe("c.ts");
  });

  test("is the file a jump holds, whatever the geometry says", () => {
    expect(at({ held: "a.ts" })).toBe("a.ts");
    expect(at({ held: "a.ts", atEnd: true })).toBe("a.ts");
  });

  test("ignores a held file that is no longer drawn", () => {
    expect(at({ held: "gone.ts" })).toBe("b.ts");
  });

  test("is none when no file is drawn", () => {
    expect(at({ sections: [] })).toBeNull();
    expect(at({ sections: [], atEnd: true, held: "a.ts" })).toBeNull();
  });
});

describe("bringing the active row into the tree's reach", () => {
  const box = { top: 100, bottom: 400 };

  test("does not move a row already in view", () => {
    expect(reachBy(box, { top: 100, bottom: 128 })).toBe(0);
    expect(reachBy(box, { top: 372, bottom: 400 })).toBe(0);
  });

  test("scrolls just enough to the nearest edge", () => {
    expect(reachBy(box, { top: 60, bottom: 88 })).toBe(-40);
    expect(reachBy(box, { top: 450, bottom: 478 })).toBe(78);
  });
});

describe("a file being read", () => {
  test("holds about the height its changed lines draw", () => {
    expect(readingHeight({ ...file("a.ts"), added: 3, removed: 2 }, 1000)).toBe(100);
  });

  test("holds at most the record's visible area", () => {
    expect(readingHeight({ ...file("a.ts"), added: 400, removed: 0 }, 600)).toBe(600);
  });

  test("holds one line where nothing is counted", () => {
    expect(readingHeight({ ...file("empty.ts"), added: 0, removed: 0 }, 600)).toBe(20);
    expect(readingHeight({ ...file("logo.png"), added: null, removed: null }, 600)).toBe(20);
  });
});

describe("a file row's facts", () => {
  test("say an added, a deleted and a modified file's status and counts", () => {
    expect(rowFacts({ path: "new.ts", status: "added", added: 12, removed: 0 }, [])).toEqual({
      status: "added",
      lines: { added: 12, removed: 0 },
      drafts: 0,
    });
    expect(rowFacts({ path: "old.ts", status: "deleted", added: 0, removed: 7 }, [])).toEqual({
      status: "deleted",
      lines: { added: 0, removed: 7 },
      drafts: 0,
    });
    expect(rowFacts({ path: "a.ts", status: "modified", added: 3, removed: 2 }, [])).toEqual({
      status: "modified",
      lines: { added: 3, removed: 2 },
      drafts: 0,
    });
  });

  test("say binary for a file without counts", () => {
    expect(
      rowFacts({ path: "logo.png", status: "modified", added: null, removed: null }, []).lines,
    ).toBe("binary");
  });

  test("count the drafts on the file", () => {
    const drafts = ["a.ts", "b.ts", "a.ts"];
    expect(rowFacts(file("a.ts"), drafts).drafts).toBe(2);
    expect(rowFacts(file("c.ts"), drafts).drafts).toBe(0);
  });
});

describe("the tree filtered by a path", () => {
  const { tree } = diffTree(
    Arr.map(["src/ui/Board.tsx", "src/ui/Drawer.tsx", "src/host.ts", "docs/using.md"], file),
  );
  const kept = (text: string) => depthFirst(filterTree(tree, text));

  test("keeps every file under a matching folder, and their folders", () => {
    const narrowed = filterTree(tree, "ui/");
    expect(depthFirst(narrowed)).toEqual(["src/ui/Board.tsx", "src/ui/Drawer.tsx"]);
    expect(Arr.map(narrowed, ({ key, label }) => [key, label])).toEqual([["src/ui/", "src/ui"]]);
  });

  test("keeps a matching file's folders", () => {
    const narrowed = filterTree(tree, "host");
    expect(depthFirst(narrowed)).toEqual(["src/host.ts"]);
    expect(narrowed).toEqual([
      expect.objectContaining({
        key: "src/",
        children: [expect.objectContaining({ key: "src/host.ts" })],
      }),
    ]);
  });

  test("ignores case", () => {
    expect(kept("BOARD")).toEqual(["src/ui/Board.tsx"]);
  });

  test("keeps nothing when nothing matches", () => {
    expect(filterTree(tree, "nowhere")).toEqual([]);
  });

  test("keeps everything when empty", () => {
    expect(filterTree(tree, "")).toEqual(tree);
    expect(filterTree(tree, "  ")).toEqual(tree);
  });
});

describe("the tree's open folders", () => {
  const folders: Folders = {
    all: ["src/", "src/ui/", "docs/"],
    listed: ["src/", "src/ui/"],
    closed: new Set(["src/ui/"]),
    filtering: false,
  };

  test("are all but those the human closed", () => {
    expect(openFolders(folders)).toEqual(["src/", "docs/"]);
    expect(closedFolders(folders, ["src/"])).toEqual(new Set(["src/ui/", "docs/"]));
  });

  test("never count a folder merged into a chain as closed", () => {
    const { folders: all } = diffTree(
      Arr.map(["packages/core/modules/nimbus/runtime/a.ts", "packages/core/src/b.ts"], file),
    );
    const merged: Folders = { all, listed: all, closed: new Set(), filtering: false };
    expect(openFolders(merged)).toEqual([
      "packages/core/",
      "packages/core/modules/nimbus/runtime/",
      "packages/core/src/",
    ]);
    const closed = closedFolders(merged, ["packages/core/", "packages/core/src/"]);
    expect(closed).toEqual(new Set(["packages/core/modules/nimbus/runtime/"]));
    expect(openFolders({ ...merged, closed })).toEqual(["packages/core/", "packages/core/src/"]);
  });

  test("are every folder the filter leaves while it is in effect, which none closes", () => {
    const filtered = { ...folders, filtering: true };
    expect(openFolders(filtered)).toEqual(["src/", "src/ui/"]);
    expect(closedFolders(filtered, ["src/ui/"])).toEqual(new Set(["src/ui/"]));
  });
});

describe("a tree row clicked", () => {
  const click = () => {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) };
    return event;
  };

  test("shows a file's row and leaves the selection to the active file", () => {
    const event = click();
    expect(fileSelected(event, "src/host.ts")).toBe("src/host.ts");
    expect(event.prevented).toBe(true);
  });

  test("shows nothing for a folder's row, which is not selected either", () => {
    const event = click();
    expect(fileSelected(event, "src/ui/")).toBeNull();
    expect(event.prevented).toBe(true);
  });
});

describe("whether a file is open", () => {
  const counted = (path: string, added: number, removed: number): DiffFile => ({
    path,
    status: "modified",
    added,
    removed,
  });
  const binary: DiffFile = { path: "logo.png", status: "modified", added: null, removed: null };
  const none = new Map<string, boolean>();

  test("is open by default for a text file of at most 500 changed lines", () => {
    expect(fileOpen(counted("a.ts", 300, 200), none)).toBe(true);
    expect(fileOpen(counted("a.ts", 0, 0), none)).toBe(true);
  });

  test("starts collapsed for a file of 501 changed lines, or a binary one", () => {
    expect(fileOpen(counted("a.ts", 301, 200), none)).toBe(false);
    expect(fileOpen(binary, none)).toBe(false);
  });

  test("is the human's own choice where there is one", () => {
    expect(fileOpen(counted("a.ts", 1, 0), new Map([["a.ts", false]]))).toBe(false);
    expect(fileOpen(counted("a.ts", 900, 0), new Map([["a.ts", true]]))).toBe(true);
    expect(fileOpen(binary, new Map([["logo.png", true]]))).toBe(true);
  });

  const files = [counted("small.ts", 1, 1), counted("big.ts", 600, 0), binary];
  const openAfter = (choices: ReadonlyMap<string, boolean>, shown = files) =>
    Arr.map(shown, (shownFile) => fileOpen(shownFile, choices));

  test("is every file, big and binary ones too, after Expand all", () => {
    expect(openAfter(choiceForEvery(files, true))).toEqual([true, true, true]);
  });

  test("is no file after Collapse all", () => {
    expect(openAfter(choiceForEvery(files, false))).toEqual([false, false, false]);
  });

  test("is a single choice made after Expand all", () => {
    const choices = new Map(choiceForEvery(files, true)).set("big.ts", false);
    expect(openAfter(choices)).toEqual([true, false, true]);
  });

  test("follows the default rule for a file that arrives after Expand all", () => {
    const choices = choiceForEvery(files, true);
    const arrived = [counted("new.ts", 2, 0), counted("huge.ts", 501, 0)];
    expect(openAfter(choices, [...files, ...arrived])).toEqual([true, true, true, true, false]);
  });
});

describe("the file beside the active one", () => {
  const files = Arr.map(["a.ts", "b.ts", "c.ts"], file);

  test("steps in drawn order", () => {
    expect(fileBeside(files, "a.ts", 1)).toBe("b.ts");
    expect(fileBeside(files, "c.ts", -1)).toBe("b.ts");
  });

  test("stops at the first and last file", () => {
    expect(fileBeside(files, "a.ts", -1)).toBeNull();
    expect(fileBeside(files, "c.ts", 1)).toBeNull();
  });

  test("is the first file while none is active", () => {
    expect(fileBeside(files, null, 1)).toBe("a.ts");
    expect(fileBeside(files, null, -1)).toBe("a.ts");
  });

  test("is nothing with no files", () => {
    expect(fileBeside([], null, 1)).toBeNull();
    expect(fileBeside([], "a.ts", -1)).toBeNull();
  });
});

describe("viewed ticks", () => {
  const base = "abc1234";
  const a: DiffFile = { path: "a.ts", status: "modified", added: 3, removed: 1 };
  const b: DiffFile = { path: "b.ts", status: "added", added: 9, removed: 0 };
  const logo: DiffFile = { path: "logo.png", status: "modified", added: null, removed: null };
  const none = new Map();
  const viewed = (
    ticks: Parameters<typeof viewedFiles>[0],
    files: ReadonlyArray<DiffFile>,
    at = base,
  ) => [...viewedFiles(ticks, files, at)];

  test("survive a refresh with the same values", () => {
    const ticks = tickViewed(none, a, base);
    expect(viewed(ticks, [{ ...a }, b])).toEqual(["a.ts"]);
  });

  test("are lost when the added or removed count, the status or the base changes", () => {
    const ticks = tickViewed(none, a, base);
    expect(viewed(ticks, [{ ...a, added: 4 }])).toEqual([]);
    expect(viewed(ticks, [{ ...a, removed: 2 }])).toEqual([]);
    expect(viewed(ticks, [{ ...a, status: "added" }])).toEqual([]);
    expect(viewed(ticks, [a], "def5678")).toEqual([]);
  });

  test("count N of M, ignoring ticks for files no longer in the diff", () => {
    const ticks = tickViewed(tickViewed(none, a, base), b, base);
    expect(viewedCount(ticks, [a, b, logo], base)).toBe("2 of 3 viewed");
    expect(viewedCount(ticks, [b, logo], base)).toBe("1 of 2 viewed");
  });

  test("tick a binary file like any other", () => {
    const ticks = tickViewed(none, logo, base);
    expect(viewed(ticks, [logo])).toEqual(["logo.png"]);
    expect(viewed(ticks, [{ ...logo, added: 2, removed: 0 }])).toEqual([]);
  });

  test("lost for good once seen changed, so changing back does not tick it again", () => {
    const ticks = tickViewed(tickViewed(none, a, base), b, base);
    const kept = ticksStillTrue(ticks, [{ ...a, added: 4 }, b], base);
    expect(viewed(kept, [a, b])).toEqual(["b.ts"]);
  });

  test("lost for good once its file left the diff, so coming back does not tick it again", () => {
    const ticks = tickViewed(tickViewed(none, a, base), b, base);
    const kept = ticksStillTrue(ticks, [b], base);
    expect(viewed(kept, [a, b])).toEqual(["b.ts"]);
  });

  test("untick a file", () => {
    const ticks = untickViewed(tickViewed(tickViewed(none, a, base), b, base), "a.ts");
    expect(viewed(ticks, [a, b])).toEqual(["b.ts"]);
    expect(viewedCount(ticks, [a, b], base)).toBe("1 of 2 viewed");
  });
});

describe("the tree pane's width", () => {
  test("is the chosen width while it is between the least width and 40% of the tab", () => {
    expect(paneWidth(300, 1000)).toBe(300);
  });

  test("never goes below the least width", () => {
    expect(paneWidth(100, 1000)).toBe(TREE.paneMin);
  });

  test("is capped at 40% of the tab", () => {
    expect(paneWidth(600, 1000)).toBe(400);
  });

  test("is the least width in a tab so narrow that 40% of it is less", () => {
    expect(paneWidth(320, 300)).toBe(TREE.paneMin);
  });

  test("gives back the chosen width when a narrowed tab widens again", () => {
    const chosen = 360;
    expect(paneWidth(chosen, 600)).toBe(240);
    expect(paneWidth(chosen, 1200)).toBe(chosen);
  });

  test("steps by 16px either way from the drawn width, clamped", () => {
    expect(TREE.paneStep).toBe(16);
    expect(paneStepped(300, 1000, 1)).toBe(316);
    expect(paneStepped(300, 1000, -1)).toBe(284);
    expect(paneStepped(TREE.paneMin, 1000, -1)).toBe(TREE.paneMin);
    expect(paneStepped(400, 1000, 1)).toBe(400);
  });

  test("steps from the drawn width when the tab caps the chosen one", () => {
    expect(paneStepped(600, 1000, -1)).toBe(384);
  });
});

describe("a row's room", () => {
  const facts = (added: number, removed: number, drafts = 0) => ({
    status: "modified" as const,
    lines: { added, removed },
    drafts,
  });

  test("shows a file's counts while its name keeps its least room", () => {
    const row = rowRoom({
      depth: 3,
      pane: TREE.paneStart,
      file: { facts: facts(136, 40), viewed: false },
    });
    expect(row.counts).toBe(true);
    expect(row.name).toBeGreaterThanOrEqual(TREE.nameMin);
  });

  test("drops the counts whole on a row too narrow for them, giving their room to the name", () => {
    const file = { facts: facts(136, 40), viewed: false };
    const narrow = rowRoom({ depth: 3, pane: TREE.paneMin, file });
    expect(narrow.counts).toBe(false);
    const wider = rowRoom({ depth: 3, pane: TREE.paneMin + 40, file });
    expect(wider.name - narrow.name).toBe(40);
  });

  test("keeps room for the mark, the viewed tick and the drafts whatever the width", () => {
    const plain = rowRoom({
      depth: 3,
      pane: TREE.paneMin,
      file: { facts: facts(1, 0), viewed: false },
    });
    const ticked = rowRoom({
      depth: 3,
      pane: TREE.paneMin,
      file: { facts: facts(1, 0), viewed: true },
    });
    const drafted = rowRoom({
      depth: 3,
      pane: TREE.paneMin,
      file: { facts: facts(1, 0, 12), viewed: true },
    });
    expect(plain.counts).toBe(false);
    expect(ticked.name).toBeLessThan(plain.name);
    expect(drafted.name).toBeLessThan(ticked.name);
  });

  test("counts binary as the counts it shows", () => {
    const binary = { status: "added" as const, lines: "binary" as const, drafts: 0 };
    expect(
      rowRoom({ depth: 0, pane: TREE.paneStart, file: { facts: binary, viewed: false } }).counts,
    ).toBe(true);
  });

  test("gives a folder row less room than its pane, indent and chrome leave, by its chevron", () => {
    for (const depth of [0, 2]) {
      const folder = rowRoom({ depth, pane: TREE.paneStart });
      expect(folder.counts).toBe(false);
      const unclaimed =
        TREE.paneStart -
        TREE.scrollbar -
        depth * TREE.indent -
        (2 * TREE.padding + TREE.icon + 2 * TREE.gap);
      expect(unclaimed - folder.name).toBeGreaterThanOrEqual(16);
    }
  });

  test("stops indenting past its deepest indented level", () => {
    const at = (depth: number) => rowRoom({ depth, pane: TREE.paneStart }).name;
    expect(at(TREE.depthMax + 8)).toBe(at(TREE.depthMax));
    expect(at(TREE.depthMax - 1) - at(TREE.depthMax)).toBe(TREE.indent);
  });

  test("loses one indent of room per level", () => {
    const at = (depth: number) => rowRoom({ depth, pane: TREE.paneStart }).name;
    expect(at(0) - at(1)).toBeLessThanOrEqual(12);
    expect(at(1) - at(4)).toBe(3 * (at(0) - at(1)));
  });
});

interface Drawn {
  readonly depth: number;
  readonly node: DiffTreeNode;
}
const rows = (nodes: ReadonlyArray<DiffTreeNode>, depth = 0): ReadonlyArray<Drawn> =>
  Arr.flatMap(nodes, (node) => [
    { depth, node },
    ...(node.kind === "folder" ? rows(node.children, depth + 1) : []),
  ]);
const room = ({ depth, node }: Drawn, pane: number, viewed: boolean, drafts: number) =>
  node.kind === "file"
    ? rowRoom({ depth, pane, file: { facts: { ...rowFacts(node.file, []), drafts }, viewed } })
    : rowRoom({ depth, pane });

describe("the tree's layout over a monorepo change", () => {
  const changed = (path: string, added: number, removed: number): DiffFile => ({
    path,
    status: "modified",
    added,
    removed,
  });
  const nimbus = "packages/core/modules/nimbus/runtime";
  const { tree } = diffTree([
    changed("packages/core/configs/clients/kycDocumentInquiry.ts", 90, 12),
    changed("packages/core/configs/clients/supportedDocumentTypes.ts", 1, 1),
    changed(`${nimbus}/composables/documents/inquiry/useKycDocumentInquiry.ts`, 99, 51),
    changed(`${nimbus}/i18n/locales/da-DK.json`, 3, 0),
    changed(`${nimbus}/i18n/locales/en-GB.json`, 3, 0),
    changed("packages/core/src/runtime/components/documents/DocumentUploadInquiry.vue", 7, 6),
    changed("packages/core/src/runtime/types/clients/kycDocumentInquiryClient.ts", 35, 10),
    changed("packages/core/test/nuxt/components/DocumentUploadInquiry.nuxt.spec.ts", 136, 40),
    changed("packages/core/test/nuxt/composables/useKycDocumentInquiry.nuxt.spec.ts", 24, 20),
  ]);

  test("is three folder rows deep once its chains are merged", () => {
    expect(Math.max(...Arr.map(rows(tree), ({ depth }) => depth))).toBe(3);
  });

  test("gives every row's name its least room, and every file its counts, at the starting width", () => {
    for (const row of rows(tree)) {
      const drawn = room(row, TREE.paneStart, false, 0);
      expect({ row: row.node.key, name: drawn.name >= TREE.nameMin }).toEqual({
        row: row.node.key,
        name: true,
      });
      if (row.node.kind === "file")
        expect({ row: row.node.key, counts: drawn.counts }).toEqual({
          row: row.node.key,
          counts: true,
        });
    }
  });

  test("fits every row's fixed parts in the pane at every width down to the least", () => {
    for (let pane = TREE.paneMin; pane <= TREE.paneStart; pane += 8) {
      for (const row of rows(tree)) {
        const drawn = room(row, pane, true, 3);
        expect({ pane, row: row.node.key, fits: drawn.name >= 0 }).toEqual({
          pane,
          row: row.node.key,
          fits: true,
        });
      }
    }
  });
});

describe("the tree's layout over a change branching at every level", () => {
  const levels = Array.from({ length: 12 }, (_, at) => `l${at}`);
  const { tree } = diffTree(
    Arr.map(levels, (_, at) => file(`${Arr.join(levels.slice(0, at + 1), "/")}/side.ts`)),
  );

  test("is twelve folder rows deep, as no chain merges", () => {
    expect(Math.max(...Arr.map(rows(tree), ({ depth }) => depth))).toBe(12);
  });

  test("fits every row's fixed parts at the least width, however deep", () => {
    for (const row of rows(tree)) {
      const drawn = room(row, TREE.paneMin, true, 99);
      expect({ row: row.node.key, fits: drawn.name > 0 }).toEqual({
        row: row.node.key,
        fits: true,
      });
    }
  });
});
