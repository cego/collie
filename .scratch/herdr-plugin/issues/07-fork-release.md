# 07: Fork + release pipeline

**What to build:** `fork` copies a baseline Workflow/Persona into the user or project Layer; CI builds per-platform binaries on tag and install.sh fetches them so teammates install without bun.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] fork to user and project layers
- [ ] tag → release with linux/darwin x64/arm64 binaries
- [ ] fresh clone + herdr plugin link works without bun
