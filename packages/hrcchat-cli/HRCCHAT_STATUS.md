# hrcchat-cli Implementation Status

**Date:** 2026-04-15
**Spec:** HRCCHAT_SPEC.md (root)
**Package:** packages/hrcchat-cli
**Commit:** ca3d8ef (+ uncommitted dryRun fix and logging)

## What was built

### Layer 1: hrc-core contracts (`packages/hrc-core/src/hrcchat-contracts.ts`)
- `HrcMessageAddress` (session | entity)
- `HrcTargetView`, `HrcTargetState`, `TargetCapabilityView`, `HrcTargetRuntimeView`
- `HrcMessageRecord`, `HrcMessageKind`, `HrcMessagePhase`, `HrcMessageExecution`
- `HrcMessageFilter` with participant/from/to/thread/afterSeq/kinds/phases/limit
- All HTTP DTOs: `EnsureTargetRequest/Response`, `DispatchTurnBySelectorRequest/Response`, `DeliverLiteralBySelectorRequest/Response`, `CaptureBySelectorRequest/Response`, `CreateMessageRequest/Response`, `ListMessagesRequest/Response`, `WatchMessagesRequest`, `WaitMessageRequest/Response`, `SemanticDmRequest/Response`
- Exported from `packages/hrc-core/src/index.ts`

### Layer 2: hrc-store-sqlite (`packages/hrc-store-sqlite`)
- Migration `0007_hrcchat_messages` in `src/migrations.ts` — messages table + 6 indexes
- `MessageRepository` in `src/message-repository.ts`:
  - `insert(input)` -> `HrcMessageRecord` (auto self-roots when no rootMessageId)
  - `getById(messageId)` / `getBySeq(seq)`
  - `query(filter: HrcMessageFilter)` — full filter support
  - `maxSeq()` — for cursor-based watch
  - `updateExecution(messageId, patch)`
- `sessions.updateParsedScope()` added to `src/repositories.ts`
- Wired into `HrcDatabase.messages` in `src/database.ts`
- 12 passing unit tests in `src/__tests__/store.messages.test.ts`

### Layer 3: hrc-server routes (`packages/hrc-server/src/index.ts`)

All 11 routes implemented:

| Route | Handler | Status |
|-------|---------|--------|
| `GET /v1/targets` | `handleListTargets` | working |
| `GET /v1/targets/by-session-ref` | `handleGetTarget` | working |
| `POST /v1/targets/ensure` | `handleEnsureTarget` | working |
| `POST /v1/turns/by-selector` | `handleDispatchTurnBySelector` | working (dry-run only, see blockers) |
| `POST /v1/literal-input/by-selector` | `handleLiteralInputBySelector` | working |
| `POST /v1/capture/by-selector` | `handleCaptureBySelector` | working |
| `POST /v1/messages` | `handleCreateMessage` | working |
| `POST /v1/messages/query` | `handleQueryMessages` | working |
| `POST /v1/messages/dm` | `handleSemanticDm` | working (dry-run only, see blockers) |
| `POST /v1/messages/wait` | `handleWaitMessage` | working |
| `POST /v1/messages/watch` | `handleWatchMessages` | working |

Server infrastructure added:
- `messageSubscribers` Set + `notifyMessageSubscribers()` for watch/wait wake-up
- `insertAndNotifyMessage()` centralized append-then-notify helper (spec: durable append before publish)
- `matchesMessageFilter()` for in-memory subscriber filtering
- Buffered subscriber pattern in watch/wait (mirrors `handleEvents` replay/high-water to avoid race)

Enhanced `handleSemanticDm`:
- Parses full `SemanticDmRequest` (respondTo, runtimeIntent, createIfMissing, parsedScopeJson, wait)
- Auto-summons discoverable targets when runtimeIntent is provided
- Dispatches semantic turn and creates automatic reply from finalOutput
- Updates request record execution fields via `updateExecution()`
- Supports `--wait` with server-side blocking
- Propagates actual turn status from dispatch (not hardcoded)

### Layer 4: hrc-sdk client methods (`packages/hrc-sdk/src/client.ts`)
11 new typed methods on `HrcClient`:
- `listTargets()`, `getTarget()`, `ensureTarget()`
- `dispatchTurnBySelector()`, `deliverLiteralBySelector()`, `captureBySelector()`
- `createMessage()`, `listMessages()`, `waitMessage()`, `semanticDm()`
- `watchMessages()` (async generator, NDJSON)

### Layer 5: hrcchat-cli package (`packages/hrcchat-cli`)
- `src/main.ts` — CLI entrypoint with command dispatch
- `src/cli-args.ts` — flag/arg parsing, duration parsing, body consumption
- `src/normalize.ts` — address resolution (human/system/me/target -> HrcMessageAddress)
- `src/resolve-intent.ts` — runtime intent resolution from agent profiles
- 10 command modules in `src/commands/`:
  - `who.ts`, `summon.ts`, `dm.ts`, `send.ts`, `messages.ts`
  - `watch.ts`, `wait.ts`, `peek.ts`, `status.ts`, `doctor.ts`
- `dm.ts` resolves and sends `runtimeIntent` for session targets (enables auto-summon)
- Added to workspace build order in root `package.json`
- Added to justfile install recipe (`bun link`)

## E2E test results (2026-04-15)

| Command | Status | Notes |
|---------|--------|-------|
| `hrcchat who` | **working** | Shows all targets with state/capabilities |
| `hrcchat summon <target>` | **working** | Idempotent, persists intent + parsedScopeJson |
| `hrcchat dm <target> <msg>` | **partial** | Durable message stored; turn dispatch fails (see blocker 1) |
| `hrcchat dm human <msg>` | **working** | Stores durable oneway message |
| `hrcchat send <target> <msg>` | **working** | Live tmux literal injection; correct `runtime_unavailable` for dormant |
| `hrcchat peek <target>` | **working** | Captures live output; correct `runtime_unavailable` for dormant |
| `hrcchat messages` | **working** | Query with all filters, human + JSON output |
| `hrcchat watch` | **working** | NDJSON streaming with follow, replay/high-water race protection |
| `hrcchat wait` | **working** | Server-side blocking; timeout returns exit 124 |
| `hrcchat status` | **working** | General + per-target, JSON mode |
| `hrcchat doctor` | **working** | Connectivity + tmux health checks |

### Live agent-to-agent messaging test
```
#1  clod -> cody: "Hello from hrcchat! This is clod testing the new semantic dm pipeline."
#2  cody -> clod: "Hello back from cody via hrcchat!"
```
Both messages persisted in durable store, visible from both agents via `hrcchat messages`.

## Remaining blockers

### Blocker 1: SDK turn execution path uses empty ASP_HOME/spec (CRITICAL)

**What:** `hrcchat dm <target> <message>` stores the durable request message but fails to execute a real semantic turn. The error is: `Space manifest not found: ENOENT: no such file or directory, open 'repo/spaces/defaults/space.toml'`

**Root cause:** `packages/hrc-server/src/agent-spaces-adapter/sdk-adapter.ts` line 252-255 passes placeholder values to `createAgentSpacesClient().runTurnNonInteractive()`:
```ts
aspHome: '',
spec: { spaces: [] },
cwd: '/',
```

The real execution path needs the actual `ASP_HOME` and resolved space spec from the control plane's placement resolution. Without them, the agent-spaces client cannot find space manifests or resolve the execution environment.

**Why it was masked:** `normalizeDispatchIntent()` in hrc-server defaults `dryRun: true` (line ~6854), so all SDK turns went through the dry-run shim that returns `"Dry run SDK response for: <prompt>"`. Setting `dryRun: false` in hrcchat's `resolveRuntimeIntentForTarget` exposed this.

**Current state:** `resolve-intent.ts` sets `dryRun: false` but the turn fails silently (caught and logged as `semantic_dm.execution_failed`). The durable request message is still created. No reply is generated.

**Fix path:** The SDK adapter needs to resolve `aspHome` and `spec` from the runtime environment or control plane placement API, similar to how the CLI launch path builds these from `ASP_HOME` env and space resolution. Options:
1. Read `ASP_HOME` from server process env and resolve spaces at turn time
2. Store resolved space spec on the session (alongside intent) during summon
3. Have the CLI pass resolved `aspHome`/`spec` in the runtimeIntent

### Blocker 2: handleSdkDispatchTurn returns status:'completed' for all SDK turns

**What:** After fixing the dry-run status bug (SDK turns now return `status: 'completed'`), the `DispatchTurnResponse` type declares `status: 'completed' | 'started'`. The existing test expected `'started'` — test was updated to expect `'completed'`. However, this means the `DispatchTurnResponse` contract is potentially misleading for callers that assumed async semantics.

**Impact:** Low. SDK turns are synchronous (await `runSdkTurn`), so `'completed'` is correct. But if a future SDK turn path becomes async, the response contract needs revisiting.

### Non-blocker: cognitive complexity warning

`handleRequest` scores 105 (max 85). Pre-existing; grew with new routes. Could be addressed by extracting route dispatch into a table or splitting the method, but this is cosmetic.

## Build and test status

- Full workspace build: 16/16 packages pass
- All existing tests: 0 failures (SDK dispatch test updated for `status:'completed'`)
- Lint: clean (pre-existing cognitive complexity warning only)
- Store tests: 42 pass (12 message store + 30 existing)

## Code review notes (Cody)

Issues found and resolved during implementation:
1. `handleWatchMessages` was parsing query params instead of JSON body — fixed to parse POST body
2. `ensureTargetSession` returned stale record after updates — fixed to re-read after mutation
3. Turn status hardcoded as `'completed'`/`'started'` — fixed to propagate actual dispatch status
4. `dm.ts` was missing `runtimeIntent` in semanticDm request — fixed to resolve via `resolveRuntimeIntentForTarget`
5. `handleSdkDispatchTurn` returned `status:'started'` after awaiting completion — fixed to return `'completed'`
