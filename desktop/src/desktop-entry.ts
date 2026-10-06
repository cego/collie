/** `entry` with its Name and Comment saying Collie rather than the build's `name`. */
export const withCollieName = (entry: string, name: string) =>
  entry.replace(/^(Name|Comment)=.*$/gm, (line) => line.replace(name, "Collie"));
