import type { HrcEventCategory, HrcLifecycleEvent, HrcLifecycleTransport } from 'hrc-core'
import type { UserPromptEvent } from 'hrc-events'
import type { HrcDatabase, HrcLifecycleEventInput } from 'hrc-store-sqlite'

const KIND_CATEGORIES: Record<string, HrcEventCategory> = {
  'session.created': 'session',
  'session.resolved': 'session',
  'session.generation_auto_rotated': 'session',
  'session.continuation_dropped': 'session',
  // T-07594 (durable law `hrc-runtime.viewer-presentation-sidecar` §5.2): the
  // session-title write/clear becomes a ledger fact so a presentation consumer
  // can retitle from the stream instead of polling.
  'session.retitled': 'session',
  'app-session.created': 'app_session',
  'app-session.removed': 'app_session',
  'app-session.literal-input': 'app_session',
  'target.literal-input': 'app_session',
  'runtime.created': 'runtime',
  'runtime.ensured': 'runtime',
  'runtime.interrupted': 'runtime',
  'runtime.terminated': 'runtime',
  'runtime.idle_cleanup_started': 'runtime',
  'runtime.sweep_completed': 'runtime',
  'runtime.restarted': 'runtime',
  'runtime.dead': 'runtime',
  'runtime.crashed': 'runtime',
  'runtime.stale': 'runtime',
  'runtime.reassociated': 'runtime',
  'runtime.adopted': 'runtime',
  // T-07594 §5.2: one invocation's presentation decision. Appended at the exact
  // point the in-daemon viewer spawn happens today — after the `:tui` substrate
  // exists — so a consumer needs no readiness race and no effectful read.
  'runtime.presentation': 'runtime',
  'runtime.capture_state_changed': 'runtime',
  'runtime.capture_released': 'runtime',
  // T-07235 provision-liveness watchdog. `first_turn_missing` is the single
  // reason-coded terminal fact; the other two are linked informational rows.
  first_turn_missing: 'runtime',
  'first_turn_missing.diagnostics': 'runtime',
  'first_turn_missing.late_start': 'runtime',
  'broker.diagnostic': 'runtime',
  'broker.seat.transition': 'runtime',
  'broker.seat.stalled': 'runtime',
  'broker.dispatch_authority.disagreement': 'runtime',
  'broker.socket.closed_unexpectedly': 'runtime',
  'launch.wrapper_started': 'launch',
  'launch.child_started': 'launch',
  'launch.continuation_captured': 'launch',
  'launch.exited': 'launch',
  'launch.orphaned': 'launch',
  'launch.callback_rejected': 'launch',
  'command_run.started': 'turn',
  'command_run.exited': 'turn',
  'turn.accepted': 'turn',
  'turn.started': 'turn',
  'turn.completed': 'turn',
  // T-07944: `turn.failed`/`turn.interrupted` were consumed as terminal turn
  // kinds (the mail drive's terminal set, the ACP notify filter) and produced by
  // three sites — the broker start-failure path, the interactive start-failure
  // path, and the T-04240 evidence finalize — but were never registered here, so
  // every one of those appends threw `unknown hrc event kind` instead of writing
  // the terminal fact. The live ledger has zero of either kind, which is what
  // that looks like from the outside.
  'turn.failed': 'turn',
  'turn.interrupted': 'turn',
  'turn.degraded_input_delivered': 'turn',
  'turn.zombied': 'turn',
  'turn.reaped': 'turn',
  'turn.user_prompt': 'turn',
  'turn.tool_call': 'turn',
  'turn.tool_result': 'turn',
  // HRC-derived (T-01946): the turn parked on / resumed from a user prompt. Not
  // a broker event type; the event mapper emits these from the ask bracket.
  'turn.awaiting_input': 'turn',
  'turn.input_resumed': 'turn',
  'broker.turn.origin': 'turn',
  'turn.message': 'turn',
  'turn.message_segment': 'turn',
  'input.rejected': 'input',
  'input.landed': 'input',
  'input.terminal': 'input',
  'input.correlation': 'input',
  'broker.submission.milestone': 'input',
  'broker.submission.stalled': 'input',
  // T-08536: the steer door failed open to enqueue; countable downgrades.
  'submission.door_downgraded': 'input',
  'inflight.accepted': 'inflight',
  'inflight.rejected': 'inflight',
  'surface.bound': 'surface',
  'surface.rebound': 'surface',
  'surface.unbound': 'surface',
  'bridge.delivered': 'bridge',
  'bridge.closed': 'bridge',
  'context.cleared': 'context',
}

export function categoryForEventKind(eventKind: string): HrcEventCategory {
  const category = KIND_CATEGORIES[eventKind]
  if (!category) {
    throw new Error(`unknown hrc event kind: ${eventKind}`)
  }
  return category
}

export type AppendHrcEventParams = {
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  transport?: HrcLifecycleTransport | undefined
  errorCode?: string | undefined
  replayed?: boolean | undefined
  payload?: unknown
}

export const TURN_TEXT_LIMIT = 16 * 1024

function truncateTurnText(text: string): { text: string; truncated?: true | undefined } {
  if (text.length <= TURN_TEXT_LIMIT) {
    return { text }
  }

  return {
    text: text.slice(0, TURN_TEXT_LIMIT),
    truncated: true,
  }
}

export function createUserPromptPayload(text: string): UserPromptEvent {
  const truncated = truncateTurnText(text)
  return {
    type: 'message_end',
    message: {
      role: 'user',
      content: truncated.text,
    },
    ...(truncated.truncated === true ? { truncated: true } : {}),
  }
}

export function appendHrcEvent(
  db: HrcDatabase,
  eventKind: string,
  params: AppendHrcEventParams
): HrcLifecycleEvent {
  const input: HrcLifecycleEventInput = {
    ts: params.ts,
    hostSessionId: params.hostSessionId,
    scopeRef: params.scopeRef,
    laneRef: params.laneRef,
    generation: params.generation,
    runtimeId: params.runtimeId,
    runId: params.runId,
    launchId: params.launchId,
    appId: params.appId,
    appSessionKey: params.appSessionKey,
    category: categoryForEventKind(eventKind),
    eventKind,
    transport: params.transport,
    errorCode: params.errorCode,
    replayed: params.replayed,
    payload: params.payload ?? {},
  }
  return db.hrcEvents.append(input)
}
