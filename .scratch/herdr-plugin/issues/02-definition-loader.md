# 02: Definition loader with three Layers

**What to build:** Workflows and Personas load from baseline → user config dir → project .herdr/, later wins by name; `use:` embeds by reference through the same lookup; unknown harness/model fails validation with a clear message before anything runs.

**Blocked by:** 01

**Status:** done

- [x] same-name override in later layer wins (tested)
- [x] use: resolves through layers (tested)
- [x] validation error names the step and the bad model

**Notes:** Filled-in decisions. (a) Per-step prompts come from `## <step-id>` sections
of the workflow body, with the text before the first heading as a shared preamble; a
one-step workflow with no headings uses its whole body. (b) `use:` expands the
referenced workflow's steps inline; the embedding step's own keys win over the
embedded ones, so overriding `review.md` in a later Layer changes every embedder.
(c) A model is known if it is in the adapter's alias list, matches the adapter's
pattern (`opencode` requires `provider/model`), or is listed in
`config.json > models.<harness>` in the user Layer. (d) User defaults live in
`config.json` in the plugin config dir: `harness`, `model`, `max_iterations`, `models`.
