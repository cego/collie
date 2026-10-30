import * as Arr from "effect/Array";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { computed, ref } from "vue";
import { diffAnchor, type DiffAnchor, type Draft } from "../../../src/shared/review-comments";

export const WRITING = "writing";

export const useDiffComments = (
  path: () => string,
  file: () => FileDiffMetadata | null,
  drafts: () => ReadonlyArray<Draft>,
  add: (anchor: DiffAnchor, text: string) => void,
  clearSelection: () => void,
) => {
  const pending = ref<DiffAnchor | null>(null);
  const start = (range: SelectedLineRange | null) => {
    const parsed = file();
    if (range !== null && parsed !== null) pending.value = diffAnchor(path(), range, parsed);
  };
  const annotations = computed<DiffLineAnnotation<string>[]>(() => [
    ...Arr.flatMap(drafts(), (draft) =>
      draft.anchor._tag === "Diff" && draft.anchor.path === path()
        ? [{ side: draft.anchor.side, lineNumber: draft.anchor.last, metadata: draft.id }]
        : [],
    ),
    ...(pending.value === null
      ? []
      : [{ side: pending.value.side, lineNumber: pending.value.last, metadata: WRITING }]),
  ]);
  const settle = (text: string | null) => {
    if (pending.value !== null && text !== null) add(pending.value, text);
    pending.value = null;
    clearSelection();
  };
  return {
    pending,
    annotations,
    handlers: { onGutterUtilityClick: start, onLineSelectionEnd: start },
    settle,
  };
};
