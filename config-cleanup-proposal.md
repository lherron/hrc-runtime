# Agent provisioning config cleanup — proposal

Status: **draft for review** (clod, 2026-09-17). Not submitted to Daedalus. No code
changed. Lance to review with mable.

## 1. What started this

Two Codex seats in `hrc-runtime`, both DM'd from a `clod@hrc-runtime:primary`
session, came up on different surfaces:

- **cody@hrc-runtime:primary** — Codex's own TUI in a tmux pane.
- **candice@hrc-runtime:primary** — headless Codex app-server, watched through the
  broker-renderer viewer.

Their agent profiles do not differ in any way that explains it
(`var/agents/cody/agent-profile.toml`, `var/agents/candice/agent-profile.toml`):

```toml
[provisioning]
harness = "codex"
model = "gpt-5.6-sol"
reasoning = "medium"   # candice: "high"
yolo = true
```

Nothing else in `var/agents/<agent>/` (context templates, `var/`) selects a
surface either.

## 2. What actually decides the surface (observed, 2026-09-17)

### 2.1 Evidence

`hrc runtime inspect` on the two live runtimes:

| | cody `rt-c334e829…` | candice `rt-0c7eabc2…` |
| --- | --- | --- |
| `hrc.transport` | `tmux` | `headless` |
| broker driver | `codex-app-server` | `codex-app-server` |
| route | `interactive-codex-tui` | `headless-codex-app-server` |
| `presentation.kind` | `tmux-tui` | `tmux-tui` |
| generation | 43 | 1 |

Note both runtimes carry broker driver `codex-app-server` and the same recorded
harness (`codex-cli`). **Only transport/route differ.**

The saved session intents differed
(`var/state/hrc/state.sqlite`, `sessions.last_applied_intent_json`):

| session | `harness.interactive` | `execution.preferredMode` |
| --- | --- | --- |
| cody `hsid-e7092aa6…` (gen 43) | `true` | `interactive` |
| candice `hsid-11b1e019…` (gen 1) | `false` | `nonInteractive` |

### 2.2 The mechanism

1. A message/summons carries no runtime intent of its own, so HRC falls back to
   the session's saved intent:
   `body.runtimeIntent ?? session.lastAppliedIntentJson`
   (`packages/hrc-server/src/turn-dispatch-handlers.ts:970,1055`,
   `target-message-handlers.ts:1059,1691`).
2. A new session generation copies the previous generation's intent forward
   (`packages/hrc-server/src/session-successor.ts:29`). That is why cody stayed
   interactive across 43 generations and several `/quit`s.
3. When the intent is "omitted choice" (non-interactive openai codex-cli, no
   operator-presentation request — `isOmittedChoiceCodexRequest`,
   `packages/hrc-server/src/presentation-operator.ts`), the node flag decides:
   - `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=1` → redirect to the interactive Codex TUI;
   - `=0` → `decideRedirectOffCodexRoute`: an established **tmux** runtime selects
     interactive, otherwise headless.
   On max3 today the plist has `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=0` and
   `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION=tmux-tui` (hence the renderer).
   hrcdev has the flag at `1`.
4. Terminated runtimes do not count as "established"
   (`findEstablishedBrokerRuntime` filters failed/unavailable, and cody's prior
   runtimes were all terminated before the new births), so in practice the saved
   intent is what carried cody's TUI forward.

### 2.3 Which commands write which intent

- `hrc start <scope>` → **always headless**: `buildManagedStartIntent`
  (`packages/hrc-cli/src/cli/scope.ts:405`) sets `interactive: false`,
  `preferredMode: 'headless'`. `--no-viewer` adds `presentation.operator='none'`;
  `--app-server-viewer` adds `'tmux-tui'`.
- `hrc run` / `hrc attach` → **interactive**: `buildManagedRunIntent` /
  `buildManagedAttachIntent` set `interactive: true`,
  `preferredMode: 'interactive'`.
- Messages/summons → no intent; reuse the saved one.

**Verified live during the investigation:** `hrc start candice… -p ping` produced a
headless runtime and rewrote her saved intent to `headless` (new session
`hsid-79ef35ae…`, gen 2). `hrc run candice… --force-restart` then produced
`rt-578956b3…` with `transport: tmux`, saved intent `interactive`, and a
subsequent DM was answered from the TUI.

### 2.4 The defect this exposes

The surface is **implicit, order-dependent, and invisible in config**: it is a
side effect of whichever command last started the agent, carried forward through
session generations. Two identically configured agents end up on different
surfaces; a later `hrc start` silently flips an agent back.

## 3. Current schema (facts)

### 3.1 `[provisioning]` scalars

Source of truth: `agent-spaces/contracts/agent-scope/src/provisioning.ts`
(`PROVISIONING_SCALAR_KINDS`). Keys: `harness`, `model`, `reasoning`, `node`,
`yolo` (bool), `sandbox`, `approval`, `remote` (bool), `viewer`.
Profile-only nested tables: `provisioning.claude`, `provisioning.codex`, plus
`default_scope_role`.

Membership is a **deny-list** for per-summon overrides
(`DENIED_PROVISION_OVERRIDE_KEYS = ['yolo','sandbox']`); every other scalar is
overridable via a `+key=value` directive. Adding a key to the kinds table makes it
valid in `agent-profile.toml`, in `asp-targets.toml`, and as a directive.

### 3.2 `viewer` today

Declared as a free-form string. HRC reads exactly one value:
`viewer === 'none'` suppresses the viewer pane
(`packages/hrc-server/src/presentation-publish.ts:64,94`, fed from
`session.lastAppliedIntentJson.provision.viewer`). It does **not** select a route.

### 3.3 `harness` values

`agent-spaces/core/config/src/core/types/harness.ts` — 5 canonical ids, 9 accepted
strings:

| id | aliases | provider | transport | frontend |
| --- | --- | --- | --- | --- |
| `claude` (default) | `claude-code` | anthropic | cli | `claude-code` |
| `claude-agent-sdk` | `agent-sdk` | anthropic | sdk | `agent-sdk` |
| `pi` | `pi-cli` | openai | cli | `pi-cli` |
| `pi-sdk` | — | openai | sdk | `pi-sdk` |
| `codex` | `codex-cli` | openai | cli | `codex-cli` |

Validated in `core/config/src/core/config/agent-profile-toml.ts:252` via
`resolveHarnessCatalogEntry`. **No value distinguishes the Codex TUI from the
Codex app-server.** `HarnessId` also drives `isHarnessSupported` (space `supports`)
and lock generation (`LOCK_HARNESSES`), so the enum is not free to grow.

### 3.4 HRC broker drivers / routes

Drivers: `codex-app-server`, `codex-cli-tmux` (deprecated, fenced —
`aspd-headless-start.ts:114`, T-08562), `claude-code-tmux`, `pi-tui-tmux`,
`pi-sdk`, plus first-party `agent-harness` / `agent-harness-tmux`.

Routes (`aspd-headless-start.ts`): `headless-codex-app-server`,
`interactive-codex-tui`, `interactive-tmux-broker`. Hosting presentations:
`none | tmux-tui | codex-tui | interactive-tui`.

Key fact: **the Codex TUI route is "codex-app-server + codexTui"**
(`aspd-headless-start.ts:16`) — the TUI attaches to a broker-owned app-server. The
deprecated `codex-cli-tmux` is the embedded case (plain `codex`, app-server
in-process).

### 3.5 agent-harness (first-party)

`agent-spaces/architecture/records/invariants/agent-spaces.agent-harness-runtime-boundary.yaml`
and `harness/agent-harness/src/*`:

- Runs a Pi `AgentSessionRuntime` via `agent-harness-runtime`, ASP resources loaded
  directly (no compiled harness bundle).
- Three surfaces from one `createAgentHarnessRuntime` factory: local foreground
  TUI/print (`asp run`); HRC headless broker service (driver `agent-harness`,
  `harness/agent-harness/src/broker/driver.ts:8`); HRC-launched interactive TUI in a
  broker-leased tmux pane (driver `agent-harness-tmux`).
- The TUI surface is **fresh and HRC-owned and does not attach** to the headless
  session; the broker drives it over `agent-harness-control/v1`.
- `agent-harness` is **not** in `HARNESS_IDS`, so `harness = "agent-harness"` fails
  profile validation today. The admission matrix notes `agent-harness-tmux` has no
  compiler route. **Unverified:** how a seat selects it today (T-08563's
  "runtime-declaration-authority" is the likely path).

## 4. Proposal

Make the surface declarative in `[provisioning]`, with two orthogonal keys:

```toml
[provisioning]
harness     = "codex"
launch_mode = "service"        # | "standalone"
viewer      = "tui"            # | "broker-renderer" | "none"
```

- **`launch_mode`** — who owns the agent process.
  - `service`: a broker-owned headless runtime (Codex app-server, agent-harness
    broker service, SDK drivers). A viewer may attach.
  - `standalone`: the TUI process owns the session (Claude Code tmux, Pi tmux,
    agent-harness-tmux, embedded `codex`).
- **`viewer`** — what the operator sees. Reuses the existing key and keeps `none`'s
  current meaning, so the change is backward compatible.
  - `tui`: the harness's terminal UI.
  - `broker-renderer`: HRC's renderer viewer (internally `tmux-tui`).
  - `none`: headless, no viewer.
- Absent keys → per-harness default / node default, so existing profiles are
  unchanged.

Naming notes: snake_case matches `permission_mode`/`sandbox_mode`;
`broker-renderer` instead of the internal `tmux-tui` (which is not a TUI and is the
main source of confusion); `launch_mode = tui` avoided because it collides with
`viewer = tui`.

### 4.1 Validity matrix (refuse anything off it)

| harness | `launch_mode` | driver | valid `viewer` |
| --- | --- | --- | --- |
| `codex` | `service` | `codex-app-server` | `tui` (attached), `broker-renderer`, `none` |
| `codex` | `standalone` | `codex-cli-tmux` (deprecated/fenced) | `tui` |
| `agent-harness` | `service` | `agent-harness` | `broker-renderer`, `none` |
| `agent-harness` | `standalone` | `agent-harness-tmux` | `tui` |
| `claude` | `standalone` | `claude-code-tmux` | `tui` |
| `pi` | `standalone` | `pi-tui-tmux` | `tui` |
| `claude-agent-sdk`, `pi-sdk` | `service` | sdk drivers | `broker-renderer`, `none` |

`viewer = "tui"` under `service` is a **per-harness capability**, not a general
rule: only Codex has a TUI that attaches to its service. Invalid combinations are
refused at profile load (or at birth) with a named error, never silently
downgraded.

### 4.2 Where it gets implemented

**ASP (agent-spaces) — small:**
- Add `launch_mode` to `PROVISIONING_SCALAR_KINDS`
  (`contracts/agent-scope/src/provisioning.ts`); constrain `viewer`/`launch_mode`
  values in `core/config/src/core/config/agent-profile-toml.ts` (same shape as the
  existing `sandbox_mode`/`node` semantic checks).
- Decide whether `agent-harness` joins `HARNESS_IDS` (see open question 4).
- Release via publish-dev + pull-deps + install.

**HRC — the real work:**
- Transport into intent already exists: `resolveAgentHarness`
  (`packages/hrc-core/src/runtime-intent-assembly.ts:118`) merges profile with the
  project target and copies every provisioning scalar into `intent.provision`
  (`packages/hrc-cli/src/cli/scope.ts:388`). That is how `provision.viewer` reaches
  the server today.
- Consume it in the route decision:
  - message dispatch redirect branch, `turn-dispatch-handlers.ts:~1850`
    (`codexRedirect` / `classifyRedirectOffCodexDispatch`);
  - `decideRedirectOffCodexRoute` and `isOmittedChoiceCodexRequest`
    (`presentation-operator.ts`);
  - `buildManagedStartIntent` (`hrc-cli/src/cli/scope.ts:405`), which today hardcodes
    headless;
  - the aspd route/presentation decision (`aspd-headless-start.ts`).

### 4.3 Semantics the spec must settle

1. **Read timing.** `intent.provision` is a snapshot written when a command last
   wrote the intent; a profile edit does nothing until something rewrites it —
   exactly the defect in §2.4. For a declarative key, HRC should re-resolve the
   profile at each new runtime, as `parsers/runtime-harness-resolver.ts` already does
   for `harness`.
2. **Precedence.** Proposed: explicit per-request choice (`hrc run`, `--no-viewer`,
   `--app-server-viewer`, response-schema requests) > profile keys > saved intent >
   node default (`HRC_CODEX_CLI_TMUX_BROKER_ENABLED`,
   `HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION`).
3. **Mismatch with a live runtime.** If a DM arrives for a seat whose live runtime
   contradicts the profile, HRC must replace it or refuse — today's rules refuse
   rather than run a second writer on one seat
   (`established_runtime_harness_mismatch`).

## 5. Open questions for review

1. **Split `harness` instead?** Alternative considered and not recommended:
   `harness = "codex-app-server" | "codex-cli-tui"`. It names a hosting decision
   inside an enum that also drives space `supports` and lock generation, and it
   doubles entries for every harness. The two-key form matches the code (one Codex
   harness, several routes).
2. **SDK harness ids are redundant under this model.** `claude-agent-sdk` and
   `pi-sdk` are "the same harness, run as a service." Folding them into
   `harness` + `launch_mode` is a separate migration (touches `isHarnessSupported`,
   `LOCK_HARNESSES`).
3. **Does `codex` + `standalone` stay expressible?** HRC fences `codex-cli-tmux` as
   deprecated. Recommendation: accept the value in schema, refuse at birth with a
   deprecation error, rather than pretend the configuration does not exist.
4. **agent-harness selection path.** Must be traced before writing the task: it is
   absent from `HARNESS_IDS` yet has two live drivers. Either it joins the enum or
   the spec states how its declaration path composes with these keys.
5. **Scope of the ledger change.** ASP contract + HRC routing means a spec through
   Daedalus before implementation.

## 6. Current node settings (for reference)

`com.praesidium.hrc-server` (max3): `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=0`,
`HRC_HEADLESS_CODEX_BROKER_ENABLED=1`,
`HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION=tmux-tui`,
`HRC_ASPD_SOCKET=…/var/aspd/run/aspd.sock`.
`com.praesidium.hrc-dev`: `HRC_CODEX_CLI_TMUX_BROKER_ENABLED=1`.

Plist env changes need bootout + bootstrap; `launchctl kickstart` does not re-read
the plist.
