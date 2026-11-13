import { expect, test } from "bun:test";
import { artefactLines, type Artefact } from "../src/artefact-model";

const base: Artefact = {
  id: "a1",
  run: "r1",
  kind: "file",
  role: "deliverable",
  title: "notes.md",
  ref: "registered:/srv/notes.md",
  source: "/srv/notes.md",
  mediaType: "text/markdown",
  size: 12,
  revision: 2,
  digest: "abc",
  created: null,
  updated: { at: "2026-11-01T00:00:00.000Z", provenance: "filesystem-mtime" },
  registeredAt: "2026-10-01T00:00:00.000Z",
  observedAt: "2026-11-02T00:00:00.000Z",
  detectedAt: "2026-11-02T00:00:00.000Z",
  seen: { revision: 1, at: "2026-10-02T00:00:00.000Z" },
  sourceAvailability: "available",
  retainedAvailability: "available",
  reason: null,
};

test("a terminal reads a file by its revision and a link by its destination and provider", () => {
  expect(artefactLines("r1", base)).toEqual([
    "notes.md · deliverable · text/markdown · 12 bytes · revision 2 · Updated",
    "Created: unknown · Updated: 2026-11-01T00:00:00.000Z (filesystem-mtime) · Observed: 2026-11-02T00:00:00.000Z",
    "available source · available retained",
    "collie run artefact read r1 a1 --revision 2",
  ]);
  expect(
    artefactLines("r1", {
      ...base,
      kind: "codex-site",
      title: "Demo",
      url: "https://demo.sites.example/",
      digest: "",
      size: 0,
      mediaType: "",
      seen: null,
      updated: null,
      sourceAvailability: "untracked",
      retainedAvailability: "none",
      provider: {
        name: "codex-sites",
        namespace: "ws-a",
        resource: "proj_1",
        version: "d2",
        provenance: "caller-reported",
        observedAt: "2026-11-02T00:00:00.000Z",
      },
    }),
  ).toEqual([
    "Demo · deliverable · codex-site · revision 2 · Unseen",
    "Created: unknown · Updated: unknown · Observed: 2026-11-02T00:00:00.000Z",
    "External updates not tracked · none retained · codex-sites ws-a/proj_1 version d2 (caller-reported)",
    "Open: https://demo.sites.example/",
  ]);
});
