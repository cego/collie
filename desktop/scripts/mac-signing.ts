const has = (env: Record<string, string | undefined>, ...names: string[]) =>
  names.every((name) => (env[name] ?? "") !== ""); // oxlint-disable-line effecttsgo/prefer-effect-array

/**
 * The bundle signs with `ELECTROBUN_DEVELOPER_ID`, the release's existing secret name, `-`
 * meaning ad hoc. Only a real Developer ID with a complete set of notarization credentials
 * is notarized.
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

/** The bundle signs with the hardened runtime, which Bun's JIT and an ad hoc identity's
 * libraries need these to run under. */
export const MAC_ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-executable-page-protection": true,
  "com.apple.security.cs.allow-dyld-environment-variables": true,
  "com.apple.security.cs.disable-library-validation": true,
};
