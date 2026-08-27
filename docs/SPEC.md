# Spec — herdr-plugin: codified agent workflows

Status: v1, shipped and partly superseded (2026-08-27). Vocabulary: see `CONTEXT.md`.
Respects ADR-0001.

ADR-0002 moved plan artefacts out of the repository, so the `tasks/<slug>/PLAN.md` story
and the `plan-file` strategy below are gone — a plan lives in the Run directory and
`plan-dir` inference finds it. `docs/WORKFLOWS-DESIGN.md` is the
current design for the baseline workflows and personas.

## Problem Statement

Our agent work is ad hoc. Every time I plan a feature, implement a ticket, or review an MR I hand-assemble the same sequence: open panes, start the right harness, paste the persona, run a review, feed findings back, repeat. The sequence lives in my head, so teammates can't pick it up, results vary run to run, and the repetitive implement→review→fix loop eats the time I'd rather spend on the plan and on testing the result.

## Solution

A herdr plugin that offers a popup picker of Workflows. Choosing one infers its Inputs from context, opens one tab per Step, starts the chosen Harness/Model with the right Persona, waits on structured Outputs, and drives loops (implement → parallel reviews → fix, max 5) deterministically. The baseline Workflows (`plan`, `implement`, `review`) live in git as a starting point; anyone can fork a Workflow or Persona into their own Layer or a project's `.herdr/` without touching the baseline. The human invests in the plan up front and in testing at the end; the middle is codified.

## User Stories

1. As a developer, I want to open a picker with one keybinding and choose a Workflow, so that I don't rebuild my process by hand.
2. As a developer, I want the picker to be filterable by typing, so that a growing list stays fast to navigate.
3. As a developer, I want Inputs inferred from my branch, cwd, `tasks/` and open MR, so that a Workflow usually starts with zero typing.
4. As a developer, I want to see a one-line confirmation of what was inferred before anything starts, so that inference never surprises me.
5. As a developer, I want to be asked only for Inputs that couldn't be inferred, so that prompts stay minimal.
6. As a developer, I want to run `plan` on a free-text goal without a ticket, so that I can start locally before anything reaches Linear.
7. As a developer, I want `plan` to interview me before writing, so that the plan reflects my thinking, not the agent's first guess.
8. As a developer, I want `plan` to write `tasks/<slug>/PLAN.md`, so that `implement` finds it automatically.
9. As a developer, I want `implement` to build from a plan file, run reviews in parallel, and loop on findings, so that the repetitive middle is automatic.
10. As a developer, I want each Step in its own tab, so that I can watch any agent without losing the others.
11. As a developer, I want reviewer tabs per reviewer, so that multi-model reviews are visible side by side.
12. As a developer, I want a small runner status pane, so that I know which Step/iteration the Run is in.
13. As a developer, I want the Agents sidebar filtered to the current Run while it is active, so that unrelated agents don't clutter it.
14. As a developer, I want tabs left open and marked ✓ when a Step finishes, so that I can read what happened.
15. As a developer, I want a toast when a Run finishes or blocks, so that I can work elsewhere meanwhile.
16. As a developer, I want the fix loop capped (default 5) and configurable, so that runs can't spin forever.
17. As a developer, I want the same implementer agent to apply fixes by default, so that context isn't lost between iterations.
18. As a developer, I want a per-Step `fresh` toggle, so that reviewers (or anyone) can start with no prior context.
19. As a developer, I want findings from all reviewers unioned into the fix prompt, so that nothing is dropped.
20. As a developer, I want the implementer to be able to mark findings as disputed and see them at the end, so that bad findings don't get blindly applied.
21. As a developer, I want `review` to run standalone on an MR, a branch diff, or the working tree, so that I can review others' MRs with the same Persona.
22. As a developer, I want `review` to post to GitLab only when I opt in, so that external side effects are never accidental.
23. As a developer, I want each Step to choose Harness and Model with sensible defaults, so that I can mix claude/codex/opencode and models per Step.
24. As a developer, I want my own default Harness/Model in my config Layer, so that the baseline stays harness-neutral.
25. As a developer, I want a Workflow validated fully before any tab opens and to fail fast on an unknown model, so that I fix it instead of discovering a half-run.
26. As a developer, I want Workflows and Personas as markdown with frontmatter, so that I can edit them in any editor and diff them in git.
27. As a developer, I want to fork a baseline Workflow or Persona into my user Layer or the project's `.herdr/`, so that I can change it without touching the team baseline.
28. As a developer, I want a same-named definition in a later Layer to win, so that overriding is just "copy and edit".
29. As a developer, I want `implement` to embed `review` by reference, so that overriding `review` changes every Workflow that uses it.
30. As a team lead, I want the baseline in a git repo installed by `git clone && herdr plugin link`, so that everyone starts from the same point.
31. As a teammate, I want installation to not require bun or any runtime, so that it works on a fresh machine.
32. As a teammate, I want definition edits to take effect without a rebuild, so that iterating on prompts is instant.
33. As a developer, I want every Run recorded (Inputs, Outputs, status) in a run directory, so that I have an audit trail.
34. As a developer, I want to resume a Run, skipping finished Steps and restarting unfinished ones fresh, so that a herdr restart doesn't waste work.
35. As a developer, I want a Step that blocks (agent needs input) to hand off to me with a toast, so that I can unblock and continue.
36. As a developer, I want to append an `mr` Step to `implement` in my own Layer, so that MR creation is my choice.
37. As a developer, I want Step Outputs read from JSON files, not terminal text, so that gates are reliable across harnesses.
38. As a developer, I want Run ids and tab names to show Workflow + input, so that concurrent Runs are distinguishable.

## Implementation Decisions

- The deliverable is a herdr plugin (`herdr-plugin.toml`, id `cego.workflows`). No standalone CLI is exposed; actions are `pick` and `resume`, plus a popup pane `picker`. Surface = herdr's plugin actions + a keybinding.
- Runner: TypeScript compiled with Bun into one binary per platform, fetched at install by the manifest build step from a release (ADR-0001). Definitions never require a rebuild.
- Runner talks to herdr only through the herdr CLI/socket (`workspace/tab/pane`, `agent start/prompt/wait`, `agent.view.set`, `notification.show`, `plugin.pane.open`).
- Definitions: Workflow = one markdown file, YAML frontmatter (`name`, `inputs` with inference strategies, `steps`, loop config, `max_iterations` default 5) + prompt body with `{{input}}`/`{{outputs}}` templating. Persona = markdown with frontmatter (`name`) + body. Steps declare `id`, `persona`, optional `harness`, `model`, `fresh`, `output`, `parallel` (list of harness/model variants), or `use: <workflow>` to embed by reference.
- Layers resolved in order baseline → user config dir → project `.herdr/`; name collision ⇒ later wins; `use:` resolves through the same lookup. `fork` copies a definition to a chosen Layer.
- Harness adapter table: per supported harness, how to start it, pass a model, and inject a Persona (initial prompt / system-prompt flag). Unknown model or harness ⇒ validation error before any tab opens.
- Run directory under the plugin state dir: `runs/<id>/` with inputs, per-step status and Output JSON. Review Output schema: `{ verdict: clean | findings, findings: [{ file, line?, severity, title, detail }], disputed?: [...] }`. Loop gate reads `verdict` from each reviewer's Output; union of findings feeds the fix prompt.
- Tab topology: one tab per Step; parallel variants each get a tab; a small runner status pane in the first Step's tab; tabs renamed with ✓/✗ on completion; `agent.view.set` filters sidebar to the Run's agents, cleared on finish.
- Input inference strategies: `plan-file` (newest `tasks/**/PLAN.md`, else ask), `diff-target` (open MR via glab → branch vs default base → working tree), `goal` (ask), `ticket` (from branch name, optional).
- Resume: `resume` action lists Runs with unfinished Steps; finished Steps are skipped based on recorded Output; unfinished restart with a fresh agent (never reattach).
- Standalone `review` posts to GitLab only with an explicit `post: true` Input.
- Picker: built-in minimal TUI in the runner (list, type-to-filter, enter), rendered in the plugin popup pane.

## Testing Decisions

Seams (highest possible, fewest possible):
1. **The herdr boundary** — a fake `herdr` executable/socket recorder injected via `HERDR_BIN_PATH`/`HERDR_SOCKET_PATH`. Tests run a Workflow end to end against it and assert the sequence of herdr commands (tabs created, agents started with which harness/model args, prompts sent, waits) and the resulting run directory. This is the primary seam; it is what a user would observe.
2. **The definition loader** — given three Layer directories, assert resolution, `use:` embedding and validation errors (unknown model fails fast). Pure functions over files.

A good test asserts observable behaviour (herdr calls, files written, error messages), not internal structure. Prior art: none in this repo; use bun's test runner. Manual verification: `herdr plugin link` + run `plan` in a real session.

## Out of Scope

- Custom sidebar entries in herdr (not possible; no upstream request).
- Reattaching to live agent context on resume.
- Consensus/judge fan-in (v1 unions findings).
- Baked-in MR creation in `implement` (composable `mr` step later).
- Harness-native config generation (Personas are injected, not installed).
- GitHub/marketplace publishing; GitLab is the primary distribution.
- Windows.

## Further Notes

Verified facts: herdr ≥0.7.5 has the plugin system used here; latest 0.8.2. `herdr plugin install owner/repo` is GitHub-only, hence `link`. Baseline Personas: implementer, reviewer, planner (interviewer). Naming stays minimal: Workflow, Step, Persona, Run, Layer.
