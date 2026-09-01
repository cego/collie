// The popup picker: a list, type-to-filter, enter. Small enough to keep in the
// runner so the plugin needs no extra dependency (docs/SPEC.md).

import { Data, Effect } from "effect";

export interface PickItem {
  id: string;
  title: string;
  subtitle?: string;
}

function haystack(item: PickItem): string {
  return `${item.id} ${item.title} ${item.subtitle ?? ""}`.toLowerCase();
}

function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const c of hay) {
    if (c === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Name prefix first, then substring anywhere, then in-order characters. */
export function filterItems(items: PickItem[], query: string): PickItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  const prefix: PickItem[] = [];
  const exact: PickItem[] = [];
  const fuzzy: PickItem[] = [];
  for (const item of items) {
    const hay = haystack(item);
    if (item.id.toLowerCase().startsWith(q)) prefix.push(item);
    else if (hay.includes(q)) exact.push(item);
    else if (subsequence(q, hay)) fuzzy.push(item);
  }
  return [...prefix, ...exact, ...fuzzy];
}

export interface RenderOptions {
  header: string;
  footer?: string;
  rows?: number;
}

export function renderList(
  items: PickItem[],
  selected: number,
  query: string,
  opts: RenderOptions,
): string {
  const rows = opts.rows ?? 12;
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), items.length - rows));
  const window = items.slice(Math.max(0, start), Math.max(0, start) + rows);
  const lines = [opts.header, `> ${query}`, ""];
  if (items.length === 0) lines.push("  (nothing matches)");
  for (const [i, item] of window.entries()) {
    const at = Math.max(0, start) + i;
    const marker = at === selected ? "❯" : " ";
    const subtitle = item.subtitle ? `  ${item.subtitle}` : "";
    lines.push(`${marker} ${item.title.padEnd(28)}${subtitle}`);
  }
  if (opts.footer) lines.push("", opts.footer);
  return lines.join("\n");
}

const CLEAR = "\x1b[2J\x1b[H";

export class PickerError extends Data.TaggedError("PickerError")<{
  readonly message: string;
  readonly detail: string;
}> {}

type PickerEffect<A> = Effect.Effect<A, PickerError>;

const pickerError = (message: string, detail: string) => new PickerError({ message, detail });

function write(text: string): PickerEffect<void> {
  return Effect.promise(() => Bun.write(Bun.stdout, text)).pipe(Effect.asVoid);
}

/** One chunk of stdin can carry several keypresses; split them apart. */
export function tokenizeKeys(chunk: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      let end = i + 1;
      if (chunk[end] === "[") {
        end += 1;
        while (end < chunk.length) {
          const code = chunk.charCodeAt(end);
          end += 1;
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 126) break;
        }
      } else if (chunk[end] === "O" && end + 1 < chunk.length) {
        end += 2;
      }
      out.push(chunk.slice(i, end));
      i = end;
      continue;
    }
    out.push(chunk[i]!);
    i += 1;
  }
  return out;
}

// Raw terminal input, which Stdio does not model: it offers stdin as a byte stream and
// can say whether it is a terminal, but not raw mode, and a picker needs keypresses
// unbuffered and unechoed. The stream would also compete with this reader for the same
// fd. Output goes through Bun.write for the same reason — it is interleaved with the
// escape sequences this file writes to move the cursor.
//
// One reader for the whole process: iterating process.stdin more than once
// destroys the stream, and the picker asks for several things in a row.
interface KeyboardInput {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (buffer: Buffer) => void): void;
  off(event: "data", listener: (buffer: Buffer) => void): void;
}

export class Keyboard {
  private queue: string[] = [];
  private waiter: ((key: string) => void) | null = null;
  private started = false;

  constructor(private readonly input: KeyboardInput = process.stdin) {}

  private readonly onData = (buffer: Buffer): void => {
    for (const key of tokenizeKeys(buffer.toString("utf8"))) {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(key);
      } else {
        this.queue.push(key);
      }
    }
  };

  /** Raw mode and one data handler; everything else reads from the queue. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("data", this.onData);
  }

  next(): PickerEffect<string> {
    return Effect.suspend(() => {
      this.start();
      const queued = this.queue.shift();
      if (queued !== undefined) return Effect.succeed(queued);
      return Effect.callback<string>((resume) => {
        this.waiter = (key) => resume(Effect.succeed(key));
      });
    });
  }

  /** The next queued key, or null: for a loop that must also redraw on a timer. */
  take(): string | null {
    this.start();
    return this.queue.shift() ?? null;
  }

  release(): void {
    if (!this.started) return;
    this.started = false;
    this.input.off("data", this.onData);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.queue = [];
    this.waiter = null;
  }

  run<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return effect.pipe(Effect.ensuring(Effect.sync(() => this.release())));
  }
}

const keyboard = new Keyboard();

export const nextKey = () => keyboard.next();
export const startKeyboard = () => keyboard.start();
export const takeKey = () => keyboard.take();
export const releaseKeyboard = () => keyboard.release();

const CANCEL = new Set(["\x03", "\x1b"]);
const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\x7f", "\b"]);

export interface PickOptions extends RenderOptions {
  /** Rendered once above the list; used for definition load errors. */
  banner?: string;
}

/** Returns null when the human cancels. */
export function pick(items: PickItem[], opts: PickOptions): PickerEffect<PickItem | null> {
  return keyboard.run(
    Effect.gen(function* () {
      yield* requireTty();
      let query = "";
      let selected = 0;
      const draw = () => {
        const shown = filterItems(items, query);
        selected = Math.min(selected, Math.max(0, shown.length - 1));
        return write(
          CLEAR +
            (opts.banner ? `${opts.banner}\n\n` : "") +
            renderList(shown, selected, query, opts).replace(/\n/g, "\r\n") +
            "\r\n",
        );
      };
      yield* draw();

      for (;;) {
        const key = yield* keyboard.next();
        const shown = filterItems(items, query);
        if (CANCEL.has(key)) return yield* clear(null);
        if (ENTER.has(key)) {
          const chosen = shown[selected];
          if (chosen) return yield* clear(chosen);
          continue;
        }
        if (key === "\x1b[A" || key === "\x10") selected = Math.max(0, selected - 1);
        else if (key === "\x1b[B" || key === "\x0e")
          selected = Math.min(shown.length - 1, selected + 1);
        else if (BACKSPACE.has(key)) query = query.slice(0, -1);
        else if (key === "\x15") query = "";
        else if (/^[\x20-\x7e]$/.test(key)) query += key;
        yield* draw();
      }
    }),
  );
}

function clear<T>(value: T): PickerEffect<T> {
  return write(CLEAR).pipe(Effect.as(value));
}

function requireTty(): PickerEffect<void> {
  return process.stdin.isTTY
    ? Effect.void
    : Effect.fail(pickerError("the picker needs a terminal", "stdin is not a TTY"));
}

/** One line of input. Returns null when the human cancels. */
export function ask(question: string, initial = ""): PickerEffect<string | null> {
  return keyboard.run(
    Effect.gen(function* () {
      yield* requireTty();
      let value = initial;
      const draw = () => write(`\r\x1b[2K${question}: ${value}`);
      yield* write(CLEAR);
      yield* draw();
      for (;;) {
        const key = yield* keyboard.next();
        if (CANCEL.has(key)) return yield* clear(null);
        if (ENTER.has(key)) {
          yield* write("\r\n");
          return value;
        }
        if (BACKSPACE.has(key)) value = value.slice(0, -1);
        else if (key === "\x15") value = "";
        else if (/^[\x20-\x7e]$/.test(key)) value += key;
        yield* draw();
      }
    }),
  );
}

export function confirm(text: string): PickerEffect<boolean> {
  return keyboard.run(
    Effect.gen(function* () {
      yield* requireTty();
      yield* write(
        `${CLEAR}${text.replace(/\n/g, "\r\n")}\r\n\r\nEnter to start, Esc to cancel.\r\n`,
      );
      for (;;) {
        const key = yield* keyboard.next();
        if (ENTER.has(key)) return yield* clear(true);
        if (CANCEL.has(key) || key === "q") return yield* clear(false);
      }
    }),
  );
}
