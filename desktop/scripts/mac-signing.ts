const has = (env: Record<string, string | undefined>, ...names: string[]) =>
  names.every((name) => (env[name] ?? "") !== "");

/**
 * Electrobun signs with `ELECTROBUN_DEVELOPER_ID`, `-` meaning ad hoc, after it writes the
 * release metadata and before it archives the app. Only a real Developer ID with a complete
 * set of notarization credentials is notarized.
 */
export const macSigning = (env: Record<string, string | undefined>) => {
  const codesign = has(env, "ELECTROBUN_DEVELOPER_ID");
  const notarize =
    codesign &&
    env.ELECTROBUN_DEVELOPER_ID !== "-" &&
    (has(env, "ELECTROBUN_APPLEID", "ELECTROBUN_APPLEIDPASS", "ELECTROBUN_TEAMID") ||
      has(
        env,
        "ELECTROBUN_APPLEAPIKEY",
        "ELECTROBUN_APPLEAPIISSUER",
        "ELECTROBUN_APPLEAPIKEYPATH",
      ));
  return { codesign, notarize };
};
