import { projectTargetOperatorState } from 'hrc-core'

import { recommendPrimaryAction } from './action-policy.js'
import type { HrcTopPrimaryActionKind } from './action-policy.js'
import type { HrcTopRow } from './read-model.js'

export type HrcTopExplicitAction =
  | HrcTopPrimaryActionKind
  | 'tail'
  | 'capture'
  | 'inspect'
  | 'messagePreview'
  | 'messageShow'
  | 'messageReply'

export type HrcTopActionStatus =
  | 'confirmation_required'
  | 'delegated'
  | 'disabled'
  | 'executed'
  | 'filter_changed'
  | 'focused'
  | 'quit'

export type HrcTopActionResult = {
  status: HrcTopActionStatus
  action?: HrcTopExplicitAction | undefined
  reason?: string | undefined
  errorCode?: string | undefined
  filterText?: string | undefined
}

export type HrcTopAttachDescriptor = unknown

export type HrcTopActionExecutor = {
  attachRuntime(runtimeId: string): Promise<HrcTopAttachDescriptor>
  spawnAttachDescriptor(descriptor: HrcTopAttachDescriptor): Promise<Partial<HrcTopActionResult>>
  runCommand(argv: string[]): Promise<Partial<HrcTopActionResult>>
}

export type HrcTopActionDispatchInput = {
  action: HrcTopExplicitAction
  row: HrcTopRow
  executor: HrcTopActionExecutor
  confirmRunWithContinuation?: boolean | undefined
  messageId?: string | undefined
}

export type HrcTopCommandModeDispatcher = (
  input: HrcTopActionDispatchInput
) => Promise<HrcTopActionResult>

export async function dispatchHrcTopActionKey(input: {
  key: string
  row: HrcTopRow
  executor: HrcTopActionExecutor
  confirmRunWithContinuation?: boolean | undefined
  messageId?: string | undefined
}): Promise<HrcTopActionResult> {
  const action = actionForKey(input.key, input.row)
  if (!action) {
    return disabled('unknown', `No hrc top action is wired for key ${JSON.stringify(input.key)}.`)
  }

  return dispatchHrcTopAction({
    action,
    row: input.row,
    executor: input.executor,
    confirmRunWithContinuation: input.confirmRunWithContinuation,
    messageId: input.messageId,
  })
}

export async function dispatchHrcTopAction(
  input: HrcTopActionDispatchInput
): Promise<HrcTopActionResult> {
  switch (input.action) {
    case 'focus':
      return focused('focus', 'Focused selected target.')
    case 'inspect':
      return focused('inspect', 'Inspect selected target in the focus panel.')
    case 'tail':
      return focused('tail', 'Show the selected target event tail preview.')
    case 'capture':
      return captureRuntime(input)
    case 'attach':
      return attachRuntime(input)
    case 'resume':
      return resumeTarget(input)
    case 'run':
      return runTarget(input)
    case 'unavailable':
      return unavailableForRecommendedAction(input.row)
    case 'messagePreview':
      return focused('messagePreview', 'Preview selected message.')
    case 'messageShow':
      return showMessage(input)
    case 'messageReply':
      return replyToMessage(input)
  }
}

export async function executeHrcTopCommandLine(input: {
  line: string
  row: HrcTopRow
  executor: HrcTopActionExecutor
  dispatchAction?: HrcTopCommandModeDispatcher | undefined
  confirmRunWithContinuation?: boolean | undefined
  messageId?: string | undefined
}): Promise<HrcTopActionResult> {
  const parsed = parseCommandLine(input.line)
  if (!parsed) return disabled('command', 'Command mode expects a command beginning with `:`.')

  if (isDestructiveCommand(parsed.verb)) {
    return disabled(parsed.verb, `:${parsed.verb} is destructive and is not wired in hrc top.`)
  }

  if (parsed.verb === 'filter') {
    return {
      status: 'filter_changed',
      filterText: parsed.args,
      reason: parsed.args ? `Filter set to ${parsed.args}.` : 'Filter cleared.',
    }
  }
  if (parsed.verb === 'clear-filter') {
    return { status: 'filter_changed', filterText: '', reason: 'Filter cleared.' }
  }
  if (parsed.verb === 'quit') {
    return { status: 'quit', reason: 'Quit hrc top.' }
  }

  const action = commandAction(parsed.verb)
  if (!action) return disabled(parsed.verb, `Unknown hrc top command :${parsed.verb}.`)

  const dispatchAction = input.dispatchAction ?? dispatchHrcTopAction
  return dispatchAction({
    action,
    row: input.row,
    executor: input.executor,
    confirmRunWithContinuation: input.confirmRunWithContinuation,
    messageId: input.messageId,
  })
}

function actionForKey(key: string, row: HrcTopRow): HrcTopExplicitAction | undefined {
  switch (key) {
    case '\r':
    case '\n':
      return 'focus'
    case 'o':
      return recommendedActionForRow(row)
    case 'a':
      return 'attach'
    case 'r':
      return 'resume'
    case 'R':
      return 'run'
    case 'e':
      return 'tail'
    case 'c':
      return 'capture'
    case 'i':
      return 'inspect'
    default:
      return undefined
  }
}

function recommendedActionForRow(row: HrcTopRow): HrcTopExplicitAction {
  const projection = projectionForRow(row)
  return recommendPrimaryAction({
    handle: handleForRow(row),
    target: row.target,
    displayState: projection.displayState,
    operatorAttachable: projection.operatorAttachable,
    hasValidContinuation: projection.hasValidContinuation,
  }).kind
}

async function attachRuntime(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  const runtimeId = input.row.target.runtime?.runtimeId ?? input.row.runtime?.runtimeId
  const projection = projectionForRow(input.row)
  if (!runtimeId || !projection.operatorAttachable) {
    return disabled('attach', 'Attach is unavailable: no live operator-attachable runtime exists.')
  }

  const descriptor = await input.executor.attachRuntime(runtimeId)
  const spawned = await input.executor.spawnAttachDescriptor(descriptor)
  return executed('attach', spawned.reason ?? `Attached to runtime ${runtimeId}.`)
}

async function resumeTarget(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  const projection = projectionForRow(input.row)
  if (!projection.hasValidContinuation) {
    return {
      status: 'disabled',
      action: 'resume',
      errorCode: 'missing_valid_continuation',
      reason:
        'Resume is unavailable: no captured, non-invalidated continuation exists. ' +
        'hrc top will not fall back to a fresh launch.',
    }
  }

  const handle = handleForRow(input.row)
  const result = await input.executor.runCommand(['hrc', 'resume', handle])
  return executed('resume', result.reason ?? `Resumed ${handle}.`)
}

async function runTarget(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  const handle = handleForRow(input.row)
  if (input.row.hasContinuation && input.confirmRunWithContinuation !== true) {
    return {
      status: 'confirmation_required',
      action: 'run',
      reason:
        'This target has a continuation. Confirm before using hrc run instead of resume semantics.',
    }
  }

  const result = await input.executor.runCommand(['hrc', 'run', handle])
  return executed('run', result.reason ?? `Started ${handle}.`)
}

async function captureRuntime(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  const runtimeId = input.row.target.runtime?.runtimeId ?? input.row.runtime?.runtimeId
  if (!runtimeId || input.row.target.runtime?.supportsCapture === false) {
    return disabled('capture', 'Capture is unavailable: no runtime capture surface exists.')
  }

  const result = await input.executor.runCommand(['hrc', 'runtime', 'capture', runtimeId])
  return executed('capture', result.reason ?? `Captured runtime output for ${runtimeId}.`)
}

async function showMessage(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  if (!input.messageId) return disabled('messageShow', 'Message show requires a message id.')
  const result = await input.executor.runCommand(['hrcchat', 'show', input.messageId])
  return executed('messageShow', result.reason ?? `Showed message ${input.messageId}.`)
}

async function replyToMessage(input: HrcTopActionDispatchInput): Promise<HrcTopActionResult> {
  if (!input.messageId) return disabled('messageReply', 'Message reply requires a message id.')
  const handle = handleForRow(input.row)
  const result = await input.executor.runCommand([
    'hrcchat',
    'dm',
    handle,
    '--reply-to',
    input.messageId,
  ])
  return executed('messageReply', result.reason ?? `Replying to message ${input.messageId}.`)
}

function unavailableForRecommendedAction(row: HrcTopRow): HrcTopActionResult {
  const recommendation = recommendPrimaryAction({
    handle: handleForRow(row),
    target: row.target,
    ...projectionForRow(row),
  })
  return {
    status: 'disabled',
    action: 'unavailable',
    errorCode: recommendation.errorCode,
    reason: recommendation.reason,
  }
}

function projectionForRow(row: HrcTopRow) {
  return projectTargetOperatorState(row.target, {
    runtimeStatus: row.runtime?.status,
    operatorAttachable: row.target.runtime?.operatorAttachable,
    hasValidContinuation: row.hasContinuation,
  })
}

function commandAction(verb: string): HrcTopExplicitAction | undefined {
  switch (verb) {
    case 'attach':
    case 'resume':
    case 'run':
    case 'tail':
    case 'capture':
    case 'inspect':
      return verb
    default:
      return undefined
  }
}

function parseCommandLine(line: string): { verb: string; args: string } | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(':')) return undefined
  const body = trimmed.slice(1).trim()
  if (!body) return undefined
  const [verb = '', ...rest] = body.split(/\s+/)
  const argsStart = body.indexOf(verb) + verb.length
  return { verb, args: body.slice(argsStart).trim() || rest.join(' ') }
}

function isDestructiveCommand(verb: string): boolean {
  return (
    verb === 'terminate' ||
    verb === 'drop-continuation' ||
    verb === 'clear-context' ||
    verb === 'sweep' ||
    verb === 'forced-restart'
  )
}

function focused(action: HrcTopExplicitAction, reason: string): HrcTopActionResult {
  return { status: 'focused', action, reason }
}

function executed(action: HrcTopExplicitAction, reason: string): HrcTopActionResult {
  return { status: 'executed', action, reason }
}

function disabled(
  action: HrcTopExplicitAction | 'command' | string,
  reason: string
): HrcTopActionResult {
  return {
    status: 'disabled',
    action: isHrcTopAction(action) ? action : undefined,
    reason,
  }
}

function isHrcTopAction(action: string): action is HrcTopExplicitAction {
  return (
    action === 'attach' ||
    action === 'capture' ||
    action === 'focus' ||
    action === 'inspect' ||
    action === 'messagePreview' ||
    action === 'messageReply' ||
    action === 'messageShow' ||
    action === 'resume' ||
    action === 'run' ||
    action === 'tail' ||
    action === 'unavailable'
  )
}

function handleForRow(row: HrcTopRow): string {
  const parsed = parseSessionRef(row.sessionRef)
  if (!parsed) return row.sessionRef
  const task = parsed.task && parsed.task !== 'primary' ? `:${parsed.task}` : ':primary'
  const lane = parsed.lane && parsed.lane !== 'main' ? `~${parsed.lane}` : ''
  return `${parsed.agent}@${parsed.project}${task}${lane}`
}

function parseSessionRef(
  sessionRef: string
):
  | { agent: string; project: string; task?: string | undefined; lane?: string | undefined }
  | undefined {
  const [scope, lanePart] = sessionRef.split('/lane:')
  const parts = scope?.split(':') ?? []
  const agentIndex = parts.indexOf('agent')
  const projectIndex = parts.indexOf('project')
  const taskIndex = parts.indexOf('task')
  const agent = agentIndex >= 0 ? parts[agentIndex + 1] : undefined
  const project = projectIndex >= 0 ? parts[projectIndex + 1] : undefined
  if (!agent || !project) return undefined
  return {
    agent,
    project,
    task: taskIndex >= 0 ? parts[taskIndex + 1] : undefined,
    lane: lanePart,
  }
}
