// A card's record opened from a chat message, in the board's window even from a chat popped
// out into its own.

import { Option, Schema } from "effect";
import { About } from "../../../src/shared/chat-view";

const decodeAbout = Schema.decodeUnknownOption(About);

/** The board's window, which opens a card's record; none in a chat popped out alone. */
let opensRecord: ((about: About) => void) | undefined;
const records = new BroadcastChannel("collie-record");
records.onmessage = (event) => {
  const asked = decodeAbout(event.data);
  if (Option.isSome(asked)) opensRecord?.(asked.value);
};

/** Opens a card's record in the board's window, wherever it is asked from. */
export const useRecordOpener = () => ({
  openRecord: (about: About) =>
    opensRecord === undefined ? records.postMessage(about) : opensRecord(about),
  opensRecords: (open: (about: About) => void) => {
    opensRecord = open;
    onScopeDispose(() => (opensRecord = undefined));
  },
});
