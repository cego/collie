# 07: Fork + release pipeline

**What to build:** `fork` copies a baseline Workflow/Persona into the user or project Layer; CI builds per-platform binaries on tag and install.sh fetches them so teammates install without bun.

**Blocked by:** 02

**Status:** done

- [x] fork to user and project layers
- [x] tag → release with linux/darwin x64/arm64 binaries
- [x] fresh clone + herdr plugin link works without bun

**Notes:** `fork` is the third plugin action and shares the picker: pick a workflow or
persona (each shown with the layer it currently comes from), then pick "my layer" or
"this project". It never overwrites an existing fork — that file is the one you already
edited — and refuses to fork a definition into the layer it already lives in.

Release: `.gitlab-ci.yml` runs `bun test` and `tsc --noEmit` on every push, and on a
tag cross-compiles `bun-{linux,darwin}-{x64,arm64}`, uploads each to the generic
package registry, and creates a release whose asset links are what `install.sh`
downloads. All four targets were built locally to confirm `bun build --compile
--target=` produces the right binaries.

Filled-in decision: `install.sh` falls back to building with bun when there is no
release asset *and* bun is present. Consumers still need no runtime (ADR-0001); the
fallback only helps a machine that is developing the plugin, where `herdr plugin link`
would otherwise leave no runner at all.

**Live check:** built the four binaries into a local directory, cloned the repo fresh,
and ran `install.sh` under `env -i` with bun and mise stripped from PATH and
`HERDR_WORKFLOWS_RELEASE_BASE` pointed at that directory — it fetched
`herdr-workflows-linux-x64` and the binary ran. `herdr plugin link <fresh clone>`
then registered all three actions and both panes, and `fork` copied `review` into the
project layer and the `reviewer` persona into a user layer, both byte-identical to the
baseline. The release URL was simulated with `file://`; the GitLab job itself is
unrun, since the repo has no remote.
