import { existsSync, readFileSync } from 'node:fs'

import type {
  HrcEventCategory,
  HrcLaunchArtifact,
  HrcLifecycleEvent,
  HrcLifecycleTransport,
} from 'hrc-core'
import type {
  AgentMessageEvent,
  OtelLogRecordInput,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  UserPromptEvent,
} from 'hrc-events'
import type { HrcDatabase, HrcLifecycleEventInput } from 'hrc-store-sqlite'

const KIND_CATEGORIES: Record<string, HrcEventCategory> = {
  'session.created': 'session',
  'session.resolved': 'session',
  'session.generation_auto_rotated': 'session',
  'session.continuation_dropped': 'session',
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
  'runtime.stale': 'runtime',
  'runtime.reassociated': 'runtime',
  'runtime.adopted': 'runtime',
  'launch.wrapper_started': 'launch',
  'launch.child_started': 'launch',
  'launch.continuation_captured': 'launch',
  'launch.exited': 'launch',
  'launch.orphaned': 'launch',
  'launch.callback_rejected': 'launch',
  'turn.accepted': 'turn',
  'turn.started': 'turn',
  'turn.completed': 'turn',
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
  'turn.message': 'turn',
  'turn.message_segment': 'turn',
  'input.rejected': 'input',
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

const TURN_TEXT_LIMIT = 16 * 1024

/**
 * Per-assistant-message slice of a multi-message turn. A turn that interleaves
 * text and tool calls produces N of these (chronologically ordered, segmentIndex
 * 0..N-1). Consumers can reduce them into a single rendered message; the
 * existing `turn.message` event still carries the cumulative text for legacy
 * single-message consumers.
 */
export interface AgentMessageSegmentEvent {
  type: 'message_segment'
  message: {
    role: 'assistant'
    content: string
  }
  segmentIndex: number
  isLast: boolean
  truncated?: boolean | undefined
}

type SemanticTurnEvent =
  | {
      eventKind: 'turn.user_prompt'
      payload: UserPromptEvent
    }
  | {
      eventKind: 'turn.message'
      payload: AgentMessageEvent
    }
  | {
      eventKind: 'turn.message_segment'
      payload: AgentMessageSegmentEvent
    }
  | {
      eventKind: 'turn.tool_call'
      payload: ToolExecutionStartEvent
    }
  | {
      eventKind: 'turn.tool_result'
      payload: ToolExecutionEndEvent
    }
  | {
      eventKind: 'turn.completed'
      payload: Record<string, unknown>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type TranscriptEntry = {
  type?: string
  message?: {
    content?: string | Array<{ type?: string; text?: string }>
  }
}

/**
 * A `type:'user'` transcript entry is either a genuine prompt from the human
 * (string content, or content array with only text blocks) or the synthetic
 * `tool_result` injection that Claude Code writes after each PostToolUse.
 * Only the former marks a turn boundary.
 */
function isUserPromptEntry(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false
  const content = entry.message?.content
  if (typeof content === 'string') return content.length > 0
  if (!Array.isArray(content)) return false
  // Array form is a prompt only if every block is text (no tool_result).
  return content.every((block) => block?.type === 'text')
}

function truncateTurnText(text: string): { text: string; truncated?: true | undefined } {
  if (text.length <= TURN_TEXT_LIMIT) {
    return { text }
  }

  return {
    text: text.slice(0, TURN_TEXT_LIMIT),
    truncated: true,
  }
}

function isNonFlagArg(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-')
}

function stripCodexGlobalArgs(args: readonly string[]): string[] {
  const remaining: string[] = []
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--enable' || flag === '--disable') {
      i += args[i + 1] === undefined ? 0 : 1
      continue
    }
    if (flag !== undefined) {
      remaining.push(flag)
    }
  }
  return remaining
}

function extractCodexPrimingPrompt(argv: readonly string[]): string | undefined {
  const args = stripCodexGlobalArgs(argv.slice(1))
  const mode = args[0]
  if (!mode) {
    return undefined
  }

  if (mode === 'exec') {
    if (args[1] === 'resume') {
      return isNonFlagArg(args[3]) ? args[3] : undefined
    }
    return isNonFlagArg(args[1]) ? args[1] : undefined
  }

  if (mode === 'resume') {
    return isNonFlagArg(args[2]) ? args[2] : undefined
  }

  return isNonFlagArg(mode) ? mode : undefined
}

export function extractLaunchPrimingPrompt(
  artifact: Pick<HrcLaunchArtifact, 'harness' | 'argv'> &
    Partial<Pick<HrcLaunchArtifact, 'env' | 'codexAppServer'>>
): string | undefined {
  if (artifact.harness === 'pi') {
    const prompt = artifact.env?.['ASP_PRIMING_PROMPT']
    return typeof prompt === 'string' && prompt.length > 0 ? prompt : undefined
  }

  if (artifact.harness === 'codex-cli') {
    const prompt = artifact.codexAppServer?.prompt
    if (prompt && prompt.length > 0) {
      return prompt
    }
    return extractCodexPrimingPrompt(artifact.argv)
  }

  const dashIdx = artifact.argv.indexOf('--')
  if (dashIdx === -1) {
    return undefined
  }
  return isNonFlagArg(artifact.argv[dashIdx + 1]) ? artifact.argv[dashIdx + 1] : undefined
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

export function createAgentMessagePayload(text: string): AgentMessageEvent {
  const truncated = truncateTurnText(text)
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: truncated.text,
    },
    ...(truncated.truncated === true ? { truncated: true } : {}),
  }
}

export function deriveSemanticTurnEventFromHookDerivedEvent(
  event: unknown
): SemanticTurnEvent | undefined {
  if (!isRecord(event) || typeof event['type'] !== 'string') {
    return undefined
  }

  if (event['type'] === 'tool_execution_start') {
    return {
      eventKind: 'turn.tool_call',
      payload: event as unknown as ToolExecutionStartEvent,
    }
  }

  if (event['type'] === 'tool_execution_end') {
    return {
      eventKind: 'turn.tool_result',
      payload: event as unknown as ToolExecutionEndEvent,
    }
  }

  return undefined
}

export function deriveSemanticTurnEventFromSdkEvent(
  eventKind: string,
  eventJson: unknown
): SemanticTurnEvent | undefined {
  if (!isRecord(eventJson)) {
    return undefined
  }

  if (eventKind === 'sdk.message') {
    if (eventJson['role'] !== 'assistant' || typeof eventJson['content'] !== 'string') {
      return undefined
    }
    return {
      eventKind: 'turn.message',
      payload: createAgentMessagePayload(eventJson['content']),
    }
  }

  if (eventKind === 'sdk.tool_call') {
    if (typeof eventJson['toolUseId'] !== 'string' || typeof eventJson['toolName'] !== 'string') {
      return undefined
    }
    return {
      eventKind: 'turn.tool_call',
      payload: {
        type: 'tool_execution_start',
        toolUseId: eventJson['toolUseId'],
        toolName: eventJson['toolName'],
        input: isRecord(eventJson['input']) ? eventJson['input'] : {},
      },
    }
  }

  if (eventKind === 'sdk.tool_result') {
    if (typeof eventJson['toolUseId'] !== 'string' || typeof eventJson['toolName'] !== 'string') {
      return undefined
    }

    const output = eventJson['output']
    return {
      eventKind: 'turn.tool_result',
      payload: {
        type: 'tool_execution_end',
        toolUseId: eventJson['toolUseId'],
        toolName: eventJson['toolName'],
        result:
          isRecord(output) &&
          Array.isArray(output['content']) &&
          output['content'].every((item) => isRecord(item) && typeof item['type'] === 'string')
            ? (output as unknown as ToolExecutionEndEvent['result'])
            : {
                content: [
                  {
                    type: 'text',
                    text:
                      typeof output === 'string'
                        ? output
                        : output === undefined
                          ? ''
                          : (JSON.stringify(output) ?? String(output)),
                  },
                ],
              },
        isError: eventJson['isError'] === true,
      },
    }
  }

  return undefined
}

export function deriveSemanticTurnEventFromLaunchEvent(
  payload: unknown
): SemanticTurnEvent | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  const hookDerived = deriveSemanticTurnEventFromHookDerivedEvent(payload)
  if (hookDerived) {
    return hookDerived
  }

  if (payload['type'] === 'codex.user_prompt') {
    const prompt = typeof payload['prompt'] === 'string' ? payload['prompt'] : undefined
    if (!prompt || prompt.length === 0) {
      return undefined
    }
    return {
      eventKind: 'turn.user_prompt',
      payload: createUserPromptPayload(prompt),
    }
  }

  if (payload['type'] === 'turn.completed' || payload['type'] === 'turn_completed') {
    const success = payload['success'] !== false
    return {
      eventKind: 'turn.completed',
      payload: {
        success,
        transport: 'headless',
        source:
          typeof payload['source'] === 'string' && payload['source'].trim().length > 0
            ? payload['source']
            : 'launch_event',
        ...(isRecord(payload['usage']) ? { usage: payload['usage'] } : {}),
        ...(typeof payload['finalOutput'] === 'string'
          ? { finalOutput: payload['finalOutput'] }
          : {}),
        ...(isRecord(payload['message']) ? { message: payload['message'] } : {}),
        ...(isRecord(payload['outcome']) ? { outcome: payload['outcome'] } : {}),
      },
    }
  }

  if (payload['type'] !== 'message_end') {
    return undefined
  }

  const message = payload['message']
  if (!isRecord(message) || message['role'] !== 'assistant') {
    return undefined
  }

  const content = message['content']
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (item) =>
                isRecord(item) && item['type'] === 'text' && typeof item['text'] === 'string'
            )
            .map((item) => item['text'] as string)
            .join('')
        : ''

  if (text.length === 0) {
    return undefined
  }

  return {
    eventKind: 'turn.message',
    payload: createAgentMessagePayload(text),
  }
}

function unwrapHookPayload(hook: unknown): Record<string, unknown> | undefined {
  if (!isRecord(hook)) {
    return undefined
  }

  if (typeof hook['hook_event_name'] === 'string') {
    return hook
  }

  const hookEvent = hook['hookEvent']
  if (isRecord(hookEvent) && typeof hookEvent['hook_event_name'] === 'string') {
    return hookEvent
  }

  return undefined
}

/**
 * Walk the Claude Code transcript backwards from the end to the most recent
 * `user` entry, collecting every `assistant` entry's text content along the
 * way. Returns the segments in chronological order (oldest first). Each
 * segment is the joined text-blocks of one assistant message; tool_use blocks
 * are skipped. Empty assistant entries (tool-only rounds) are dropped.
 *
 * This is the source-of-truth for both `turn.message` (concatenate) and
 * `turn.message_segment` (one event per segment).
 */
function extractAssistantSegmentsSinceLastUserPrompt(transcriptPath: string): string[] {
  if (!existsSync(transcriptPath)) {
    return []
  }

  let lines: string[]
  try {
    lines = readFileSync(transcriptPath, 'utf-8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }

  const segments: string[] = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    if (isUserPromptEntry(entry)) {
      // Reached the prompt boundary — everything we collected belongs to
      // this turn. Walking backwards means segments[0] is the latest text;
      // reverse so the caller sees chronological order.
      break
    }
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    if (text && text.length > 0) {
      segments.push(text)
    }
  }
  return segments.reverse()
}

/**
 * Resolve the chronological list of assistant text segments emitted in the
 * turn that just stopped. Combines two sources:
 *
 *   1. `transcript_path` walked back to the last user prompt — gives us
 *      every text segment in order.
 *   2. The hook payload's `last_assistant_message` (or `last_response`) — the
 *      authoritative final segment, used to patch over a transcript-flush
 *      race where the file lags hundreds of ms behind the Stop hook fire.
 *
 * If both sources agree on the last segment, we keep one copy. If they
 * disagree (the hook's text isn't yet in the transcript), we append it as
 * the final segment.
 */
function resolveAssistantSegmentsForHook(unwrapped: Record<string, unknown>): string[] {
  const transcriptPath =
    typeof unwrapped['transcript_path'] === 'string' ? unwrapped['transcript_path'] : undefined
  const lastAssistantText =
    (typeof unwrapped['last_assistant_message'] === 'string'
      ? unwrapped['last_assistant_message']
      : undefined) ??
    (typeof unwrapped['last_response'] === 'string' ? unwrapped['last_response'] : undefined)

  const segments: string[] = transcriptPath
    ? extractAssistantSegmentsSinceLastUserPrompt(transcriptPath)
    : []

  if (lastAssistantText && lastAssistantText.length > 0) {
    if (
      segments.length === 0 ||
      segments[segments.length - 1]?.trim() !== lastAssistantText.trim()
    ) {
      segments.push(lastAssistantText)
    }
  }

  return segments
}

export function deriveSemanticTurnMessageFromHookPayload(
  hook: unknown
): SemanticTurnEvent | undefined {
  const unwrapped = unwrapHookPayload(hook)
  if (!unwrapped) {
    return undefined
  }

  const hookName = unwrapped['hook_event_name']
  if (hookName !== 'Stop' && hookName !== 'SessionEnd' && hookName !== 'SubagentStop') {
    return undefined
  }

  const segments = resolveAssistantSegmentsForHook(unwrapped)
  if (segments.length === 0) {
    return undefined
  }
  // Cumulative text across the whole turn: every assistant message segment
  // joined with a paragraph break. Keeps the single-string contract for
  // legacy `turn.message` consumers while reflecting the full response.
  return {
    eventKind: 'turn.message',
    payload: createAgentMessagePayload(segments.join('\n\n')),
  }
}

/**
 * Derive one `turn.message_segment` event per assistant text segment in the
 * turn that just stopped. Used alongside `deriveSemanticTurnMessageFromHookPayload`
 * — the cumulative `turn.message` keeps the single-message contract; these
 * segments expose per-message fidelity so streaming UIs can render each
 * round of `text → tool → text` independently.
 *
 * Returns an empty array if the hook isn't a Stop-class event, or if the
 * transcript can't be read (in which case the caller falls back to the
 * single cumulative `turn.message`).
 */
export function deriveSemanticTurnMessageSegmentsFromHookPayload(
  hook: unknown
): SemanticTurnEvent[] {
  const unwrapped = unwrapHookPayload(hook)
  if (!unwrapped) return []

  const hookName = unwrapped['hook_event_name']
  if (hookName !== 'Stop' && hookName !== 'SessionEnd' && hookName !== 'SubagentStop') {
    return []
  }

  const segments = resolveAssistantSegmentsForHook(unwrapped)
  if (segments.length === 0) return []

  return segments.map((text, index) => {
    const truncated = truncateTurnText(text)
    const payload: AgentMessageSegmentEvent = {
      type: 'message_segment',
      message: { role: 'assistant', content: truncated.text },
      segmentIndex: index,
      isLast: index === segments.length - 1,
      ...(truncated.truncated === true ? { truncated: true } : {}),
    }
    return { eventKind: 'turn.message_segment', payload }
  })
}

export function deriveSemanticTurnUserPromptFromHookPayload(
  hook: unknown
): Extract<SemanticTurnEvent, { eventKind: 'turn.user_prompt' }> | undefined {
  const unwrapped = unwrapHookPayload(hook)
  if (!unwrapped) {
    return undefined
  }

  if (unwrapped['hook_event_name'] !== 'UserPromptSubmit') {
    return undefined
  }

  const prompt = typeof unwrapped['prompt'] === 'string' ? unwrapped['prompt'] : undefined
  if (!prompt || prompt.length === 0) {
    return undefined
  }

  return {
    eventKind: 'turn.user_prompt',
    payload: createUserPromptPayload(prompt),
  }
}

export function deriveSemanticTurnUserPromptFromCodexOtelRecord(
  record: OtelLogRecordInput
): Extract<SemanticTurnEvent, { eventKind: 'turn.user_prompt' }> | undefined {
  const attrs = record.logRecord.attributes
  if (!attrs) {
    return undefined
  }

  const eventName = attrs['event.name'] ?? attrs['event_name']
  if (eventName !== 'codex.user_prompt') {
    return undefined
  }

  const prompt = typeof attrs['prompt'] === 'string' ? attrs['prompt'] : undefined
  if (!prompt || prompt.length === 0) {
    return undefined
  }

  return {
    eventKind: 'turn.user_prompt',
    payload: createUserPromptPayload(prompt),
  }
}

function payloadMatchesUserPrompt(payload: unknown, prompt: string): boolean {
  if (!isRecord(payload) || payload['type'] !== 'message_end') {
    return false
  }

  const message = payload['message']
  return isRecord(message) && message['role'] === 'user' && message['content'] === prompt
}

export function shouldSuppressDuplicateCodexInitialUserPrompt(params: {
  db: HrcDatabase
  launchId: string
  artifact: Pick<HrcLaunchArtifact, 'harness' | 'argv'> &
    Partial<Pick<HrcLaunchArtifact, 'env' | 'codexAppServer'>>
  hostSessionId: string
  runtimeId?: string | undefined
  runId?: string | undefined
  prompt: string
  currentEventSeq: number
}): boolean {
  const primingPrompt = extractLaunchPrimingPrompt(params.artifact)
  if (!primingPrompt || primingPrompt !== params.prompt) {
    return false
  }

  const promptRows = params.db.events
    .listFromSeq(1, {
      hostSessionId: params.hostSessionId,
      ...(params.runtimeId ? { runtimeId: params.runtimeId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    })
    .filter(
      (event) => event.seq <= params.currentEventSeq && event.eventKind === 'codex.user_prompt'
    )
  if (promptRows.length !== 1) {
    return false
  }

  const priorPromptEvents =
    params.runId || params.runtimeId
      ? params.db.hrcEvents.listFromHrcSeq(1, {
          hostSessionId: params.hostSessionId,
          ...(params.runtimeId ? { runtimeId: params.runtimeId } : {}),
          ...(params.runId ? { runId: params.runId } : {}),
          eventKind: 'turn.user_prompt',
        })
      : params.db.hrcEvents.listByLaunch(params.launchId, { eventKind: 'turn.user_prompt' })

  return priorPromptEvents.some((event) => payloadMatchesUserPrompt(event.payload, params.prompt))
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
