// Terminal output as styled spans: SGR colours and weights kept, every other escape dropped.
// No Bun-only import: the view bundles this.

export interface AnsiSpan {
  readonly text: string;
  readonly style: Readonly<Record<string, string>>;
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** A 256-colour code as CSS: the first sixteen are the theme's, the rest fixed. */
const colour256 = (n: number) => {
  if (n < 16) return `var(--ansi-${n})`;
  if (n >= 232) {
    const grey = 8 + 10 * (n - 232);
    return `rgb(${grey}, ${grey}, ${grey})`;
  }
  const at = n - 16;
  return `rgb(${CUBE[Math.floor(at / 36)]}, ${CUBE[Math.floor(at / 6) % 6]}, ${CUBE[at % 6]})`;
};

const ESCAPE = /\x1b\[([\d;]*)([A-Za-z])/g;

/** What each plain SGR code sets, or which keys it clears. */
const SETS = new Map<number, readonly [string, string]>([
  [1, ["fontWeight", "bold"]],
  [2, ["opacity", "0.7"]],
  [3, ["fontStyle", "italic"]],
  [4, ["textDecoration", "underline"]],
]);
const CLEARS = new Map<number, ReadonlyArray<string>>([
  [22, ["fontWeight", "opacity"]],
  [23, ["fontStyle"]],
  [24, ["textDecoration"]],
  [39, ["color"]],
  [49, ["backgroundColor"]],
]);

export const ansiSpans = (text: string): ReadonlyArray<AnsiSpan> => {
  const spans: AnsiSpan[] = [];
  let style: AnsiSpan["style"] = {};
  const set = (key: string, value: string) => (style = { ...style, [key]: value });
  const clear = (keys: ReadonlyArray<string>) =>
    (style = Object.fromEntries(Object.entries(style).filter(([key]) => !keys.includes(key))));
  let from = 0;
  for (const match of text.matchAll(ESCAPE)) {
    if (match.index > from) spans.push({ text: text.slice(from, match.index), style });
    from = match.index + match[0].length;
    if (match[2] !== "m") continue;
    const codes = match[1] === "" ? [0] : match[1]!.split(";").map(Number);
    for (let at = 0; at < codes.length; at++) {
      const code = codes[at]!;
      const sets = SETS.get(code);
      const clears = CLEARS.get(code);
      if (code === 0) style = {};
      else if (sets !== undefined) set(...sets);
      else if (clears !== undefined) clear(clears);
      else if (code >= 30 && code <= 37) set("color", colour256(code - 30));
      else if (code >= 90 && code <= 97) set("color", colour256(code - 82));
      else if (code >= 40 && code <= 47) set("backgroundColor", colour256(code - 40));
      else if (code >= 100 && code <= 107) set("backgroundColor", colour256(code - 92));
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "color" : "backgroundColor";
        if (codes[at + 1] === 5) {
          set(key, colour256(codes[at + 2] ?? 0));
          at += 2;
        } else if (codes[at + 1] === 2) {
          const [r = 0, g = 0, b = 0] = codes.slice(at + 2, at + 5);
          set(key, `rgb(${r}, ${g}, ${b})`);
          at += 4;
        }
      }
    }
  }
  if (from < text.length) spans.push({ text: text.slice(from), style });
  return spans;
};

/** The spans of each line, with a colour still on carried to the lines after it. */
export const ansiLines = (text: string): ReadonlyArray<ReadonlyArray<AnsiSpan>> => {
  const lines: AnsiSpan[][] = [[]];
  for (const span of ansiSpans(text))
    span.text.split("\n").forEach((part, at) => {
      if (at > 0) lines.push([]);
      if (part !== "") lines.at(-1)!.push({ text: part, style: span.style });
    });
  return lines;
};
