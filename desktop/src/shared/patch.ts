// A file's unified patch, as the drawer draws it. No Bun-only import: the view bundles this.

export interface PatchLine {
  readonly kind: "context" | "add" | "del";
  /** Its number in the file as it was, or null for an added line. */
  readonly old: number | null;
  /** Its number in the file as it is, or null for a removed line. */
  readonly new: number | null;
  readonly text: string;
}

export interface Hunk {
  readonly header: string;
  readonly lines: ReadonlyArray<PatchLine>;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const KINDS = new Map<string | undefined, PatchLine["kind"]>([
  [" ", "context"],
  ["+", "add"],
  ["-", "del"],
]);

/** Every hunk of a patch; file headers, binary notes and "No newline" markers are skipped. */
export const parsePatch = (patch: string): ReadonlyArray<Hunk> => {
  const hunks: Array<{ header: string; lines: PatchLine[] }> = [];
  let old = 0;
  let now = 0;
  for (const line of patch.split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      old = Number(header[1]);
      now = Number(header[2]);
      hunks.push({ header: line, lines: [] });
      continue;
    }
    const kind = KINDS.get(line[0]);
    const hunk = hunks.at(-1);
    if (hunk === undefined || kind === undefined) continue;
    hunk.lines.push({
      kind,
      old: kind === "add" ? null : old++,
      new: kind === "del" ? null : now++,
      text: line.slice(1),
    });
  }
  return hunks;
};

export interface Row {
  readonly left: PatchLine | null;
  readonly right: PatchLine | null;
}

/** A hunk's rows side by side: each run of removals beside the additions that follow it. */
export const sideBySide = (hunk: Hunk): ReadonlyArray<Row> => {
  const rows: Row[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at++)
      rows.push({ left: dels[at] ?? null, right: adds[at] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "context") {
      flush();
      rows.push({ left: line, right: line });
    } else if (line.kind === "del") {
      if (adds.length > 0) flush();
      dels.push(line);
    } else adds.push(line);
  }
  flush();
  return rows;
};

/** The lines of the file as it was and as it is, in order, to highlight each as one text. */
export const sides = (hunks: ReadonlyArray<Hunk>) => {
  const lines = hunks.flatMap((hunk) => hunk.lines);
  return {
    old: lines.filter((line) => line.kind !== "add"),
    new: lines.filter((line) => line.kind !== "del"),
  };
};
