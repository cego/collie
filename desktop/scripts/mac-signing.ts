const has = (env: Record<string, string | undefined>, ...names: string[]) =>
  names.every((name) => (env[name] ?? "") !== ""); // oxlint-disable-line effecttsgo/prefer-effect-array

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

// WARNING: Bun's JIT and an ad hoc identity's libraries need these to run under the hardened runtime.
export const MAC_ENTITLEMENTS = {
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
  "com.apple.security.cs.disable-executable-page-protection": true,
  "com.apple.security.cs.allow-dyld-environment-variables": true,
  "com.apple.security.cs.disable-library-validation": true,
};
