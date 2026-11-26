import { usePaste } from "@opentui/solid";
import { pasteInto } from "./state";

export function usePasteInto(into: (append: (was: string) => string) => void) {
  usePaste((event) => into((was) => pasteInto(was, event.bytes)));
}
