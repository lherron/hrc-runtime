# Retained parity comparison dependencies

The Bun baseline provisioner and source-capture entry points have been retired.
No new baseline or golden is produced here.

`run.py` and its comparator modules remain pending the later native-driver
sweep. Current callers include native routes, accounting, session_index,
session_projection, owner_relative_controls, participant succession and the
listed n2 participant / n3 messages drivers. They still consume explicit paired
captures; this is listed compatibility machinery, not no-Bun native evidence.
The T-13069 disposition table records this dependency group under Mable's ruling.

`owner_relative.py` is different: `bounded_ready` validates the raw bounded
stream ready frame against that owner's sampled ledger page. The cargo leg's
`foundation.py` imports it and asserts the predicate. Keep this checker.

Run retained checker controls with:

```sh
python3 conformance/hrc-parity/run.py controls --out /tmp/parity-controls
```

`n4_release.mjs` and `n4_telemetry.py` need separately scoped native qualification;
keep them listed until their callers and release-tooling boundaries are resolved.
