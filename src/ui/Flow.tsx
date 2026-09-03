// One question at a time: the launch flow, the fork form and the resume list all draw
// through here. Two placements — a popup pane and an overlay in the tab — and one set of
// components, because the launch flow is where a human meets the most questions and it
// is the worst place to have a second input model.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { PickItem } from "../inputs";
import { filterItems, itemHay } from "./state";
import type { Pending } from "./prompts";

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";

export interface FlowProps {
  pending: Pending;
  /** Shown above the question: definition load errors, and what the flow last said. */
  banner?: string | null;
}

export function Flow(props: FlowProps) {
  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <Show when={props.banner}>
        <text fg={DIM}>{props.banner}</text>
      </Show>
      <text attributes={TextAttributes.BOLD}>{props.pending.ask.header}</text>
      <Show
        when={props.pending.ask._tag === "Menu"}
        fallback={<Question pending={props.pending} />}
      >
        <Menu pending={props.pending} />
      </Show>
      <text fg={DIM}>{props.pending.ask.footer}</text>
    </box>
  );
}

function Menu(props: { pending: Pending }) {
  const [query, setQuery] = createSignal("");
  const [at, setAt] = createSignal(0);

  const items = createMemo<readonly PickItem[]>(() => {
    const ask = props.pending.ask;
    const all = ask._tag === "Menu" ? ask.items : [];
    return filterItems(all, query(), itemHay);
  });

  // Filtering moves the list under the cursor, so the cursor is clamped back into it
  // rather than pointing past the end and choosing nothing on Enter.
  createEffect(() => {
    const last = Math.max(0, items().length - 1);
    if (at() > last) setAt(last);
  });

  const answer = () => {
    const chosen = items()[at()];
    if (chosen) props.pending.answer(chosen.id);
  };

  useKeyboard((key) => {
    if (key.name === "escape") return props.pending.answer(null);
    if (key.ctrl && key.name === "c") return props.pending.answer(null);
    if (key.name === "return") return answer();
    if (key.name === "up") return setAt((n) => Math.max(0, n - 1));
    if (key.name === "down") return setAt((n) => Math.min(items().length - 1, n + 1));
    if (key.name === "backspace") return setQuery((q) => q.slice(0, -1));
    // Ctrl-U, which is what clears a line everywhere else a line is typed.
    if (key.ctrl && key.name === "u") return setQuery("");
    if (/^[\x20-\x7e]$/.test(key.sequence)) return setQuery((q) => q + key.sequence);
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg={ACCENT}>{`> ${query()}▏`}</text>
      <Show when={items().length > 0} fallback={<text fg={DIM}>{"(nothing matches)"}</text>}>
        <For each={items()}>
          {(item, index) => (
            <box
              style={{ flexDirection: "row", height: 1 }}
              onMouseDown={() => {
                setAt(index());
                props.pending.answer(item.id);
              }}
              onMouseOver={() => setAt(index())}
            >
              <text style={{ width: 2 }} fg={ACCENT}>
                {index() === at() ? "❯" : " "}
              </text>
              <text
                style={{ width: "45%", height: 1 }}
                attributes={index() === at() ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {item.title}
              </text>
              <text style={{ flexGrow: 1, height: 1 }} fg={DIM}>
                {item.subtitle ?? ""}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

function Question(props: { pending: Pending }) {
  const ask = props.pending.ask;
  const [typed, setTyped] = createSignal(ask._tag === "Question" ? ask.initial : "");

  useKeyboard((key) => {
    if (key.name === "escape") return props.pending.answer(null);
    if (key.ctrl && key.name === "c") return props.pending.answer(null);
    if (key.name === "return") return props.pending.answer(typed());
    if (key.name === "backspace") return setTyped((value) => value.slice(0, -1));
    if (key.ctrl && key.name === "u") return setTyped("");
    if (/^[\x20-\x7e]$/.test(key.sequence)) return setTyped((value) => value + key.sequence);
  });

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <text fg={ACCENT}>{`> ${typed()}▏`}</text>
    </box>
  );
}
