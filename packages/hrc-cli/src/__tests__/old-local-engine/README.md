# Frozen old-local engine (test double only)

Byte copies of `hrc-sdk/src/project-placement.ts` and
`hrc-core/src/runtime-intent-assembly.ts` at hrc-runtime `ad04040d`
(pre-T-08597), with only import specifiers rewritten (`hrc-core` package
instead of relative paths; `ProjectOrigin` inlined).

Purpose: the CLI fake daemon (`../fake-daemon.ts`) serves the PRE-migration
local semantics over the test socket so command-level CLI tests keep asserting
their exact historical expectations hermetically. Correctness of the NEW
daemon-backed path is proved by the T-08597 route parity table, not here.

Do not edit for behavior. Delete when the last consumer migrates off the fake.
