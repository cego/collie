// {{a.b}} substitution for prompt bodies. Unknown keys render empty and are
// reported so a typo in a definition is visible instead of silent.

export interface Rendered {
  text: string;
  missing: string[];
}

export function renderTemplate(text: string, vars: Record<string, unknown>): Rendered {
  const missing: string[] = [];
  const out = text.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_all, path: string) => {
    const value = lookup(vars, path.split("."));
    if (value === undefined || value === null) {
      if (!missing.includes(path)) missing.push(path);
      return "";
    }
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
  return { text: out, missing };
}

function lookup(vars: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = vars;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "run";
}
