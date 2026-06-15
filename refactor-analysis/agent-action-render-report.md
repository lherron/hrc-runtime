# 🔧 Refactoring Analysis — packages/agent-action-render/src

**Target:** `packages/agent-action-render/src` · **Files read:** 9 source + 1 test (all) · **Lines:** 622 source · **Package type:** leaf rendering/formatting library (general profile, pure functions, no I/O, no concurrency)

## 🧭 Summary
A small, well-factored pure-formatting library. The recently-introduced `ToolPresenter` registry (`tool-presenters.ts`) is the live abstraction; `tool-formatters.ts` still carries two `@deprecated` derived maps (`TOOL_EMOJI`, `PRIMARY_ARG_KEY`) that have **zero external consumers** and are prime de-abstraction candidates. The main mechanism wins are: collapse the deprecated/derived emoji+arg maps, unify the three `⚙️` fallback-icon literals, and narrow the very wide public surface (35-line index re-exporting ~25 symbols where only 4 are consumed off-package).

## 🚪 Public boundary (assess first)

`index.ts` re-exports ~25 symbols. Off-package consumers (whole monorepo) import exactly **four**:
- `formatToolLine`, `formatNoticeLine`, `renderMarkdownBlock` ← `packages/hrcchat-cli/src/render-frame.ts`
- `admissionLabel` ← `packages/hrc-frame-render/src/hrc-event-adapter.ts`

Everything else (`TOOL_EMOJI`, `PRIMARY_ARG_KEY`, `DEFAULT_TOOL_EMOJI`, `getToolEmoji`, `extractToolPreview`, `resolveToolPresenter`, `getToolDisplayName`, `looksLikeShell`, `unwrapShell`, `PRESENTERS`, `DEFAULT_PRESENTER`, `ToolPresenter`, `PRIMARY_FIELD_BY_KIND`, `extractEventPreview`, `formatEventPreviewLine`, `getHrcEventIcon`, `NOTICE_ICON`, `admissionLabelFromResponse`, `MAX_LINE_CHARS`, `MAX_PREVIEW_CHARS`, `truncateText`, markdown types) is consumed only by the in-package test or by sibling modules within this package — i.e. effectively **internal-only despite being public**.

**T07 (narrow leaky interface):** the boundary is much wider than its real usage. Two exports are explicitly `@deprecated` with no remaining callers. Because this is a published package name (`agent-action-render`) consumed by two other packages, contracting the surface is technically a public-surface change → handled via M02 expand/contract and **DEFERRED** (a human should confirm no out-of-tree/Discord-gateway consumer before removing exports).

**Verdict: 🟡** — surface is healthy in shape but over-broad; the only concrete defects are the two dead `@deprecated` exports and a leaky `getToolEmoji` whose internal contract diverges from the presenter registry (see F1/F4).

## 🎯 Findings by mechanism (outside-in, highest impact first)

### F1 — Collapse the deprecated derived `TOOL_EMOJI` / `PRIMARY_ARG_KEY` maps and `getToolEmoji`
- **Location:** `tool-formatters.ts:5-24, 57-59` (and re-exports `index.ts:20-22`)
- **Mechanism repaired:** T16 collapse premature/duplicate abstraction — a second source of truth (`TOOL_EMOJI`) derived from `PRESENTERS` that only partially mirrors it.
- **Symptom:** `TOOL_EMOJI` and `PRIMARY_ARG_KEY` are `@deprecated`, built by flat-mapping the string-match presenters; `getToolEmoji` does `TOOL_EMOJI[toolName] ?? DEFAULT_TOOL_EMOJI`. This **silently diverges** from the registry: function-match presenters (`isShellLikeExecTool`, the `mcp:` regex) contribute no key, so `getToolEmoji('command_execution')` returns the default `⚙️` even though `resolveToolPresenter` would pick `💻` for a shell-like command. Two emoji-resolution paths with different answers.
- **Current → Suggested:** Internally, `getHrcEventIcon` (the only in-package caller of `getToolEmoji`) should resolve via `resolveToolPresenter(toolName, {}).emoji`; then delete `TOOL_EMOJI`, `PRIMARY_ARG_KEY`, `getToolEmoji`, `DEFAULT_TOOL_EMOJI` once external absence is confirmed.
- **Direction:** DE-abstraction (remove duplicated derived map).
- **Preservation:** test-suite — `getHrcEventIcon` is exercised in `formatters.test.ts:106-113,144-155`. **Caution:** swapping `getToolEmoji` for `resolveToolPresenter(...).emoji` is *not* behavior-preserving for the empty-input case (`tool_execution_start` with `toolName:'exec_command'` currently returns `💻` via the `exec_command` string presenter, which still holds — but any tool whose only match is function-based would change). Needs a characterization test added first (rung: char-test).
- **Falsifiable signal:** `getHrcEventIcon` test block stays green; `grep TOOL_EMOJI packages` returns nothing after removal.
- **Risk:** Med · **API-impact:** public-surface (exports removed) · **Effort:** M
- **Contraindication:** the `@deprecated` exports may be a deliberate one-release-deprecation window; removing them is a breaking change to the package surface. **DEFERRED.**

### F2 — Unify the three identical `⚙️` fallback-icon literals
- **Location:** `tool-presenters.ts:10` (`FALLBACK_TOOL_EMOJI`), `tool-formatters.ts:13` (`DEFAULT_TOOL_EMOJI`), `hrc-kind-icons.ts:3` (`DEFAULT_HRC_ICON`)
- **Mechanism repaired:** T15 extract missing abstraction — one semantic constant (“no-dedicated-icon fallback”) expressed as three separate literals.
- **Symptom:** Same `'⚙️'` glyph defined three times; a future change to the fallback glyph must be made in three files or they drift.
- **Current → Suggested:** Export a single `FALLBACK_ICON` from `budgets.ts` (or a new `icons.ts`) and reference it from all three. `DEFAULT_TOOL_EMOJI` and `DEFAULT_HRC_ICON` are public and can re-export it for compatibility.
- **Direction:** extract shared constant (mild RE-abstraction).
- **Preservation:** type/compiler-proof — identical literal value, pure reference swap; `formatters.test.ts:153-154` asserts `⚙️` for unknown kinds.
- **Falsifiable signal:** single literal definition; tests green.
- **Risk:** Low · **API-impact:** internal-only (if public consts keep re-exporting) · **Effort:** S
- **Tests:** existing `getHrcEventIcon` unknown-kind asserts.
- **Contraindication:** the three may be *intentionally* independent (tool fallback vs event fallback could diverge later). Low confidence this is load-bearing — they have always been equal — but worth a one-line comment if kept separate. **AUTO-APPLICABLE.**

### F3 — Notice-icon table duplicated between `notice-formatters.ts` and `hrc-kind-icons.ts`
- **Location:** `notice-formatters.ts:3-7` (`NOTICE_ICON` map) vs `hrc-kind-icons.ts:35-39` (inline `if level==='warn'…'error'…else info` branch)
- **Mechanism repaired:** T15 extract missing abstraction / single source of truth for notice level → icon.
- **Symptom:** Two encodings of `{warn:⚠️, error:❌, info/default:ℹ️}`. Adding a level (e.g. `debug`) requires editing both; drift is silently possible.
- **Current → Suggested:** Have `getHrcEventIcon`’s notice branch consult `NOTICE_ICON[level] ?? NOTICE_ICON.info`. Behavior identical for the three known levels.
- **Direction:** dedupe (RE-abstraction onto the existing `NOTICE_ICON` map).
- **Preservation:** test-suite — `formatters.test.ts:150-152` covers warn/error/default notice icons through `getHrcEventIcon`; `100-103` covers `formatNoticeLine`.
- **Falsifiable signal:** one notice-icon table; both notice tests green.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** S
- **Contraindication:** `getHrcEventIcon` currently does not import `notice-formatters`; introducing the import creates a new intra-package edge (acyclic, harmless). **AUTO-APPLICABLE.**

### F4 — `getToolEmoji` is a leaky internal seam (covered by F1)
- **Location:** `tool-formatters.ts:57-59`, called from `hrc-kind-icons.ts:33`
- **Mechanism repaired:** T07 align interface to usage — its sole in-package caller wants “icon for a tool name,” which the presenter registry already answers more correctly.
- **Symptom:** see F1 divergence. Listed separately to record that even if F1’s public removal is deferred, the *internal* call site in `hrc-kind-icons.ts:33` can be pointed at `resolveToolPresenter(name,{}).emoji` independently.
- **Direction:** redirect internal call to the canonical resolver.
- **Preservation:** char-test — add a test pinning `getHrcEventIcon('tool_execution_start',{toolName})` for each presenter family BEFORE switching, since empty-`{}` resolution can change shell-like results. **This is a behavior risk, not a pure refactor** for function-match tools.
- **Falsifiable signal:** new char-tests stay green across the swap.
- **Risk:** Med · **API-impact:** internal-only (the call site) · **Effort:** M
- **Contraindication:** behavior-divergence risk for function-matched tools; do F1 char-tests first. **DEFERRED** (paired with F1; not auto-applied because it is not provably behavior-preserving without the new characterization tests).

### F5 — `admissionLabelFromResponse` branch chain → table-driven (optional, low value)
- **Location:** `admission-labels.ts:78-122`
- **Mechanism repaired:** T19 conditional → dispatch.
- **Symptom:** 5 sequential `if` blocks mapping (admissionKind, applicationStatus, reason) → eventKind. Readable but additive growth means more branches.
- **Current → Suggested:** a small ordered rule list `[{when:(k,s,r)=>…, eventKind, reason?}]`. **Honest direction note:** this is borderline — current form is already clear and only 5 cases; converting to a rule table is lateral, not a clear win.
- **Direction:** lateral (conditional→dispatch).
- **Preservation:** test-suite — `formatters.test.ts:191-223` covers every branch incl. precedence (ambiguous before reason before queued) and the empty-string fallback.
- **Falsifiable signal:** branch tests green; precedence preserved.
- **Risk:** Low · **API-impact:** internal-only · **Effort:** M
- **Contraindication:** the explicit `if` ordering *is* the precedence spec and is easy to read; a rule table can obscure precedence. **Left alone** — flagged for completeness only, not recommended.

## 🪶 Deliberately left alone (where-NOT)

- **`budgets.ts` / `truncateText`** — minimal, total, well-tested. No magic numbers worth extracting beyond the named `MAX_LINE_CHARS`/`MAX_PREVIEW_CHARS` constants that already exist.
- **`PRESENTERS` registry (`tool-presenters.ts:73-179`)** — the live, correct abstraction. The mixed `match` union (string | RegExp | predicate) is justified by real variation (string tools, `mcp:` regex, shell-detection predicate). Do **not** collapse it; the variation is materialized. The repeated `primaryString('x')` presenter objects are data, not duplication.
- **`event-previews.ts` `PRIMARY_FIELD_BY_KIND`** — data table of per-kind extractors; appropriate dispatch, no smell.
- **`markdown-block.ts` `wrapLine`** — nesting is ≤3 and the logic is intrinsic word-wrap; flattening would not help. `MIN_BLOCK_WIDTH=20` is already a named constant.
- **`hrc-kind-icons.ts` `ICON_BY_EVENT_KIND` + `TOOL_KEYED_EVENT_KINDS`** — clean data-driven dispatch; the `message_` prefix special-case is intentional.
- **Public re-export shape of the 4 consumed symbols** — correct; do not touch.

## 🔭 If applying: outside-in sequence
1. **F2** (unify `⚙️` fallback literal) — Low risk, pure reference swap, run package tests.
2. **F3** (dedupe notice-icon table via `NOTICE_ICON`) — Low risk, tests cover all levels.
3. *(Deferred, human-gated):* F1+F4 together — first add characterization tests for `getHrcEventIcon` across presenter families, then redirect the internal `getToolEmoji` call site, then (after confirming no off-tree consumers) remove the `@deprecated` `TOOL_EMOJI`/`PRIMARY_ARG_KEY`/`getToolEmoji`/`DEFAULT_TOOL_EMOJI` exports via M02 expand/contract.
4. F5 — not recommended.

## ✅ Safety checklist
- [x] Public boundary assessed before internals; the 4 off-package symbols identified and protected.
- [x] Every finding names the repaired mechanism, not just the smell.
- [x] Smells re-verified against source (the `⚙️`×3 and notice-table×2 duplications confirmed live; `TOOL_EMOJI` divergence confirmed via match-type analysis).
- [x] Direction marked honestly (F1 is DE-abstraction/removal; F5 lateral and declined).
- [x] Behavior-preservation rung stated; F1/F4 flagged as NOT provably preserving without new char-tests → deferred.
- [x] No biome `useValidTypeof`-style literal-parameterization risk introduced (no `typeof` dedup proposed).
- [x] Auto-applicable set restricted to Low/Med + internal-only + behavior-preserving (F2, F3 only).
