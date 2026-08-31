# Collie is one Effect program with two adapters

Collie replaces herdr-plugin and herdr-workflows in one big-bang cutover. Its Herdr actions
and `collie` CLI are thin adapters over the same Effect v4 services, schemas, layers, and
Bun runtime so every interactive capability is also available programmatically without a
second implementation. We accept Effect's unstable CLI API and breaking the old executable,
plugin ID, state location, and persisted Runs rather than carrying two architectures or a
compatibility layer.
