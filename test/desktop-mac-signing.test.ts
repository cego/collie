// Electrobun signs Desktop's macOS build after its release metadata is written, with the
// identity the release gives it: a Developer ID, or `-` for ad hoc. Only a Developer ID with
// a complete set of notarization credentials is notarized.

import { expect, test } from "bun:test";
import { macSigning } from "../desktop/scripts/mac-signing";

const ID = { ELECTROBUN_DEVELOPER_ID: "Developer ID Application: CEGO (AB12C3D4E5)" };
const AD_HOC = { ELECTROBUN_DEVELOPER_ID: "-" };
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

test.each<[string, Record<string, string>, { codesign: boolean; notarize: boolean }]>([
  ["no credentials", {}, { codesign: false, notarize: false }],
  ["ad hoc", AD_HOC, { codesign: true, notarize: false }],
  [
    "ad hoc with notarization credentials",
    { ...AD_HOC, ...APPLE_ID },
    { codesign: true, notarize: false },
  ],
  ["a Developer ID and an Apple ID", { ...ID, ...APPLE_ID }, { codesign: true, notarize: true }],
  ["a Developer ID and an API key", { ...ID, ...API_KEY }, { codesign: true, notarize: true }],
  ["a Developer ID alone", ID, { codesign: true, notarize: false }],
  ["notarization without an identity", APPLE_ID, { codesign: false, notarize: false }],
  [
    "an Apple ID with no team",
    { ...ID, ...APPLE_ID, ELECTROBUN_TEAMID: "" },
    { codesign: true, notarize: false },
  ],
  [
    "an API key with no issuer",
    { ...ID, ELECTROBUN_APPLEAPIKEY: "ABC123DEFG" },
    { codesign: true, notarize: false },
  ],
])("%s", (_, env, signing) => {
  expect(macSigning(env)).toEqual(signing);
});
