// Only the board's window opens a record; a popped-out chat asks it over this channel.

import { Option, Schema } from "effect";
import { About } from "../../../src/shared/chat-view";

const Asked = Schema.Union([Schema.Struct({ open: About }), Schema.Struct({ gone: About })]);
const decodeAsked = Schema.decodeUnknownOption(Asked);

let opensRecord: ((about: About) => boolean) | undefined;
let toldGone: ((about: About) => void) | undefined;
const records = new BroadcastChannel("collie-record");
records.onmessage = (event) => {
  const asked = Option.getOrNull(decodeAsked(event.data));
  if (asked === null) return;
  if ("gone" in asked) toldGone?.(asked.gone);
  else if (opensRecord !== undefined && !opensRecord(asked.open))
    records.postMessage({ gone: asked.open });
};

export const useRecordOpener = () => ({
  openRecord: (about: About, gone: (about: About) => void) => {
    toldGone = gone;
    if (opensRecord === undefined) records.postMessage({ open: about });
    else if (!opensRecord(about)) gone(about);
  },
  opensRecords: (open: (about: About) => boolean) => {
    opensRecord = open;
    onScopeDispose(() => (opensRecord = undefined));
  },
});
