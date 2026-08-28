# 17: partial overrides — a layer file may `extends:` a definition and change only what it names

**What to build:** A workflow or persona file in any layer may declare `extends: <name>` (resolved through the layers below it, so user extends baseline, project extends user-or-baseline). The result is the parent with the child's frontmatter deep-merged — steps matched by `id` (a child step with a new id is appended; `parallel` and `choices` replace wholesale, other keys merge), inputs merged by name, scalars overridden — and the child's `## <section>` bodies replacing the parent's section of the same name; child preamble replaces parent preamble only when non-empty. A file without `extends:` still replaces the whole definition (current behaviour). Cycles and unknown parents are validation errors that name the file. `fork` writes an `extends:` stub by default (frontmatter with `extends:` and the step the human picked, prompting for which step) and keeps a `--full` copy option; full copies record `forked_from_hash` and the picker shows `(stale)` next to a full fork whose parent hash has changed. README documents `extends:` with the review-reviewers example as the canonical use.

**Blocked by:** 15 (same loader files)

**Status:** ready-for-agent

- [ ] merge semantics tested: step merge by id, parallel replaced wholesale, section body override, preamble rule
- [ ] cycle and unknown parent are validation errors naming the file (tested)
- [ ] fork default writes an extends stub; --full writes a copy with forked_from_hash; picker shows (stale) (tested)
- [ ] README + docs/WORKFLOWS-DESIGN.md + CONTEXT.md (term: Override) updated; bun test + tsc green
- [ ] live smoke: replace mk's user-layer review.md copy with the extends stub above and run review → pi and opus variants start, synthesize still runs
