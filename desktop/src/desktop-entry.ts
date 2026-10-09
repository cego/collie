/** `entry` with its Name and Comment saying Collie rather than the build's `name`. */
export const withCollieName = (entry: string, name: string) =>
  entry.replace(/^(Name|Comment)=.*$/gm, (line) => line.replace(name, "Collie"));

/** A macOS bundle's `plist` with the name its menu bar and Dock show saying Collie. */
export const withCollieBundleName = (plist: string, name: string) =>
  plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)([^<]*)/,
    (_, key: string, value: string) => key + value.replace(name, "Collie"),
  );
