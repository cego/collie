import * as Str from "effect/String";
import { pipe } from "effect/Function";

export const DELIVERY_TOKEN = "collie-delivery:";

const SPACED = new RegExp(String.raw`\s`);

const tokenOn = (line: string) =>
  pipe(line, Str.startsWith(DELIVERY_TOKEN)) ? pipe(line, Str.slice(DELIVERY_TOKEN.length)) : null;

// WARNING: the token is read only where the Dispatcher writes it, so a prompt quoting a lost Delivery proves nothing about it.
export function carriedDelivery(prompt: string) {
  const lines = Str.split(prompt, "\n");
  const at = pipe(lines[0] ?? "", Str.startsWith("/")) ? 1 : 0;
  const token = tokenOn(lines[at] ?? "");
  const returned: string | null =
    token === null || token === "" || SPACED.test(token) ? null : token;
  return returned;
}
