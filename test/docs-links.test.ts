// Every link between the repository's own documents, walked. AGENTS.md is a navigation
// file and the docs point at each other by heading; a renamed section leaves a link that
// still looks right in a diff and lands nowhere, which is how `#scope-this-workspace-or-
// the-whole-session` outlived the section it named. A rename now fails here instead.

import { Effect, FileSystem } from "effect";
import { expect, test } from "bun:test";
import { runEffect } from "./support/effect";

const ROOT = `${import.meta.dir}/..`;

/** Where a relative link points, from the document that wrote it. Repository-only. */
function resolve(from: string, link: string): string {
  const parts = `${from.split("/").slice(0, -1).join("/")}/${link}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** GitHub's heading slug, near enough for the headings this repository writes. */
function slugs(markdown: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const [, heading] of markdown.matchAll(/^#+ (.+)$/gm)) {
    found.add(
      heading!
        .toLowerCase()
        .replace(/`|\*|\[|\]|\(.*?\)/g, "")
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ /g, "-"),
    );
  }
  return found;
}

test("every link between the repository's documents resolves, anchors included", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: ROOT })].filter(
        (path: string) => !path.startsWith("node_modules/") && !path.startsWith("plans/"),
      );
      expect(files).toContain("AGENTS.md");

      const broken: string[] = [];
      for (const file of files) {
        const text = yield* fs.readFileString(`${ROOT}/${file}`);
        for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          if (link!.startsWith("http") || link!.startsWith("mailto:")) continue;
          const [path, anchor] = link!.split("#");
          // A link to a directory — `docs/adr` — is a link to the listing, and has no
          // headings of its own for an anchor to name.
          if (path !== "" && !path!.endsWith(".md")) continue;
          const target = path === "" ? file : resolve(file, path!);
          if (!files.includes(target)) {
            broken.push(`${file} -> ${link} (no such file)`);
            continue;
          }
          const body = yield* fs.readFileString(`${ROOT}/${target}`);
          if (anchor !== undefined && !slugs(body).has(anchor)) {
            broken.push(`${file} -> ${link} (no such heading)`);
          }
        }
      }
      expect(broken).toEqual([]);
    }),
  ));
