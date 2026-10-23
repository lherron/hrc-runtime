# Native store runner integration (in progress)

`run.py run --suite p1-native-store --profile PROFILE --out NEW` dispatches native
storage qualification separately from P0 Bun daemon workflows. The P0 nine-case
suite remains unchanged. Profiles explicitly pin native executable/source/build,
qualified Bun release, retained repository batch and coverage bindings. No default
endpoint or owner process is invented for native admission.

`profile.make_native_profile(identity,repositories,coverage_bindings)` produces a
readback profile. Set `mode: execute` and `frozenBuild` to a native_freeze directory
for the fixed repository producers. `native_capture.py` records actual commands,
stdin digests, identities, source bytes and completion. Every gap remains in raw
revalidation output; passing producer exit codes cannot certify operations.

`contract/hrc-parity/native-store.json` retains418 public operations,81 direct
files,95 SQL templates,302 helper declarations,101 migrations and789 schema
anchors. The audit is identity discovery, not behavior proof. Coverage bindings
require exact identity sets, explicit native signatures/behavior and raw semantic
assertions carrying checker-derived coverageIdentities for that exact obligation.
No generic identity/manifest assertion or raw-output-only predicate may close it.

Mandatory finite/presentation/consumer/schema/discriminator adapters are explicit.
Outer family guards require a complete manifest, caller-pinned common native/Bun
tuple and producer-specific stdout shape. Older finite20 lacks an outer manifest
and stays a historical integration GAP; the producer now emits it for fresh runs.
Independent subset grades retain their exact historical builds. New helper and
family bindings remain under implementation; installed-native admission is still
explicitly GAP. This adapter checkpoint cannot yield whole-P1 PASS yet.

No installed/native claim derives from source receipts. Mable coordinates canonical
landing/install and real installed driver acceptance. Binary name stays rusthrc;
Bun hrc stays unchanged. P2 currently integrates as a library-only package with no
second binary target.
