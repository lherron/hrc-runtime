# 🔧 Refactoring Analysis — packages/hrcchat-cli/src

**Target:** `packages/hrcchat-cli/src` · **Files read:** 21/21 source `.ts` (all non-test) · **Lines:** ~3,477 · **Package type:** leaf CLI (private, `bin: hrcchat`, no `index.ts`, no library consumers)

## 🧭 Summary
A well-factored Commander CLI with a clean command/helper split, injectable seams (timers, clients, `consulKvGet`, `readTaskState`), and a real test suite under `src/__tests__/`. The bulk of complexity lives in the `--stacked`/`--follow` aggregator pipeline. Findings are mostly small de-dup / cohesion repairs; the highest-value item is a **divergent duplicate `isTurnEnd`** whose two definitions disagree on which event kinds end a turn.

## 🚪 Public boundary (assess first)
The observable surface is the **CLI contract**: command names/aliases, flags, exit codes (0/1/2/3/4/5/130 documented on `TurnExitError`), the `turn_stacked` NDJSON schema (`stacked-types.ts`, field order load-bearing), the `render_frame` NDJSON schema, and the `DmHandoffEnvelope` JSON (consumed by `hrc monitor wait msg:<id>`). No package imports from this one — there is no JS/TS API consumer, so **M02 expand/contract does not apply**; only the CLI/NDJSON contracts must be preserved.

- **T07 (align interface to usage):** none warranted. Command-handler signatures `(client, opts, positionals)` are uniform and intentional.
- **M02:** N/A (leaf package, no importers).
- **Verdict:** 🟢 Boundary is healthy. All findings below are internal-only except where explicitly flagged.

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Divergent duplicate `isTurnEnd` (two definitions, different semantics)
- **Location:** `commands/turn.ts:395` and `stacked-aggregator.ts:448`
- **Technique:** T15 extract missing abstraction (the *correct* terminal-event predicate)
- **Mechanism repaired:** single source of truth for "what ends a turn" — currently two predicates silently disagree.
- **Symptom:** `turn.ts` returns true for `turn_end || turn.completed`; the aggregator returns true for `turn.completed` only. The watch loop in `turn.ts` (line 302) gates `enrichFinalEvent` on its own `isTurnEnd`, then hands the event to the aggregator whose `receive()` (line 142) re-checks with the *narrower* predicate. A `turn_end` event would be enriched by the caller but **not** treated as terminal by the aggregator.
- **Current → Suggested:** extract one `isTurnEndEvent` into `stacked-shared.ts` (or a new `event-kinds.ts`). **Direction note:** this is NOT a mechanical dedupe — the two bodies differ, so collapsing them is a *behavior decision*. Confirm via the live event stream which kinds the broker actually emits, then unify to the superset; that is why this is **deferred**, not auto-applied.
- **Direction:** consolidate (after confirming the union is correct).
- **Preservation:** test-suite (`stacked-aggregator.test.ts`, `turn.test.ts`) + observational (live broker event kinds).
- **Falsifiable signal:** a fixture emitting `turn_end` (not `turn.completed`) produces a single terminal `phase:final` stacked line and exit 0.
- **Risk:** Med · **API-impact:** internal-only (but affects observable terminal-frame timing) · **Effort:** S
- **Tests:** add a `turn_end`-kind fixture to the aggregator test asserting terminal flush.
- **Contraindication:** the narrower aggregator predicate may be deliberate if the broker never emits `turn_end` on the stacked path — verify before unifying.

### F2 — Duplicate `stringValue` helper (identical body, two files)
- **Location:** `stacked-shared.ts:30` and `domain-error-format.ts:70`
- **Technique:** T15 extract missing abstraction / collapse duplication
- **Mechanism repaired:** one canonical "non-empty string coercion".
- **Symptom:** byte-identical `stringValue(value: unknown): string | undefined` defined twice.
- **Current → Suggested:** import `stringValue` from `stacked-shared.ts` in `domain-error-format.ts`; delete the local copy.
- **Direction:** consolidate.
- **Preservation:** type/compiler-proof (identical signature) + test-suite (`domain-error-format.test.ts`).
- **Falsifiable signal:** `domain-error-format.test.ts` stays green after the import swap.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS
- **Tests:** existing.
- **Contraindication:** `stacked-shared`'s docstring frames it as "stacked" helpers; if you want to avoid coupling domain-error formatting to the stacked module, move `stringValue`/`isRecord` to a neutral `primitives.ts` instead. Either way the duplication goes. **Auto-applicable.**

### F3 — Misleading `await` on a synchronous function
- **Location:** `commands/summon.ts:20` (`await resolveRuntimeIntentForTarget(...)`)
- **Technique:** T23 remove middle man / collapse pass-through (here: remove the false async signal)
- **Mechanism repaired:** call-site honesty — `resolveRuntimeIntentForTarget` returns `HrcRuntimeIntent` (not a Promise; `resolve-intent.ts:109`). `turn.ts:122` and `dm.ts:42` correctly call it without `await`; only `summon.ts` awaits.
- **Symptom:** `await` on a non-thenable — harmless at runtime, but implies I/O that isn't there and invites a future reader to assume the function is async.
- **Current → Suggested:** drop the `await`.
- **Direction:** simplify.
- **Preservation:** type/compiler-proof (return type unchanged) + test-suite.
- **Falsifiable signal:** `summon` smoke test unchanged; `tsc` green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** XS
- **Tests:** existing smoke.
- **Contraindication:** none. **Auto-applicable.**

### F4 — Truncation logic duplicated with subtly different markers
- **Location:** `stacked-aggregator.ts:525` (`truncateFinalBody`, marker `...[truncated]`) and `stacked-summary.ts:238` (`truncateText`, marker `...[truncated]`) and `:224` (`boundString`, byte-bounded, marker `\n[truncated]`)
- **Technique:** T15 extract missing abstraction (a `truncate.ts` with char-cap + byte-cap variants)
- **Mechanism repaired:** one truncation policy module; today three near-copies drift independently.
- **Symptom:** three hand-rolled truncators across two files; the char-cap pair is nearly identical, the byte-cap differs by design.
- **Current → Suggested:** factor `truncateChars(s, cap, marker)` and `truncateBytes(s, cap)` into `stacked-shared.ts`. Keep the *exact existing markers* per call-site to preserve emitted strings (the NDJSON body is part of the contract).
- **Direction:** consolidate.
- **Preservation:** char-test (assert exact truncated output) — markers are observable in `turn_stacked` lines.
- **Falsifiable signal:** aggregator/summary tests asserting the truncated suffix stay byte-identical.
- **Risk:** Low · **API-impact:** internal-only (output bytes preserved) · **Effort:** S
- **Tests:** add an exact-suffix char-test before refactor.
- **Contraindication:** the differing markers are **load-bearing** (the byte-cap intentionally newline-prefixes). Do NOT unify the markers — only unify the mechanics. **Auto-applicable** if markers preserved.

### F5 — Repeated `aggregator.finish({phase, flush, exitCode, result, error?})` + `throw TurnExitError` blocks
- **Location:** `commands/turn.ts:323-332`, `:359-370`, `:372-381`, `:383-390`
- **Technique:** T19 conditional → dispatch (table of terminal outcomes) / T15
- **Mechanism repaired:** one terminal-outcome table mapping `(phase → exitCode, result, message)` instead of four hand-aligned `finish(...) ; throw` pairs where the `exitCode`/`result`/`message` triple must be kept consistent by hand.
- **Symptom:** four structurally identical "finalize the aggregator with this phase, then throw the matching exit error" blocks; e.g. `TURN_EXIT_RUNTIME_DEAD` is reused for both runtime-dead and turn-error with different `Result` values — easy to mis-pair.
- **Current → Suggested:** a `const TERMINALS: Record<TerminalKind, {phase, flush, exitCode, result, message}>` plus a single `await finalizeTurn(kind)` helper.
- **Direction:** consolidate / reify the implicit outcome machine.
- **Preservation:** test-suite (`turn.test.ts` exercises exit codes) — but coverage of all four arms should be confirmed first.
- **Falsifiable signal:** each terminal kind still yields its documented exit code and (stacked) emits its terminal frame once.
- **Risk:** Med · **API-impact:** internal-only (exit codes are the contract — must not shift) · **Effort:** M
- **Tests:** confirm `turn.test.ts` covers stall(1)/runtime-dead(4)/permission(5)/error; add missing arms before refactor.
- **Contraindication:** the arms are not *byte*-identical (different messages/results); a table must preserve every triple exactly. Because exit codes are the user-facing contract, this is **deferred** for a human to verify per-arm coverage. **Deferred.**

### F6 — `extractTaskId` / task-id parsing duplicated across modules
- **Location:** `stacked-aggregator.ts:521` (regex `/(?:^|:)T-\d+\b/`) vs `normalize.ts:15` (`inferTaskIdFromCallerSession`, `:task:<id>` segment scan)
- **Technique:** T03 relocate by affinity (task-id extraction belongs in one place)
- **Mechanism repaired:** cohesion — "how do we pull a task id out of a scope/sessionRef" lives in two grammars.
- **Symptom:** two different parsers for the same conceptual operation (one regex on a scope string, one `:`-split on a sessionRef). They accept different inputs by design but represent the same domain notion.
- **Current → Suggested:** keep both *call sites* but consider a shared `taskId.ts` exposing `taskIdFromScope` and `taskIdFromSessionRef`. Low urgency.
- **Direction:** consolidate (mild).
- **Preservation:** test-suite (`normalize.test.ts`, `stacked-aggregator.test.ts`).
- **Falsifiable signal:** both extraction tests green after relocation.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Tests:** existing.
- **Contraindication:** the two grammars genuinely differ (scope vs sessionRef shapes); merging into one regex would be **wrong**. This is relocation-only, not unification. Marginal value — **left mostly alone** (see below).

## 🪶 Deliberately left alone (where-NOT)
- **`stacked-types.ts` field order & `buildLine` spread order** — explicitly load-bearing (truncation-survival ordering, documented). Spread/projection must preserve the exact field set; do not "tidy".
- **Magic numbers** (`FINAL_BODY_CAP`, `TOOL_INPUT_CAP`, `DEFAULT_TERMINAL_WIDTH`, spinner frames, caps) — already named constants. No T15 needed.
- **Injectable seams** (`now`/`setTimeout`/`clearTimeout`, `createAnthropicClient`, `consulKvGet`, `readTaskState`, `summarizer`) — these are deliberate substitution seams (T01 already satisfied), exercised by tests. Not premature abstraction; **do not collapse**.
- **`levenshteinDistance` / suggestion engine in `main.ts`** — self-contained, tested via `did-you-mean` red test. Fine.
- **`redactSecrets` regex chain** (`stacked-shared.ts:11`) — parameterizing the literals would risk a biome `useValidTypeof`/regex lint and obscure each rule; the explicit list is the right shape.
- **Per-command `if (!target) throw CliUsageError` guards** — tiny, local, readable; a parameter object would add indirection without payoff.
- **`Summarizer` interface (one implementor)** — looks like a one-implementor interface (T16 candidate) but is a **deliberate test seam** (`createStackedSummarizer` is injected into the aggregator and stubbed in tests). Contraindication honored: keep it.

## 🔭 If applying: outside-in sequence
1. **F2** (dup `stringValue`) — XS, compiler-proof, zero behavior risk.
2. **F3** (drop false `await`) — XS, compiler-proof.
3. **F4** (truncation helpers, markers preserved) — add exact-suffix char-tests, then extract.
4. **F6** (relocate task-id parsers) — only if touching the files anyway.
5. **F1** (divergent `isTurnEnd`) — DEFERRED: confirm live broker event kinds first.
6. **F5** (terminal-outcome table) — DEFERRED: confirm per-arm exit-code coverage first.

## ✅ Safety checklist
- [ ] `bun test` green in `packages/hrcchat-cli` before and after each step.
- [ ] `tsc --noEmit` clean.
- [ ] F4: assert the exact truncated suffix bytes are unchanged (NDJSON contract).
- [ ] F1/F5: do NOT auto-apply — exit codes and terminal-frame timing are user-facing; verify against live broker event stream / per-arm tests.
- [ ] No change to `turn_stacked` / `render_frame` / `DmHandoffEnvelope` field sets or order.
- [ ] No new biome lint (watch redaction/regex parameterization).
