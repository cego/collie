# 17: partial overrides — a layer file may `extends:` a definition and change only what it names

**What to build:** A workflow or persona file in any layer may declare `extends: <name>` (resolved through the layers below it, so user extends baseline, project extends user-or-baseline). The result is the parent with the child's frontmatter deep-merged — steps matched by `id` (a child step with a new id is appended; `parallel` and `choices` replace wholesale, other keys merge), inputs merged by name, scalars overridden — and the child's `## <section>` bodies replacing the parent's section of the same name; child preamble replaces parent preamble only when non-empty. A file without `extends:` still replaces the whole definition (current behaviour). Cycles and unknown parents are validation errors that name the file. `fork` writes an `extends:` stub by default (frontmatter with `extends:` and the step the human picked, prompting for which step) and keeps a `--full` copy option; full copies record `forked_from_hash` and the picker shows `(stale)` next to a full fork whose parent hash has changed. README documents `extends:` with the review-reviewers example as the canonical use.

**Blocked by:** 15 (same loader files)

**Status:** done

- [x] merge semantics tested: step merge by id, parallel replaced wholesale, section body override, preamble rule
- [x] cycle and unknown parent are validation errors naming the file (tested)
- [x] fork default writes an extends stub; --full writes a copy with forked_from_hash; picker shows (stale) (tested)
- [x] README + docs/WORKFLOWS-DESIGN.md + CONTEXT.md (term: Override) updated; bun test + tsc green
- [x] live smoke: replace mk's user-layer review.md copy with the extends stub above and run review → pi and opus variants start, synthesize still runs

## Decisions where the design was silent

**"The layers below it" is just the map so far.** Layers are already loaded in order, so the
parent of a file in layer N is whatever is in the map when that file is read. Within one
layer, a child whose parent is a sibling file resolves that sibling first, with a visited
set — which is the only place a cycle can occur, and it names both files.

**A definition that cannot resolve does not go in at all.** An unknown parent or a cycle is
an error and the child is absent, rather than a half-merged definition that would run and
surprise someone. The other definitions in that layer still load.

**The merged body is rebuilt, not spliced.** Sections are merged as a map and the body is
written out again from the parts, so exact whitespace between sections is normalised. Every
reader of a body already goes through `bodySections`, so nothing depends on the original
spacing — and splicing text would have needed a second, weaker parser.

**"The child did not name a title" is `title === name`.** A workflow file with no `title:` is
parsed as titled after itself, so that is what an unnamed title looks like by the time the
merge sees it. `description` needs no such rule: it defaults to empty.

**`fork` asks how, and asks which step.** There is no CLI to put a `--full` flag on, so the
fork picker gained two questions: stub or full copy, and — for a stub of a workflow — which
step, whose prompt is copied into the stub so the file has something in it to edit. A persona
stub gets a one-line note instead, because a persona has sections rather than steps.

**Staleness is measured against the file a copy shadows.** At load time, a definition
carrying `forked_from_hash` is given the current hash of the definition it shadows; `(stale)`
is those two differing. It costs one extra file read per full copy and nothing at all for a
stub, which cannot go stale by construction.

## Verified live

mk's user layer held a **89-line full copy** of `review.md`, which is why two live smokes
before this one silently used the old menu: the copy shadowed every baseline change made to
that workflow. It was replaced (the original kept beside it as
`review.md.full-copy.bak`) with a **9-line stub**:

```yaml
---
name: review
extends: review
steps:
  - id: review
    parallel:
      - { harness: claude, model: opus, effort: medium }
      - { harness: pi, model: openai-codex/gpt-5.6-sol, effort: medium }
---
```

A real run from that stub started `Opus` and `gpt-5.6-sol` — the stub's two variants — in one
tab, and the baseline's `synthesize` step ran after them. Everything the stub does not
mention (the target input, the synthesis, the end menu, every prompt body) came from the
baseline, which is the whole point.

Incidentally verified in the same run: the **tab collision rule** from ticket 18. An older
`⚙ Review` tab was still open, so the new run's tab read `⚙ Review · smoke-help`.
