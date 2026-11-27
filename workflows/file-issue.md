## file-issue

File this finding as one Linear issue, through the Linear MCP:

{{goal}}

Team: {{team}} — where that is empty, ask me in your pane which team the issue goes to, once, and file it there.

The issue's title is the finding's title, without its severity or the file it names. Its
description carries what the finding says: where it is, what it is, the `basis` the finding
was made on, the evidence that shows it, and the fate the finding suggested. Name the
project and the commit the finding is about where the finding names them. Keep it in the
finding's own words: nothing about Collie, a Run, a step or an agent, and nothing about how
this issue came to be filed.

Your Output holds:

- `identifier`: the issue's key, as Linear shows it, such as `CEGO-12`;
- `url`: the issue's own URL, which is what the Run answers with.
