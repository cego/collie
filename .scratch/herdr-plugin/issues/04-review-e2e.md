# 04: review end to end (standalone)

**What to build:** Pick `review`; target inferred MR → branch diff → working tree; reviewer Persona writes review.json (verdict + findings) to the run dir and a summary in the tab; posting to GitLab only with post: true.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] diff-target inference order tested against fake glab/git
- [ ] review.json validated against the Output schema
- [ ] post defaults to false
