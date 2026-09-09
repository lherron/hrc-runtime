# codex vs claude execution paths in `hrc run`

Observed 2026-09-09 while fixing `hrc run --dry-run` prompt rendering
(`4eb0c388`, `903e7de8`, `6e7a1004`). Everything below was read off a live
compile or a real CLI run; inferences are labelled as such.

Reference specimens:

| | agent | scope | driver | interaction |
| --- | --- | --- | --- | --- |
| claude | `clod` | `clod@hrc-runtime:dryrun` | `claude-code-tmux` | `interactive` |
| codex | `astra` | `astra@arris:primary` | `codex-app-server` | `interactive` |

Both are `controllerKind: harness-broker` and both report
`resource: runtime-owned broker tmux lease socket`. The controller is the same;
everything about how the agent's *prompt* reaches the process is different.

---

## 1. The system prompt does not travel the same way

This is the difference that matters, and the one that produced the bug.

**claude — inline in argv, plus a content-addressed file.**

```
claude ... --append-system-prompt '<15,523 chars>' ... -- 'You are clod ...'
```

`spec.launch` carries both `systemPromptFile` and `systemPromptMode`. Verified
on a live compile: the file's bytes and the `--append-system-prompt` value are
identical (`file chars: 15523  argv chars: 15523  identical: true`). The file
lives at a content-addressed path under the materialized bundle:

```
.../clod/claude/.asp-runtime-artifacts/system-prompts/48/489cf24…/system-prompt.md
```

The flag is mode-dependent (`drivers/harness-claude/src/claude/invoke.ts:188`):
`append` mode emits `--append-system-prompt`, `replace` mode emits
`--system-prompt`. A test agent with only a `SOUL.md` resolves to the built-in
template and therefore `replace`; a real agent with a context template resolves
to `append`. **Both flags must be handled** — reading only one silently misses
half the claude agents.

**codex — nothing in argv; written into `$CODEX_HOME/AGENTS.md`.**

```
codex --enable goals '<priming 351 chars>' --no-alt-screen --model gpt-6-astra \
  -c 'model_reasoning_effort="medium"' --ask-for-approval never \
  --sandbox danger-full-access --dangerously-bypass-hook-trust
```

No `--append-system-prompt`, no `--system-prompt`, and `spec.launch`
carries **no `systemPromptFile`**. Instead the prompt is written into the
runtime codex home as a delimited block
(`drivers/harness-codex/src/adapters/codex-agents.ts`):

```
<!-- BEGIN praesidium-context -->
…system prompt…

…session reminder…
<!-- END praesidium-context -->
```

codex loads that file as `config.user_instructions`. Verified on disk for astra:
`codex-homes/arris_astra/AGENTS.md`, 33,814 bytes, block at lines 3–225, and the
resolved system prompt appears **verbatim** inside it (first 22,122 characters
byte-identical). The reminder portion differs only because it carries
time-varying content — ready promises and agent memory — that changed between
the file being written and the comparison.

Note the block is system prompt **and** reminder concatenated. On the codex path
the reminder is not a separate runtime injection at all.

### Why this broke `--dry-run`

A preview that sourced the prompt from the compiled spec — argv flag or
`systemPromptFile` — worked on claude and rendered *nothing* on codex, because
codex has neither. The absence looked exactly like an agent that legitimately
has no prompt. The fix resolves prompt zones with `inspectAgentSystemPrompt`
(the resolver `asp run` uses), keyed off the compiled `lockedEnv`, which is
route-independent.

---

## 2. The priming prompt arrives by different doors

| | where it lives | argv shape |
| --- | --- | --- |
| claude | `spec.launch.initialPrompt` | after a `--` separator |
| codex | invocation's initial user turn (`startRequest.initialInput.content[].text`) | bare positional, **no `--`** |

Observed for clod: `initialInput: no`, `launchInitialPromptLength: 83`.
Observed for astra: `initialInput: yes`, and `launch.initialPrompt` absent —
which is why the pre-fix preview printed `initialPrompt: (none)` for an agent
that plainly had one.

codex builds it as a positional (`codex [prompt]`,
`drivers/harness-codex/src/adapters/codex-adapter.ts:324`). Consequence for any
display code: `formatDisplayCommand` elides long args **only past `--`**, so a
codex priming prompt prints in full on the command line while a claude one is
elided to `'<N chars>'`.

---

## 3. Environment

Both get the `ASP_*` family. The route-specific entries:

| var | claude | codex |
| --- | --- | --- |
| `CODEX_HOME` | absent | **present** — the AGENTS.md delivery target |
| `ASP_PRIMING_PROMPT` | present | absent |

`spec.process.env` is empty on both; the real environment is
`spec.process.lockedEnv`. `dispatchEnv` was `undefined` in preview compiles.

---

## 4. Route selection is asymmetric in HRC

`buildBrokerRunPreview` runs a **claude-only** normalization first:

```ts
const previewIntent = shouldRedirectClaudeToInteractiveBroker(intent)
  ? normalizeClaudeInteractiveBrokerIntent(intent)
  : intent
```

`shouldRedirectClaudeToInteractiveBroker` matches `claude-code`,
`claude-code-cli`, `agent-sdk`, `pi-sdk` (`broker-decisions.ts:708`). There is no
codex equivalent — codex intents reach the branch predicates unmodified.

A further asymmetry worth knowing when writing tests: **the same command routes
differently per harness.** With the shared test fixture,

- `hrc start` + codex profile → broker branch, `driver: codex-app-server`
- `hrc run` + codex profile → **spec-build fallback**, not the broker branch

The spec-build branch already rendered prompts, so a codex test written against
`hrc run` passes without exercising the broker path at all. My first regression
test did exactly that and was vacuous. Pin the route explicitly (assert
`driver:`, `brokerPlan:   available`, and the branch's own note text).

---

## 5. Interaction and transport

`interaction` is not implied by the harness:

- astra, `hrc run`, codex → `codex-app-server` / `interactive`
- rex fixture, `hrc start`, codex → `codex-app-server` / `headless`

`shouldUseHeadlessTransport` keys off `intent.execution.preferredMode`
(`headless` or `nonInteractive`), not the provider (`broker-decisions.ts:663`).
Both routes reported `inputQueue: fifo` and `interrupt: optional`.

---

## 6. Toolchain trap

The repo's `node_modules/agent-spaces` rejected astra's model outright:

```
compiler_exception: Model not supported for frontend codex-cli: gpt-6-astra
```

while the installed release compiled it fine. A source-tree probe of a codex
agent can therefore fail admission for reasons that have nothing to do with the
code under test, and `buildBrokerRunPreview` returns `undefined` on
`!compiled.admitted` — i.e. **an unadmitted compile is indistinguishable from
"this route has no broker plan."** Validate codex routes against the installed
binary, or read the diagnostics rather than the return value.

---

## Summary

| | claude | codex |
| --- | --- | --- |
| driver | `claude-code-tmux` | `codex-app-server` |
| system prompt | argv `--append-system-prompt` / `--system-prompt` + `systemPromptFile` | `$CODEX_HOME/AGENTS.md` praesidium-context block |
| reminder | separate (SessionStart hook) | same AGENTS.md block as the prompt |
| priming | `launch.initialPrompt`, after `--` | initial user turn, bare positional |
| `initialInput` | `no` | `yes` |
| distinctive env | `ASP_PRIMING_PROMPT` | `CODEX_HOME` |
| HRC pre-normalization | yes | none |

**The generalisable point:** on the claude path the prompt is *in the launch
command*; on the codex path it is *in the filesystem the command will read*.
Any tool that inspects, previews, diffs or verifies an agent's prompt must
source it from the resolver, not from the compiled invocation — otherwise it is
correct on one route and silently empty on the other.
