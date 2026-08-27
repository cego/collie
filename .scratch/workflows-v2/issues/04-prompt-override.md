# 04: Embedding prompt-section override

**What to build:** An embedding step (`use:`) may set `prompt: <section>` to pick a differently named section of the embedded workflow's body, so one workflow can carry attended and unattended prompt bodies.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] section selection tested; unknown section is a validation error

## Decisions where the design was silent

- **`prompt: <section>` works on any step, not only a `use:` step.** `architecture`
  itself needs to say which of its two bodies is the attended one, and one rule beats
  two. On a `use:` step the section is looked up in the *embedded* workflow's body, so
  the error message names that file and lists the sections it does offer.
- The embedded step's preamble still comes from the embedded workflow, so the shared
  text above the first heading applies to both bodies.
