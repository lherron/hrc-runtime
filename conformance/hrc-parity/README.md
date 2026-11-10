# Native bounded-stream checker

`owner_relative.py` supplies `bounded_ready` to the cargo gate through
`crates/hrc-native/e2e/foundation.py`. It checks the raw ready frame against
that owner’s sampled ledger page, including incarnation and replay head.

The paired capture suites, comparators, capture helpers and their case catalog
were retired under T-13156. Native behavior is asserted by the e2e drivers in
`crates/hrc-native/e2e` and `crates/hrc-cli/e2e`.
