import { For, Show } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { statusColour, type Row } from "./state";
import { C } from "./sections";

export interface PaneProps {
  title: string;
  rows: ReadonlyArray<Row>;
  empty: string;
  editing: { key: string; typed: string; multiline: boolean } | null;
  onPress: (row: Row) => void;
  onClose: () => void;
}

export function Pane(props: PaneProps) {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", height: 1, flexShrink: 0, paddingLeft: 1 }}>
        <text fg={C.blue} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <box style={{ flexGrow: 1 }} />
        <text fg={C.blue} onMouseDown={() => props.onClose()}>
          {"close  "}
        </text>
      </box>
      <scrollbox style={{ flexGrow: 1 }} contentOptions={{ flexDirection: "column" }}>
        <Show when={props.rows.length > 0} fallback={<text fg={C.dim}>{props.empty}</text>}>
          <For each={props.rows}>
            {(row) => (
              <box
                style={{
                  flexDirection: "row",
                  height:
                    props.editing?.key === row.setting?.key && props.editing?.multiline === true
                      ? undefined
                      : 1,
                }}
                onMouseDown={(event: MouseEvent) => {
                  event.stopPropagation();
                  props.onPress(row);
                }}
              >
                <text fg={statusColour(row.glyph)}>{` ${row.glyph} `}</text>
                <text fg={C.text} style={{ flexGrow: 1 }}>
                  {row.title}
                </text>
                <Show
                  when={props.editing !== null && props.editing.key === row.setting?.key}
                  fallback={<text fg={C.dim}>{row.detail}</text>}
                >
                  <text fg={C.dim}>{`${row.detail} → `}</text>
                  <text fg={C.text} bg={C.line}>
                    {`${props.editing?.typed ?? ""}▏`}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}
