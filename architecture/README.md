# HRC architecture records

This directory contains the machine-checked architectural laws adopted by
`hrc-runtime`. The YAML records under `records/` are normative. The Markdown
summaries and `index.jsonl` are generated projections.

Run `just architecture-records --write` after changing a record, then run
`just architecture-records` to verify the records, their sources, the required
baseline IDs, and the generated projections. `just verify` includes this check.

Records are not implementation notes. An invariant describes behavior that must
remain true, cites its authority and source evidence, names the tests that prove
it, and states when it must be reopened.
