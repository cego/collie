# A release set tags each repository once

**Status: proposed** with #345. It amends what docs/workflows.md (Release, A set) says each
child of a set does: "Each child is a release as below".

## Context

Each child of a release set merges and tags its own merge request, so three merge requests
released together become three versions. To get one version, run-a97d903d held two of
#329, #330 and #331's Release Runs before Tag and stopped them after the third tagged. They
stay `suspended` with a `merged` disposition, and resuming either would tag again.

## Decision

**D1. A child of a set merges and never tags.** It keeps everything else a Release Run
does before its merge: its own review, Checks, Go and Helle claims. It ends `merged`.

**D2. The set's Run tags each repository once.** Once no child in a repository is still
going, the set's Run tags that repository over what its children merged. It uses the same
tag step, read-back and, for an application, stage and production steps that a single
Release uses. A child that failed or was left open does not stop the others' tag; the Run
names it.

**D3. Every set works this way; there is no input to choose.** A Release of one merge
request is unchanged.

## Rejected

- **An input to opt in.** A set exists to release things together. A choice on every start
  would keep the back-to-back versions as the default for no stated need.
- **The last child to merge tags.** Gos come in any order, so no child knows ahead of time
  that it is last.

## Consequences

- A set no longer leaves Runs held or stopped before Tag.
- Stage-from-tag and the production Go happen once per repository, on the set's Run, not
  on each child.
