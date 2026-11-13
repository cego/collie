A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

## investigate

Investigate this goal on this Machine:

{{goal}}

{{measure}}

Reproduce the behaviour where you can and trace it to its cause. Report what you found
with concrete evidence: files, observations and the commands you ran. Distinguish a fact
from an inference and say what you could not check. Change only what the goal asks you
to change. Write the summary and findings to your Output. Collie reports it to the agent
that asked and closes this Run's agent afterwards; no polling or follow-up pane is needed.

Put the complete findings and evidence in a Markdown report under `{{run.dir}}/handoffs/`.
Register it on your Run through `collie_do artefact_register` with `role: report`, or
`collie run artefact register --role report`. Return `report` with the registration's `installation`,
`run`, `id`, `revision`, and originating `step`. Keep `summary` within 360 Unicode
characters and two sentences. Use short `blocker` and `next_action` fields where action
is needed. Keep the findings in your Output too; registration does not prove them.
