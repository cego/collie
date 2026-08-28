// The popup picker: a list, type-to-filter, enter. Small enough to keep in the
// runner so the plugin needs no extra dependency (docs/SPEC.md).

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

function write(text: string): void {
  process.stdout.write(text);
}

/** One chunk of stdin can carry several keypresses; split them apart. */
export function tokenizeKeys(chunk: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      const m = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(chunk.slice(i));
      out.push(m ? m[0] : "\x1b");
      i += m ? m[0].length : 1;
      continue;
    }
    out.push(chunk[i]!);
    i += 1;
  }
  return out;
}

// One reader for the whole process: iterating process.stdin more than once
// destroys the stream, and the picker asks for several things in a row.
class Keyboard {
  private queue: string[] = [];
  private waiter: ((key: string) => void) | null = null;
  private started = false;

  /** Raw mode and one data handler; everything else reads from the queue. */
  start(): void {
    if (this.started) return;
    this.started = true;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (buf: Buffer) => {
      for (const key of tokenizeKeys(buf.toString("utf8"))) {
        const waiter = this.waiter;
        if (waiter) {
          this.waiter = null;
          waiter(key);
        } else {
          this.queue.push(key);
        }
      }
    });
  }

  async next(): Promise<string> {
    this.start();
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return await new Promise<string>((resolve) => {
      this.waiter = resolve;
    });
  }

  /** The next queued key, or null: for a loop that must also redraw on a timer. */
  take(): string | null {
    this.start();
    return this.queue.shift() ?? null;
  }

  release(): void {
    if (!this.started) return;
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
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
export async function pick(items: PickItem[], opts: PickOptions): Promise<PickItem | null> {
  requireTty();
  let query = "";
  let selected = 0;
  const draw = () => {
    const shown = filterItems(items, query);
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    write(
      CLEAR +
        (opts.banner ? `${opts.banner}\n\n` : "") +
        renderList(shown, selected, query, opts).replace(/\n/g, "\r\n") +
        "\r\n",
    );
  };
  draw();

  for (;;) {
    const key = await keyboard.next();
    const shown = filterItems(items, query);
    if (CANCEL.has(key)) return clear(null);
    if (ENTER.has(key)) {
      const chosen = shown[selected];
      if (chosen) return clear(chosen);
      continue;
    }
    if (key === "\x1b[A" || key === "\x10") selected = Math.max(0, selected - 1);
    else if (key === "\x1b[B" || key === "\x0e") selected = Math.min(shown.length - 1, selected + 1);
    else if (BACKSPACE.has(key)) query = query.slice(0, -1);
    else if (key === "\x15") query = "";
    else if (/^[\x20-\x7e]$/.test(key)) query += key;
    draw();
  }
}

function clear<T>(value: T): T {
  write(CLEAR);
  return value;
}

function requireTty(): void {
  if (!process.stdin.isTTY) throw new Error("the picker needs a terminal");
}

/** One line of input. Returns null when the human cancels. */
export async function ask(question: string, initial = ""): Promise<string | null> {
  requireTty();
  let value = initial;
  const draw = () => write(`\r\x1b[2K${question}: ${value}`);
  write(CLEAR);
  draw();
  for (;;) {
    const key = await keyboard.next();
    if (CANCEL.has(key)) return clear(null);
    if (ENTER.has(key)) {
      write("\r\n");
      return value;
    }
    if (BACKSPACE.has(key)) value = value.slice(0, -1);
    else if (key === "\x15") value = "";
    else if (/^[\x20-\x7e]$/.test(key)) value += key;
    draw();
  }
}

export async function confirm(text: string): Promise<boolean> {
  requireTty();
  write(`${CLEAR}${text.replace(/\n/g, "\r\n")}\r\n\r\nEnter to start, Esc to cancel.\r\n`);
  for (;;) {
    const key = await keyboard.next();
    if (ENTER.has(key)) return clear(true);
    if (CANCEL.has(key) || key === "q") return clear(false);
  }
}
