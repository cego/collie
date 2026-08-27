# herdr-plugin

Codified agent workflows for herdr: `plan`, `implement`, `review` — deterministic multi-tab orchestrations you pick from a popup.
A shared starting point, not a restriction: fork any workflow or persona into your own layer.

## Install (local link, no GitHub needed)

```sh
git clone git@gitlab.cego.dk:cego/herdr-plugin.git ~/.herdr-plugin
herdr plugin link ~/.herdr-plugin
```

Add a keybinding in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+w"
type = "plugin_action"
command = "cego.workflows.pick"
```

## Layers

Definitions are markdown files with YAML frontmatter. Same name in a later layer wins:

1. `workflows/`, `personas/` in this repo (team baseline)
2. `$(herdr plugin config-dir cego.workflows)` (yours)
3. `.herdr/workflows`, `.herdr/personas` in the project you're in

`fork` copies a baseline definition into layer 2 or 3 for editing.

See `CONTEXT.md` for the vocabulary and `docs/adr/` for decisions.
