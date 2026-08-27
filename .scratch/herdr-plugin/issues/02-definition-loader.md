# 02: Definition loader with three Layers

**What to build:** Workflows and Personas load from baseline → user config dir → project .herdr/, later wins by name; `use:` embeds by reference through the same lookup; unknown harness/model fails validation with a clear message before anything runs.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] same-name override in later layer wins (tested)
- [ ] use: resolves through layers (tested)
- [ ] validation error names the step and the bad model
