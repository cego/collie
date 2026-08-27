# 01: Run-dir plan artefacts and plan-dir inference

**What to build:** Prompts can reference {{run.dir}}; a new Input strategy `plan-dir` resolves to the newest finished plan Run for this repo that has plan/SPEC.md, else asks. Remove tasks/ and .scratch/ assumptions from baseline prompts and inference. (ADR-0002)

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] {{run.dir}} substituted in every step prompt (tested)
- [ ] plan-dir picks newest finished plan run for the same repo, ignores other repos (tested)
- [ ] plan-file strategy removed; no baseline text mentions tasks/
