# Public text reads as the human's

On 2026-11 review Run vm-mk:run-67a6e669 posted its review to a teammate's merge request,
gitlab.cego.dk spilnu/frontend/monorepo!522. The review said "this Run records no failing
execution" and "The review-step rule requires seeing new tests fail: record targeted failing
runs through collie verify --expect fail". That was Collie's internal `review.md`, posted as
written. It named Collie's Runs, steps and CLI, and it held a teammate to an evidence rule
that only Collie has. Replies ended "Posted by Collie's Run <run> on <machine>.", and the
implement agent wrote MR descriptions and commit messages itself with `glab`, `gh` and
`git`, so no code saw that text before it was published.

## Decision

**Public text** is anything Collie sends outside Collie in the human's name: MR/PR notes,
replies, titles and descriptions, commit messages, and issue comments in a repository other
than Collie's own. It must read as the human writing for that repository's audience. It
never names Collie, Runs, steps, agents, cards or `collie` commands. It never states a rule
that only Collie's process has. A finding that exists only because of that process is kept
internal. It is posted only where it can be restated as an ordinary concern that the
repository's own conventions support.

- **Hidden marker only.** A public post has no visible attribution. Collie finds its own
  earlier post after a crash by an HTML comment, `<!-- collie:<run> … -->`, which does not
  show on the rendered page. This replaces the reply footer and the visible review
  signature from cego/collie#368.
- **The host publishes, after one check.** All public text leaves through the host. It
  runs one deterministic check first, and refuses with the reason rather than rewriting.
  That covers review notes, replies, issue filing and comments, and the MR. The agent's
  `{{mr.create}}` and `{{mr.comment}}` become a `collie` command. The host checks the
  title, the description and the commit messages it is about to push, then pushes and
  opens or comments. A refused agent rewords locally and runs it again. Prompts state the
  same contract, so a refusal is rare rather than routine.
- Collie's own repository, the board and a Run's records keep full detail. Slack run
  notifications go to the human's own channel and are out of scope. The MR link shared for
  approval is public text.

## Consequences

Already-posted leaks are listed for the human, who decides whether to edit or delete them.
Collie edits none of them. An agent's own Linear or Slack MCP calls stay under the prompt
contract alone, because Collie does not carry them.
