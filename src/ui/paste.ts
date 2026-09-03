// The one place a paste becomes field text. opentui delivers a paste as bytes on the
// renderer's own event rather than as keys, and every keyboard handler here takes a
// single printable character at a time, so a field that does not subscribe silently
// drops what was pasted into it.

import { usePaste } from "@opentui/solid";
import { pasteInto } from "./state";

/**
 * A paste, handed to the field the calling component owns. Each keyboard owner subscribes
 * where it already subscribes for keys: the tab's board, which routes by whichever field
 * has the keyboard, and the flow's two fields, which are also drawn by a popup pane of
 * their own where there is no board above them to route anything.
 *
 * `append` is what the pasted text does to whatever the field already holds, so a caller
 * hands over its setter and never sees a byte.
 */
export function usePasteInto(into: (append: (was: string) => string) => void): void {
  usePaste((event) => into((was) => pasteInto(was, event.bytes)));
}
