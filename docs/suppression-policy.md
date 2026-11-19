# Suppression Policy

New lint and type suppressions must be reviewed and carry a ticketed exception in this form:

EXCEPTION(T-05495): reviewed justification for this specific suppression.

Place the exception on the same comment as the suppression or on the directly preceding comment line. Existing suppressions are grandfathered only through `.suppression-baseline.json`; update that file only for reviewed resets.

`scripts/check-suppressions.ts` enforces this on TypeScript and JavaScript sources (`biome-ignore`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`). It runs in the lefthook pre-commit hook and in `just check`, not in `just verify`. It does not scan Rust, so `#[allow(...)]` attributes in `crates/` are not checked.
