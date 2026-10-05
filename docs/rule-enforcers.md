# Rule → enforcer

One row per repo rule an agent can break, naming what fails when it does
(docs-are-true §6). `judgment` means nothing fails; the rule is guidance. When a
`judgment` rule is broken again, move it up to a check, type or test rather than
adding prose. Where each gate runs: `pre-commit` (lefthook, blocks the commit),
`check` (`just check`, inside `just verify`), `verify` (`just verify`, after the
push on mini, catches but does not block).

## Enforced

| Rule | Enforcer | Runs in |
|---|---|---|
| A test process never inherits GIT_DIR/GIT_WORK_TREE or a live wrkq locator | `scripts/hermetic-test.ts` + `scripts/lib/hermetic-test-env.ts`; the preload refuses a bypassing run | every test run |
| Every test root registers the preload, runs through the hermetic runner, and sits in one verify tier | `scripts/check-test-hermetic.ts` | check |
| Daemon code runs subprocesses only through `runBoundedSubprocess`; no synchronous spawn in hrc-server or its workspace deps | `scripts/check-daemon-subprocess.ts` (raw-spawn baseline is `{}`: any raw spawn fails) | check |
| A test double is typed against the production interface it stands in for and type-checks; a new or changed double for a cross-project producer (wrkq ledger, aspd, ghostmux) cites a captured wire fixture | `scripts/check-test-doubles.ts` (ratchet: `scripts/test-double-baseline.json` only goes down); see [test-doubles.md](test-doubles.md) | check |
| A scope verb's flags (`start`/`run`/`resume`) are declared once | architecture: `packages/hrc-cli/src/cli/scope-verb-options.ts`; `scope-verb-options.test.ts` | pre-commit (typecheck), verify |
| Delivery executors require an `AdmittedPlan` first; handlers cannot import executors or the plan constructor, or call legacy dispatch entries | `scripts/check-admission-entry.ts` (no baseline) | pre-commit, check |
| HRC source does not import ACP-owned packages | `scripts/check-boundaries.ts` | pre-commit, check |
| Member dependency specifiers match the root `overrides` pin table | `scripts/check-dependency-pins.ts` | pre-commit, check |
| Every bare import is declared in its manifest | `scripts/check-manifest-edges.ts` | pre-commit, check |
| No partial ASP set in bun.lock | `scripts/check-lock-coherence.ts`; `scripts/check-lock-hygiene.ts` | check, install; pre-commit/pre-push (hygiene) |
| `hrc` help/info match the live command registry | `scripts/check-cli-surface.ts` | pre-commit, check |
| Status-JSON paths named in docs exist in the formatter | `scripts/check-server-status-source-contract.ts` (its test) | verify |
| Public package exports change only with the baseline | `scripts/check-public-surface.ts` | pre-commit, check |
| A lint/type suppression carries `EXCEPTION(T-…)` | `scripts/check-suppressions.ts` | pre-commit, check |
| No credential-class key in an auto-loaded `.env*` | `scripts/check-env-hygiene.ts` | check |
| Test files stay under 1000 lines | `scripts/check-test-source-size.ts --enforce` | verify |
| Architecture records are well-formed and projections current | `scripts/check-architecture-records.ts` | pre-commit, pre-push |
| `just install` refuses tracked modifications | `scripts/install-dirty-guard.ts` | install |
| Only a canonical, pushed release is published | `scripts/publish-local-verdaccio.ts` containment proof | publish |
| A deploy target is contained by origin/main, ahead of the checkout, and reported back by the running process | `_deploy-node` (justfile) | deploy |
| Only authorized seats restart HRC | daemon refusal (T-09861) | runtime |

## Judgment

| Rule | Why no enforcer yet |
|---|---|
| A boundary-moving spec amends every record stating that boundary | `check-architecture-records` grades structure, not shared premises |
| A missing JSON key is not null; name the full path | operator method; `jq -e` tells absent from null |
| Grade a turn from `hrc_events`, not the start response | operator method |
| Snapshot `state.sqlite` with `VACUUM INTO`, never `cp` | operator method |
| Capture `git push`'s own exit status | operator method |
| Read `bun.lock`'s last commit before `just install` | `check-asp-skew --warn` is advisory by design |
| Fleet promotion only through `just deploy-*` | nothing refuses a hand promotion |
| Index every docs page in `docs/README.md` | no index-completeness check yet |
| Run package tests with `bun run test`, not bare `bun test` | bare `bun test` skips the hermetic runner, but refusing it would break ad-hoc runs (ruling R4, T-10226); revisit if a test writes the live ledger again |
| Run `just doctor` after any `bun install` | no recipe resolves dependencies, so nothing calls the sweep automatically |
