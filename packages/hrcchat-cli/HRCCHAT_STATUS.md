# hrcchat-cli Implementation Status

**Date:** 2026-04-15
**Spec:** HRCCHAT_SPEC.md (root)
**Package:** packages/hrcchat-cli

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
  - `insert(input)` → `HrcMessageRecord` (auto self-roots when no rootMessageId)
  - `getById(messageId)` / `getBySeq(seq)`
  - `query(filter: HrcMessageFilter)` — full filter support
  - `maxSeq()` — for cursor-based watch
  - `updateExecution(messageId, patch)`
- Wired into `HrcDatabase.messages` in `src/database.ts`
- 12 passing unit tests in `src/__tests__/store.messages.test.ts`

### Layer 3: hrc-server routes (Cody, `packages/hrc-server/src/index.ts`)
Minimal slice landed — 4 routes:
- `GET /v1/targets` → `handleListTargets` — derives target views from sessions/runtimes
- `GET /v1/targets/by-session-ref` → `handleGetTarget` — single target lookup
- `POST /v1/messages/query` → `handleQueryMessages` — query durable message store
- `POST /v1/messages/dm` → `handleSemanticDm` — append durable request record (no turn execution yet)

Helper functions added: `normalizeTargetSessionRef`, `normalizeTargetLane`, `isActiveTargetSession`, `toTargetView`, `findTargetSession`, `parseMessageAddress`, `parseMessageFilter`, `parseSemanticDmRequest`, `extractProjectId`

### Layer 4: hrc-sdk client methods (`packages/hrc-sdk/src/client.ts`)
11 new typed methods on `HrcClient`:
- `listTargets()` → `GET /v1/targets`
- `getTarget()` → `GET /v1/targets/by-session-ref`
- `ensureTarget()` → `POST /v1/targets/ensure`
- `dispatchTurnBySelector()` → `POST /v1/turns/by-selector`
- `deliverLiteralBySelector()` → `POST /v1/literal-input/by-selector`
- `captureBySelector()` → `POST /v1/capture/by-selector`
- `createMessage()` → `POST /v1/messages`
- `listMessages()` → `POST /v1/messages/query`
- `waitMessage()` → `POST /v1/messages/wait`
- `semanticDm()` → `POST /v1/messages/dm`
- `watchMessages()` → `POST /v1/messages/watch` (async generator, NDJSON)

### Layer 5: hrcchat-cli package (`packages/hrcchat-cli`)
- `src/main.ts` — CLI entrypoint with command dispatch
- `src/cli-args.ts` — flag/arg parsing, duration parsing, body consumption
- `src/normalize.ts` — address resolution (human/system/me/target → HrcMessageAddress), sessionRef normalization (handles legacy HRC_SESSION_REF format without `lane:` prefix)
- `src/resolve-intent.ts` — runtime intent resolution from agent profiles (mirrors hrc-cli pattern)
- 10 command modules in `src/commands/`:
  - `who.ts`, `summon.ts`, `dm.ts`, `send.ts`, `messages.ts`
  - `watch.ts`, `wait.ts`, `peek.ts`, `status.ts`, `doctor.ts`
- Added to workspace build order in root `package.json`

## E2E test results (2026-04-15)

| Command | Status | Notes |
|---------|--------|-------|
| `hrcchat who` | **working** | Shows all targets with state/capabilities |
| `hrcchat dm <target> <msg>` | **working** | Durable message store, seq numbering |
| `hrcchat messages` | **working** | Query with filters, human + JSON output |
| `hrcchat status` | **working** | General HRC connectivity status |
| `hrcchat status <target>` | **working** | Per-target session/runtime/capabilities |
| `hrcchat doctor` | **working** | Connectivity + tmux health checks |
| `hrcchat --help` | **working** | Usage text |
| `hrcchat summon` | **not yet** | Needs `POST /v1/targets/ensure` server route |
| `hrcchat send` | **not yet** | Needs `POST /v1/literal-input/by-selector` server route |
| `hrcchat peek` | **not yet** | Needs `POST /v1/capture/by-selector` server route |
| `hrcchat watch` | **not yet** | Needs `POST /v1/messages/watch` server route |
| `hrcchat wait` | **not yet** | Needs `POST /v1/messages/wait` server route |

### Live agent-to-agent test
```
#1  clod -> cody: "Hello from hrcchat! This is clod testing the new semantic dm pipeline."
#2  cody -> clod: "Hello back from cody via hrcchat!"
```
Both messages persisted in durable store, visible from both agents via `hrcchat messages`.

## Remaining server routes needed

These routes have SDK methods and CLI commands wired but no server handler yet:

1. `POST /v1/targets/ensure` — summon target without starting runtime
2. `POST /v1/turns/by-selector` — selector-based semantic turn dispatch (needed for dm with execution)
3. `POST /v1/literal-input/by-selector` — selector-based literal text injection
4. `POST /v1/capture/by-selector` — selector-based runtime capture
5. `POST /v1/messages` — raw message creation endpoint
6. `POST /v1/messages/watch` — server-side NDJSON message stream
7. `POST /v1/messages/wait` — server-side blocking wait with timeout

## Remaining work for spec completeness

- **Semantic turn execution in dm**: Current `POST /v1/messages/dm` stores messages but does not execute a semantic turn against the target. Needs to summon target if needed, dispatch turn, capture `finalOutput`, and create automatic reply message.
- **Server-side watch/wait**: Needs message subscriber/wakeup plumbing in hrc-server (mirror the event follow pattern).
- **`--respond-to` threading**: dm stores the request but does not yet honor `respondTo` for reply routing.
- **`--wait` on dm**: Needs `POST /v1/messages/wait` server route.
- **Lane display bug**: `formatAddress` shows `agent@project/lane` instead of `agent@project` when lane is `main`. Minor cosmetic.

## Build and test status

- Full workspace build: 16/16 packages pass (including hrcchat-cli)
- All existing tests: 0 failures
- Lint: clean (biome)
- New test file: `packages/hrc-store-sqlite/src/__tests__/store.messages.test.ts` (12 tests)
