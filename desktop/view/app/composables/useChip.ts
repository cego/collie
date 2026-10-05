// The card the next chat message goes with. Every window of Desktop shares it, so a card
// clicked on the board reaches a chat popped out into its own window.

import { Option, Schema } from "effect";
import { About } from "../../../src/shared/chat-view";

const decodeChip = Schema.decodeUnknownOption(Schema.NullOr(About));
const chip = ref<About | null>(null);
const windows = new BroadcastChannel("collie-chip");
windows.onmessage = (event) => {
  const told = decodeChip(event.data);
  if (Option.isSome(told)) chip.value = told.value;
};

export const useChip = () => ({
  chip: readonly(chip),
  choose: (about: About | null) => {
    chip.value = about;
    windows.postMessage(about);
  },
});
