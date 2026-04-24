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
  'app-session.created': 'app_session',
  'app-session.removed': 'app_session',
  'app-session.literal-input': 'app_session',
  'target.literal-input': 'app_session',
  'runtime.created': 'runtime',
  'runtime.ensured': 'runtime',
  'runtime.interrupted': 'runtime',
  'runtime.terminated': 'runtime',
  'runtime.restarted': 'runtime',
  'runtime.dead': 'runtime',
  'runtime.stale': 'runtime',
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
  'turn.user_prompt': 'turn',
  'turn.tool_call': 'turn',
  'turn.tool_result': 'turn',
  'turn.message': 'turn',
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
      eventKind: 'turn.tool_call'
      payload: ToolExecutionStartEvent
    }
  | {
      eventKind: 'turn.tool_result'
      payload: ToolExecutionEndEvent
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type TranscriptEntry = {
  type?: string
  message?: {
    content?: Array<{ type?: string; text?: string }>
  }
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

function extractCodexPrimingPrompt(argv: readonly string[]): string | undefined {
  const [, ...args] = argv
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
  artifact: Pick<HrcLaunchArtifact, 'harness' | 'argv'>
): string | undefined {
  if (artifact.harness === 'codex-cli') {
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
  if (!isRecord(payload) || payload['type'] !== 'message_end') {
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

function extractLastAssistantResponse(transcriptPath: string): string | undefined {
  if (!existsSync(transcriptPath)) {
    return undefined
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const line = lines[i]
        if (!line) continue
        const entry = JSON.parse(line) as TranscriptEntry
        if (entry.type !== 'assistant') continue
        const text = entry.message?.content
          ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('\n')
        if (text && text.length > 0) {
          return text
        }
      } catch {
        // Ignore malformed transcript lines while walking backwards.
      }
    }
  } catch {
    return undefined
  }

  return undefined
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

  const transcriptPath =
    typeof unwrapped['transcript_path'] === 'string' ? unwrapped['transcript_path'] : undefined
  const lastResponse =
    typeof unwrapped['last_response'] === 'string' ? unwrapped['last_response'] : undefined
  const lastAssistantMessage =
    typeof unwrapped['last_assistant_message'] === 'string'
      ? unwrapped['last_assistant_message']
      : undefined

  const text =
    (transcriptPath ? extractLastAssistantResponse(transcriptPath) : undefined) ??
    lastAssistantMessage ??
    lastResponse
  if (!text || text.length === 0) {
    return undefined
  }

  return {
    eventKind: 'turn.message',
    payload: createAgentMessagePayload(text),
  }
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
  artifact: Pick<HrcLaunchArtifact, 'harness' | 'argv'>
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

  return params.db.hrcEvents
    .listByLaunch(params.launchId, { eventKind: 'turn.user_prompt' })
    .some((event) => payloadMatchesUserPrompt(event.payload, params.prompt))
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
