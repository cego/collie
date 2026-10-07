<script setup lang="ts">
// The Run's live agent's pane, drawn from herdr's own frames: what the human types, pastes,
// scrolls and clicks goes back to herdr, and nothing the pane shows decides anything here.
// The pane is held while this tab is mounted and given back when it is not.

import { FitAddon } from "@xterm/addon-fit";
import { type IDisposable, type ILink, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Cause, Effect, Encoding, Fiber, Result, Stream } from "effect";
import type { PlacedTask, TerminalCommand, TerminalEvent } from "../../../src/shared/flock";
import {
  cellAt,
  isMouseReport,
  keyAction,
  linksIn,
  mouseOf,
  type Screen,
  scrollOf,
} from "../../../src/shared/terminal-input";

const props = defineProps<{ placed: PlacedTask; wentToPane: boolean }>();
const { terminal, terminalSend, openLink } = useActions();
const panes = usePanes();
const toast = useToast();

const host = ref<HTMLElement>();
/** Why the terminal ended, while it has. */
const ended = ref<string | null>(null);
/** Go to pane found no live agent's pane, so herdr's own client was opened instead. */
const noPane = ref(false);

let term: Terminal | undefined;
let fiber: Fiber.Fiber<void> | undefined;
const send = (command: TerminalCommand) => void terminalSend(command);

const copy = (text: string) =>
  navigator.clipboard
    .writeText(text)
    .catch(() => toast.add({ title: "Could not copy the selection", color: "error" }));

/** The drawn screen, for the cell under the pointer. */
const screen = (): Screen => {
  const drawn = host.value?.querySelector(".xterm-screen")?.getBoundingClientRect();
  return {
    left: drawn?.left ?? 0,
    top: drawn?.top ?? 0,
    width: drawn?.width || 1,
    height: drawn?.height || 1,
    cols: term?.cols ?? 1,
    rows: term?.rows ?? 1,
  };
};

const sendIf = (command: TerminalCommand | null) => command !== null && send(command);

/** A line's links, opened only in the human's browser. */
const linksOn = (line: number): ILink[] =>
  linksIn(term?.buffer.active.getLine(line - 1)?.translateToString(true) ?? "").map((link) => ({
    text: link.url,
    range: { start: { x: link.start, y: line }, end: { x: link.end, y: line } },
    activate: () => void openLink(link.url),
  }));

const shown = (event: TerminalEvent) => {
  switch (event._tag) {
    case "Opened":
      // A resize sent while the controller was starting was refused.
      if (term !== undefined) send({ type: "terminal.resize", cols: term.cols, rows: term.rows });
      return panes.showing(props.placed, event.at);
    case "Frame":
      return term?.write(
        Result.getOrElse(Encoding.decodeBase64(event.bytes), () => new Uint8Array()),
      );
    case "Ended":
      ended.value = event.reason;
      return;
    case "NoPane":
      noPane.value = true;
      return props.wentToPane ? panes.openInHerdr(props.placed) : undefined;
  }
};

const attach = () => {
  if (term === undefined) return;
  ended.value = null;
  term.reset();
  fiber = Effect.runFork(
    terminal(props.placed.installation, props.placed.task.run, term.cols, term.rows).pipe(
      Stream.runForEach((event) => Effect.sync(() => shown(event))),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return;
          const failed = Cause.findError(cause);
          ended.value =
            Result.isSuccess(failed) && failed.success._tag === "ActionFailed"
              ? failed.success.reason
              : Cause.pretty(cause);
        }),
      ),
    ),
  );
};

/** Ends the terminal, settled once its pane has been given back. */
const detach = () => {
  const held = fiber;
  fiber = undefined;
  return held === undefined ? Promise.resolve() : Effect.runPromise(Fiber.interrupt(held));
};

const reattach = () => detach().then(attach);

let listening: ReadonlyArray<IDisposable> = [];
let resized: ResizeObserver | undefined;
/** The mouse button down, while one is, and the cell it was last dragged to. */
let held: number | null = null;
let dragAt: { column: number; row: number } | null = null;
const released = (event: MouseEvent) => {
  if (held === null) return;
  held = null;
  dragAt = null;
  sendIf(mouseOf("up", event.button, event, screen()));
};

onMounted(() => {
  const element = host.value!;
  term = new Terminal({
    scrollback: 0,
    cursorBlink: true,
    fontFamily: "ui-monospace, monospace",
    linkHandler: { activate: (_event, url) => void openLink(url) },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);
  fit.fit();
  listening = [
    term.onData((text) => isMouseReport(text) || send({ type: "terminal.input", text })),
    term.onResize(({ cols, rows }) => send({ type: "terminal.resize", cols, rows })),
    term.registerLinkProvider({ provideLinks: (line, links) => links(linksOn(line)) }),
  ];
  term.attachCustomWheelEventHandler((event) => {
    sendIf(scrollOf(event.deltaY, event, screen()));
    event.preventDefault();
    return false;
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    const action = keyAction(event, term!.hasSelection());
    if (action === "copy" && term!.hasSelection()) void copy(term!.getSelection());
    return action === "pane";
  });
  element.addEventListener("mousedown", (event) => {
    held = event.button;
    sendIf(mouseOf("down", event.button, event, screen()));
  });
  element.addEventListener("mousemove", (event) => {
    if (held === null) return;
    const { column, row } = cellAt(event, screen());
    if (column === dragAt?.column && row === dragAt.row) return;
    dragAt = { column, row };
    sendIf(mouseOf("drag", held, event, screen()));
  });
  // Anywhere, so a button let go outside the terminal is not still held in it.
  window.addEventListener("mouseup", released);
  resized = new ResizeObserver(() => fit.fit());
  resized.observe(element);
  term.focus();
  attach();
});

onBeforeUnmount(() => {
  void detach();
  window.removeEventListener("mouseup", released);
  resized?.disconnect();
  for (const one of listening) one.dispose();
  term?.dispose();
});
</script>

<template>
  <div class="flex flex-col gap-2" data-testid="terminal-tab">
    <div class="flex items-center justify-between gap-2 text-sm">
      <span class="text-muted" data-testid="terminal-where">{{
        panes.shownFor(placed.key)?.where ?? ""
      }}</span>
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-square-terminal"
        label="Open in herdr"
        data-testid="open-in-herdr"
        @click="panes.openInHerdr(placed)"
      />
    </div>
    <p v-if="noPane" class="text-muted text-sm" data-testid="terminal-no-pane">
      This Run has no live agent's pane to show here; Open in herdr shows its workspace.
    </p>
    <!-- Esc and Ctrl+C are the pane's while it has focus, not the drawer's. -->
    <div
      v-show="!noPane"
      ref="host"
      class="h-[70vh] min-h-64 overflow-hidden rounded bg-black p-1"
      :class="{ 'opacity-50': ended !== null }"
      data-testid="terminal"
      @keydown.stop
    />
    <div v-if="ended !== null" class="flex items-center gap-2 text-sm" data-testid="terminal-ended">
      <span data-testid="terminal-reason">Ended: {{ ended }}</span>
      <UButton size="xs" label="Reattach" data-testid="reattach" @click="reattach" />
    </div>
  </div>
</template>
