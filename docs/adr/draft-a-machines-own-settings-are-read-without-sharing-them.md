# ADR-draft-a-machines-own-settings-are-read-without-sharing-them: A Machine's own settings are read without sharing them

## Decision

Desktop's Settings shows what each Machine keeps locally through the read-only
`machineOwn` front-door RPC. It reads configured `projects.root`, `chat_harness`,
remembered answers, and executable harnesses on that host's PATH. Unconfigured keys
are omitted. Shared settings and their nested values stay out of remembered answers.

The call is additive under board protocol 4. An older host's unknown request is a
missing reading, never a reason to refuse its paired link or board. Desktop reads
on connection and when Settings opens, independently of the board stream.

Desktop saves its last successful reading with its read time. When a Machine cannot
be reached, Settings keeps those values and labels when they were read. Removing
the Machine removes that saved reading. Desktop never writes these values back.

## Why

The Flock's latest-edit rule applies only to shared settings. Operators need to
see local differences without making a local Projects root or Native chat choice
an edit that reaches every Machine.
