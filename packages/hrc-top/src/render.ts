import { projectTargetOperatorState } from 'hrc-core'
import type { HrcTargetOperatorDisplayState } from 'hrc-core'

import { recommendPrimaryAction } from './action-policy.js'
import type { HrcTopPrimaryAction } from './action-policy.js'
import { buildFocusPanelModel } from './focus.js'
import type { HrcTopFocusPanelModel } from './focus.js'
import type { HrcTopNavState } from './nav-state.js'
import type { HrcTopReadModel, HrcTopRow } from './read-model.js'

export type HrcTopRenderInput = {
  model: HrcTopReadModel
  navState: HrcTopNavState
  viewportHeight: number
  width?: number | undefined
  filterText?: string | undefined
  focusMode?: boolean | undefined
  showHelp?: boolean | undefined
  notice?: string | undefined
}

export type HrcTopRenderedRow = {
  id: string
  selected: boolean
  handle: string
  displayState: HrcTargetOperatorDisplayState
  last: string
  action: HrcTopPrimaryAction
}

export type HrcTopScreenModel = {
  title: string
  counts: HrcTopReadModel['counts']
  rows: readonly HrcTopRenderedRow[]
  selected?: HrcTopRenderedRow | undefined
  focus?: HrcTopFocusPanelModel | undefined
  filterText: string
  totalRows: number
  visibleRows: number
  refreshedAt: string
  width: number
  showHelp: boolean
  notice?: string | undefined
}

export function buildTopScreenModel(input: HrcTopRenderInput): HrcTopScreenModel {
  const width = Math.max(60, input.width ?? 100)
  const renderedRows = input.model.rows.map((row) => renderRowModel(row, input.navState))
  const selected = renderedRows.find((row) => row.selected) ?? renderedRows[0]
  const selectedSource = selected
    ? input.model.rows.find((row) => row.id === selected.id)
    : undefined

  return {
    title: 'HRC TOP',
    counts: input.model.counts,
    rows: sliceRowsForViewport(renderedRows, input.navState.selectedIndex, input.viewportHeight),
    selected,
    focus:
      input.focusMode && selectedSource
        ? focusPanelForRow(selectedSource)
        : selectedSource
          ? focusPanelForRow(selectedSource)
          : undefined,
    filterText: input.filterText ?? '',
    totalRows: input.model.rows.length,
    visibleRows: input.model.rows.length,
    refreshedAt: input.model.refreshedAt,
    width,
    showHelp: input.showHelp ?? false,
    notice: input.notice,
  }
}

export function renderTopScreen(input: HrcTopRenderInput): string {
  return renderTopScreenModel(buildTopScreenModel(input))
}

export function renderTopScreenModel(screen: HrcTopScreenModel): string {
  const separator = '─'.repeat(screen.width)
  const lines: string[] = [
    `${screen.title.padEnd(Math.max(0, screen.width - 35))}healthy  ${screen.counts.live} live  ${screen.counts.dormant} dormant`,
    '',
    `${' '.repeat(2)}${pad('target', 42)}  ${pad('state', 10)}  ${pad('last', 8)}  action`,
  ]

  for (const row of screen.rows) {
    const cursor = row.selected ? '>' : ' '
    lines.push(
      `${cursor} ${pad(row.handle, 42)}  ${pad(row.displayState, 10)}  ${pad(row.last, 8)}  ${row.action.kind}`
    )
  }

  if (screen.rows.length === 0) {
    lines.push('  no targets visible')
  }

  lines.push('', separator)
  if (screen.focus && screen.selected) {
    lines.push(...renderBottomPanel(screen))
  } else {
    lines.push('no target selected')
  }

  return `${lines.join('\n')}\n`
}

function renderBottomPanel(screen: HrcTopScreenModel): string[] {
  const focus = screen.focus
  if (!focus) return ['no target selected']

  const lines = [
    `${focus.handle} / ${focus.lane}`,
    `primary: ${formatPrimaryAction(focus.primaryAction)}`,
    `reason: ${focus.primaryAction.reason}`,
    `filter: ${screen.filterText || 'none'}   rows: ${screen.visibleRows}/${screen.totalRows}`,
    'keys: j/k move  enter focus  o default  a attach  r resume  / filter  : command',
  ]

  if (screen.notice) lines.push(`notice: ${screen.notice}`)

  if (screen.showHelp) {
    lines.push(
      "help: gg/G top/bottom  Ctrl-d/u half-page  Ctrl-f/b page  m<char> mark  '<char> jump  q back/quit"
    )
  }

  if (
    screen.focus &&
    screen.selected &&
    screen.focus !== undefined &&
    screen.selected !== undefined
  ) {
    if (screen.focus.primaryAction.kind === 'unavailable') {
      const disabled = screen.focus.disabledActions.map(
        (action) => `${action.kind}: ${action.reason}`
      )
      if (disabled.length > 0) lines.push(`disabled: ${disabled.join(' | ')}`)
    }
  }

  return lines
}

function focusPanelForRow(row: HrcTopRow): HrcTopFocusPanelModel {
  const projection = projectTargetOperatorState(row.target, {
    runtimeStatus: row.runtime?.status,
    operatorAttachable: row.target.runtime?.operatorAttachable,
    hasValidContinuation: row.hasContinuation,
  })
  const handle = handleForRow(row)

  return buildFocusPanelModel({
    handle,
    target: row.target,
    displayState: projection.displayState,
    operatorAttachable: projection.operatorAttachable,
    hasValidContinuation: projection.hasValidContinuation,
    latestEventSummary: latestEventSummary(row),
    disabledActions: disabledActionsFor(
      row,
      projection.displayState,
      projection.operatorAttachable
    ),
  })
}

function renderRowModel(row: HrcTopRow, navState: HrcTopNavState): HrcTopRenderedRow {
  const projection = projectTargetOperatorState(row.target, {
    runtimeStatus: row.runtime?.status,
    operatorAttachable: row.target.runtime?.operatorAttachable,
    hasValidContinuation: row.hasContinuation,
  })
  const handle = handleForRow(row)
  return {
    id: row.id,
    selected: row.id === navState.selectedRowId,
    handle,
    displayState: projection.displayState,
    last: formatLast(row.last.at),
    action: recommendPrimaryAction({
      handle,
      target: row.target,
      displayState: projection.displayState,
      operatorAttachable: projection.operatorAttachable,
      hasValidContinuation: projection.hasValidContinuation,
    }),
  }
}

function sliceRowsForViewport(
  rows: readonly HrcTopRenderedRow[],
  selectedIndex: number,
  viewportHeight: number
): readonly HrcTopRenderedRow[] {
  const bodyHeight = Math.max(1, viewportHeight - 8)
  if (rows.length <= bodyHeight) return rows

  const selected = selectedIndex < 0 ? 0 : selectedIndex
  const start = Math.min(
    Math.max(0, selected - Math.floor(bodyHeight / 2)),
    Math.max(0, rows.length - bodyHeight)
  )
  return rows.slice(start, start + bodyHeight)
}

function disabledActionsFor(
  row: HrcTopRow,
  displayState: HrcTargetOperatorDisplayState,
  operatorAttachable: boolean
): readonly { kind: 'attach' | 'resume' | 'run'; reason: string }[] {
  const disabled: { kind: 'attach' | 'resume' | 'run'; reason: string }[] = []
  if (!operatorAttachable)
    disabled.push({ kind: 'attach', reason: 'no live operator-attachable runtime exists' })
  if (!row.hasContinuation)
    disabled.push({ kind: 'resume', reason: 'no captured, non-invalidated continuation exists' })
  if (displayState === 'dormant') {
    disabled.push({
      kind: 'run',
      reason: 'dormant targets require resume semantics, not a fresh launch',
    })
  }
  return disabled
}

function latestEventSummary(row: HrcTopRow): string {
  if (row.last.at) return `last activity: ${row.last.at}`
  return 'No recent event summary is available.'
}

function formatPrimaryAction(action: HrcTopPrimaryAction): string {
  if (action.command) return `${action.kind} ${action.command.slice(2).join(' ')}`
  return action.kind
}

function formatLast(value: string | undefined): string {
  if (!value) return 'unknown'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  const ageMs = Date.now() - timestamp
  if (ageMs < 60_000) return '<1m'
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`
  return `${Math.floor(ageMs / 86_400_000)}d`
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

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 3))}...` : value
  return clipped.padEnd(width)
}
