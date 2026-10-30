/** `entry` with its Name and Comment saying Collie rather than the build's `name`. */
import * as Str from "effect/String";
import { pipe } from "effect/Function";
export const withCollieName = (entry: string, name: string) =>
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
  entry.replace(/^(Name|Comment)=.*$/gm, (line) => pipe(line, Str.replace(name, "Collie")));

/** A macOS bundle's `plist` with the name its menu bar and Dock show saying Collie. */
export const withCollieBundleName = (plist: string, name: string) =>
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
  plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)([^<]*)/,
    (_, key: string, value: string) => key + pipe(value, Str.replace(name, "Collie")),
  );
