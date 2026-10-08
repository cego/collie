// Desktop's macOS build is signed with a Developer ID and notarized only when the release has
// every credential for both; otherwise Electrobun signs it ad hoc.

import { expect, test } from "bun:test";
import { macSigning } from "../desktop/scripts/mac-signing";

const ID = { ELECTROBUN_DEVELOPER_ID: "Developer ID Application: CEGO (AB12C3D4E5)" };
const APPLE_ID = {
  ELECTROBUN_APPLEID: "release@cego.dk",
  ELECTROBUN_APPLEIDPASS: "xxxx-xxxx-xxxx-xxxx",
  ELECTROBUN_TEAMID: "AB12C3D4E5",
};
const API_KEY = {
  ELECTROBUN_APPLEAPIKEY: "ABC123DEFG",
  ELECTROBUN_APPLEAPIISSUER: "01234567-89ab-cdef-0123-456789abcdef",
  ELECTROBUN_APPLEAPIKEYPATH: "/tmp/AuthKey.p8",
};

test.each<[string, Record<string, string>, boolean]>([
  ["no credentials", {}, false],
  ["a Developer ID and an Apple ID", { ...ID, ...APPLE_ID }, true],
  ["a Developer ID and an API key", { ...ID, ...API_KEY }, true],
  ["a Developer ID alone", ID, false],
  ["notarization without a Developer ID", APPLE_ID, false],
  ["an Apple ID with no team", { ...ID, ...APPLE_ID, ELECTROBUN_TEAMID: "" }, false],
  ["an API key with no issuer", { ...ID, ELECTROBUN_APPLEAPIKEY: "ABC123DEFG" }, false],
])("%s signs and notarizes: %p", (_, env, on) => {
  expect(macSigning(env)).toEqual({ codesign: on, notarize: on });
});
