# hrcchat — Canonical Spec

**Date:** 2026-06-07
**Status:** CANONICAL
**Repo:** `/Users/lherron/praesidium/hrc-runtime`
**Package:** `packages/hrcchat-cli`
**Supersedes:** `packages/hrcchat-cli/HRCCHAT_STATUS.md` (2026-04-15 snapshot, removed in the 2026-06-07 spec cleanup)

---

## 1. Purpose

`hrcchat` is the semantic directed-messaging CLI for HRC. It lets a human or an agent address another **target** (an agent session or a discoverable entity), summon it if dormant, deliver a turn or literal input, capture its live output, and read/await durable messages. Every message is persisted in the HRC store before it is published to any live subscriber, so the conversation is durable and replayable across daemon restarts.

It is the agent-to-agent and human-to-agent counterpart to `hrc` (which manages runtimes/runs). `hrcchat` speaks only to the hrc-server HTTP surface via the typed `hrc-sdk` client; it never touches tmux, the broker, or the store directly.

---

## 2. Binaries / Packages

- **Binary:** `hrcchat` → `packages/hrcchat-cli/src/main.ts` (Bun runs TS source directly via the export condition; no build/install needed for CLI edits — see MEMORY "hrc runs from source not dist").
- **CLI package:** `packages/hrcchat-cli` (`hrcchat-cli@0.1.0`, private). Uses `commander` for command dispatch.
- **Dependencies in the chain:**
  - `hrc-core` — contracts/DTOs (Layer 1)
  - `hrc-sdk` — typed HTTP client (Layer 4)
  - `hrc-frame-render`, `agent-action-render` — live turn-frame rendering for the `turn` command
  - `agent-scope`, `spaces-config` — scope/intent resolution
  - `@anthropic-ai/sdk` + `chalk` — used by the stacked-summary feature

The server side spans three more packages: `hrc-server` (routes/handlers), `hrc-store-sqlite` (persistence), `hrc-core` (shared contracts).

---

## 3. Layered Architecture

A single 5-layer pipe from CLI keystroke to durable row:

**Layer 1 — Contracts (`packages/hrc-core/src/hrcchat-contracts.ts`)**
Address and view types: `HrcMessageAddress` (session | entity), `HrcTargetView`, `HrcTargetState`, `TargetCapabilityView`, `HrcTargetRuntimeView`. Message types: `HrcMessageRecord`, `HrcMessageKind`, `HrcMessagePhase`, `HrcMessageExecution`. Query type: `HrcMessageFilter` (participant/from/to/thread/afterSeq/kinds/phases/limit). All HTTP DTOs (`EnsureTargetRequest/Response`, `DispatchTurnBySelectorRequest/Response`, `DeliverLiteralBySelectorRequest/Response`, `CaptureBySelectorRequest/Response`, `CreateMessageRequest/Response`, `ListMessagesRequest/Response`, `WatchMessagesRequest`, `WaitMessageRequest/Response`, `SemanticDmRequest/Response`). Re-exported from `hrc-core/src/index.ts`.

**Layer 2 — Persistence (`packages/hrc-store-sqlite`)**
Migration `0007_hrcchat_messages` (`src/migrations.ts`): the `messages` table + **8 indexes** (see §5). `MessageRepository` (`src/message-repository.ts`): `insert(input)` (auto self-roots when no `rootMessageId`), `getById(messageId)`, `getBySeq(seq)`, `query(filter)`, `maxSeq()` (watch cursor), `updateExecution(messageId, patch)`. Wired into `HrcDatabase.messages` (`src/database.ts`). `sessions.updateParsedScope()` lives in `src/repositories.ts`.

**Layer 3 — Server routes/handlers (`packages/hrc-server`)**
Routes are registered in a typed dispatch table in `src/index.ts` (keyed by `exactRouteKey(method, path)`), the refactor that replaced the old flat if-chain. Handlers are split out of `index.ts` into focused modules: `target-message-handlers.ts`, `selector-message-handlers.ts`, `selector-wait-handlers.ts`, `event-notification-handlers.ts`. Subscriber state lives on the server instance (`messageSubscribers: Set<MessageSubscriber>`), with `notifyMessageSubscribers()` and the centralized **`insertAndNotifyMessage()`** append-then-publish helper (§6).

**Layer 4 — SDK client (`packages/hrc-sdk/src/client.ts`)**
Typed methods on `HrcClient`: `listTargets()`, `getTarget()`, `ensureTarget()`, `dispatchTurnBySelector()`, `deliverLiteralBySelector()`, `captureBySelector()`, `createMessage()`, `listMessages()`, `waitMessage()`, `semanticDm()`, and `watchMessages()` (async generator over NDJSON).

**Layer 5 — CLI (`packages/hrcchat-cli/src`)**
`main.ts` (commander dispatch) + per-command modules + shared helpers (see §4).

---

## 4. CLI Source Layout (`packages/hrcchat-cli/src`)

Verified current layout. **Note:** the `cli-args.ts` file listed in the 2026-04-15 snapshot does not exist and is omitted.

- `main.ts` — commander entrypoint and command registration
- `normalize.ts` — address resolution (human/system/me/target → `HrcMessageAddress`)
- `resolve-intent.ts` — runtime-intent resolution from agent profiles (mirrors hrc-cli's `buildManagedRuntimeIntent`)
- `print.ts` — shared output helpers (kept out of `main.ts` so command modules import cleanly)
- `domain-error-format.ts` — `formatHrcDomainError()` for `[code] message` + detail rendering
- `consul-secrets.ts` — Consul secret fetch (used by stacked-summary)
- `render-frame.ts` — render-sink format resolution (terminal/ndjson/tree/compact/json) for live turn frames
- `stacked-aggregator.ts`, `stacked-summary.ts`, `stacked-types.ts` — stacked turn-event aggregation + Haiku-backed summarization (model `claude-haiku-4-5`)
- `commands/` — `who.ts`, `summon.ts`, `dm.ts`, `send.ts`, `messages.ts`, `peek.ts`, `show.ts`, `turn.ts`, `doctor.ts`, `info.ts`

**Commands** (registered in `main.ts`): `info`, `who`, `summon`, `dm`, `send`, `show`, `messages`, `peek`, `turn`, `doctor`. The `turn` command (live frame-rendered dispatch with stacked aggregation/summary) and `show`/`info` are newer than the snapshot and supersede its command table.

---

## 5. HTTP Surface

`hrcchat`/`hrc-sdk` consume the following hrc-server routes (all `exactRouteKey`-registered in `hrc-server/src/index.ts`; SDK URLs in `hrc-sdk/src/client.ts`):

| Route | Handler | Used by |
|---|---|---|
| `GET /v1/targets` | `handleListTargets` | `who` |
| `GET /v1/targets/by-session-ref` | `handleGetTarget` | `doctor`, `turn` |
| `POST /v1/targets/ensure` | `handleEnsureTarget` | `summon` |
| `POST /v1/turns/by-selector` | `handleDispatchTurnBySelector` | SDK `dispatchTurnBySelector` |
| `POST /v1/literal-input/by-selector` | `handleLiteralInputBySelector` | `send` |
| `POST /v1/capture/by-selector` | `handleCaptureBySelector` | `peek` |
| `POST /v1/messages` | `handleCreateMessage` | SDK `createMessage` |
| `POST /v1/messages/query` | `handleQueryMessages` | `messages`, `show`, `turn` |
| `POST /v1/messages/dm` | `handleSemanticDm` | `dm` |
| `POST /v1/messages/turn-handoff` | `handleSemanticTurnHandoff` | semantic turn handoff |
| `POST /v1/messages/wait` | `handleWaitMessage` | `hrc monitor wait` |
| `POST /v1/messages/watch` | `handleWatchMessages` | `watchMessages` (NDJSON) |

`/v1/messages/turn-handoff` is a current addition not present in the snapshot's 11-route table. The `turn` and `peek`/`send`/`dm` commands also lean on the broader hrc-server surface indirectly (the SDK exposes `/v1/turns`, `/v1/capture`, `/v1/runtimes/*`, `/v1/events`, etc.), but those are not hrcchat-specific.

---

## 6. Persistence — Migration & Indexes

`0007_hrcchat_messages` creates the `messages` table (PK `message_seq` AUTOINCREMENT; unique `message_id`; from/to kind+ref, `reply_to_message_id`, `root_message_id`, `body`/`body_format`, execution state/mode, `session_ref`, `host_session_id`, `generation`, `runtime_id`, `run_id`, `transport`, error fields, `metadata_json`).

It creates **8 indexes** (the 2026-04-15 snapshot's "6 indexes" is wrong):

1. `idx_messages_to_seq` — `(to_kind, to_ref, message_seq)`
2. `idx_messages_from_seq` — `(from_kind, from_ref, message_seq)`
3. `idx_messages_root_seq` — `(root_message_id, message_seq)`
4. `idx_messages_reply_to_seq` — `(reply_to_message_id, message_seq)`
5. `idx_messages_session_seq` — `(session_ref, message_seq)`
6. `idx_messages_host_session_seq` — `(host_session_id, message_seq)`
7. `idx_messages_host_session_generation_seq` — `(host_session_id, generation, message_seq)`
8. `idx_messages_run` — `(run_id)`

`message_seq` is the monotonic cursor that drives `afterSeq` filtering and watch/wait high-water replay.

---

## 7. Concurrency Invariant — Append-then-Publish

**Durable append happens before any publish.** The single authority is `insertAndNotifyMessage()` (`hrc-server/src/event-notification-handlers.ts`):

```ts
const record = this.db.messages.insert(input)   // 1. durable append (assigns message_seq)
this.notifyMessageSubscribers(record)           // 2. publish to live watch/wait subscribers
this.maybeCompleteInteractiveSemanticTurn(record)
return record
```

A message is never visible to a `watch`/`wait` subscriber before it is committed and has a sequence number. Subscribers (`selector-wait-handlers.ts`) use a buffered replay-then-live pattern keyed off `maxSeq()` (mirroring `handleEvents` high-water) so a message inserted between the cursor read and subscription is not lost or double-delivered. All message creation paths funnel through `insertAndNotifyMessage()` — do not insert directly and notify out of band.

---

## 8. SDK-Turn ASP Home Rule

When the server dispatches a real SDK turn, the agent-spaces adapter (`hrc-server/src/agent-spaces-adapter/sdk-adapter.ts`) **must pass `aspHome: getAspHome()`**, never `aspHome: ''`. The downstream resolution is `req.aspHome ?? defaultAspHome ?? getAspHome()` — an empty string is non-nullish, so it would not fall through and would ENOENT on space-manifest resolution. The `spec`/`cwd` placeholders are ignored when `placement` is set (same pattern as `cli-adapter.ts`). Current code at `sdk-adapter.ts:339` is correct: `aspHome: getAspHome()`.

---

## 9. Known Limits / Operational Notes

- **Daemon staleness on ASP sync:** HRC-side validation of any ASP/store change is invalid unless `hrc server restart` runs *after* the sync — the daemon holds ASP libs and store resident (MEMORY: "ASP-merge e2e daemon staleness").
- **`runtime_unavailable` for dormant targets:** `send`/`peek` against a target with no live runtime correctly returns `runtime_unavailable`; use `summon` (idempotent; persists intent + parsedScopeJson) first, or use `dm` which can auto-summon discoverable targets when a `runtimeIntent` is resolvable.
- **SDK turns are synchronous:** they return `status:'completed'` (awaited inline). The `'started'` status is reserved for async paths.
- **Pi SDK finalOutput repetition:** a historical Pi-harness streaming-delta quirk could triple-repeat `finalOutput`; this is a harness-layer concern, not an hrcchat bug.
- **Shared-worktree blast radius:** a failed install in the shared `hrc-runtime` worktree breaks hrcchat for all agents (MEMORY). CLI edits run live from source; `hrc-server` route/handler edits require a daemon restart to take effect.
