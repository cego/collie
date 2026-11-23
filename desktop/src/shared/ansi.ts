// WARNING: no Bun-only import: the view bundles this.
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
export interface AnsiSpan {
  readonly text: string;
  readonly style: Readonly<Record<string, string>>;
}

const CUBE = [0, 95, 135, 175, 215, 255];

const colour256 = (n: number) => {
  if (n < 16) {
    return `var(--ansi-${n})`;
  }
  if (n >= 232) {
    const grey = 8 + 10 * (n - 232);
    return `rgb(${grey}, ${grey}, ${grey})`;
  }
  const at = n - 16;
  return `rgb(${CUBE[Math.floor(at / 36)]}, ${CUBE[Math.floor(at / 6) % 6]}, ${CUBE[at % 6]})`;
};

// oxlint-disable-next-line no-control-regex -- Terminal CSI sequences begin with the ESC control byte.
const ESCAPE = /\u001b\[([\d;?]*)([A-Za-z])/g;
// oxlint-disable-next-line no-control-regex -- Terminal OSC sequences use ESC and BEL as protocol delimiters.
const OTHER = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][\w]/g;

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

export const ansiSpans = (output: string) => {
  const text = pipe(output, Str.replaceAll(OTHER, ""));
  const spans: Array<AnsiSpan> = [];
  let style: AnsiSpan["style"] = {};
  const set = (key: string, value: string) => (style = { ...style, [key]: value });
  const clear = (keys: ReadonlyArray<string>) =>
    (style = Rec.fromEntries(Arr.filter(Rec.toEntries(style), ([key]) => !keys.includes(key))));
  let from = 0;
  for (const match of pipe(text, Str.matchAll(ESCAPE))) {
    const index = match.index ?? 0;
    if (index > from) {
      spans.push({ text: pipe(text, Str.slice(from, index)), style });
    }
    from = index + match[0].length;
    if (match[2] !== "m") {
      continue;
    }
    const codes = match[1] === "" ? [0] : Arr.map(Str.split(match[1]!, ";"), Number);
    for (let at = 0; at < codes.length; at++) {
      const code = codes[at]!;
      const sets = SETS.get(code);
      const clears = CLEARS.get(code);
      if (code === 0) {
        style = {};
      } else if (sets !== undefined) {
        set(...sets);
      } else if (clears !== undefined) {
        clear(clears);
      } else if (code >= 30 && code <= 37) {
        set("color", colour256(code - 30));
      } else if (code >= 90 && code <= 97) {
        set("color", colour256(code - 82));
      } else if (code >= 40 && code <= 47) {
        set("backgroundColor", colour256(code - 40));
      } else if (code >= 100 && code <= 107) {
        set("backgroundColor", colour256(code - 92));
      } else if (code === 38 || code === 48) {
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
  if (from < text.length) {
    spans.push({ text: pipe(text, Str.slice(from)), style });
  }
  return spans;
};

export const ansiLines = (text: string) => {
  const lines: Array<Array<AnsiSpan>> = [[]];
  for (const span of ansiSpans(text)) {
    Arr.forEach(Str.split(span.text, "\n"), (part, at) => {
      if (at > 0) {
        lines.push([]);
      }
      if (part !== "") {
        lines.at(-1)!.push({ text: part, style: span.style });
      }
    });
  }
  return lines;
};
