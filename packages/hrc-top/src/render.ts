import { projectTargetOperatorState } from 'hrc-core'
import type { HrcTargetOperatorDisplayState } from 'hrc-core'

import { recommendPrimaryAction } from './action-policy.js'
import type { HrcTopPrimaryAction } from './action-policy.js'
import { applyFilter } from './filter.js'
import type { HrcTopFilterRow } from './filter.js'
import { buildFocusPanelModel } from './focus.js'
import type { HrcTopFocusPanelModel } from './focus.js'
import type { HrcTopNavState } from './nav-state.js'
import type { HrcTopReadModel, HrcTopRow } from './read-model.js'
import { PALETTE, createPainter, stateColorHex } from './theme.js'
import type { Painter } from './theme.js'
import { groupTriageRows, isActionableBucket, triageCounts } from './triage.js'
import type { HrcTopTriageBucket, HrcTopTriageCounts } from './triage.js'

export type HrcTopRenderInput = {
  model: HrcTopReadModel
  navState: HrcTopNavState
  viewportHeight: number
  width?: number | undefined
  filterText?: string | undefined
  /** True while the operator is actively typing into the `/` filter entry. */
  filterMode?: boolean | undefined
  /** True while the operator is actively typing into the `:` command entry. */
  commandMode?: boolean | undefined
  commandText?: string | undefined
  /** Enter opens the full-disclosure focus lens over the selected target. */
  focusMode?: boolean | undefined
  /** `.` expands the collapsed idle tail into the faint full list. */
  showAll?: boolean | undefined
  showHelp?: boolean | undefined
  notice?: string | undefined
  /** Emit ANSI truecolor. Defaults off (piped output / snapshot tests). */
  color?: boolean | undefined
}

export type HrcTopRenderedRow = {
  id: string
  selected: boolean
  handle: string
  displayState: HrcTargetOperatorDisplayState
  last: string
  action: HrcTopPrimaryAction
  bucket: HrcTopTriageBucket
  /** Action-class gutter glyph (● attach ◇ resume ✕ broken ◐ starting ○ idle). */
  glyph: string
  /** True for the quiet idle sea — rendered ~2 luminance tiers down. */
  idle: boolean
}

export type HrcTopTriageSection = {
  bucket: HrcTopTriageBucket
  label: string
  rows: readonly HrcTopRenderedRow[]
}

export type HrcTopScreenModel = {
  title: string
  counts: HrcTopReadModel['counts']
  triageCounts: HrcTopTriageCounts
  rows: readonly HrcTopRenderedRow[]
  sections: readonly HrcTopTriageSection[]
  /** Present when the idle tail is collapsed (default view). */
  idleCollapsed?: { count: number } | undefined
  selected?: HrcTopRenderedRow | undefined
  focus?: HrcTopFocusPanelModel | undefined
  filterText: string
  filterActive: boolean
  filterMode: boolean
  commandMode: boolean
  commandText: string
  focusMode: boolean
  showAll: boolean
  totalRows: number
  visibleRows: number
  refreshedAt: string
  width: number
  viewportHeight: number
  color: boolean
  showHelp: boolean
  notice?: string | undefined
}

const SECTION_LABELS: Record<HrcTopTriageBucket, string> = {
  needsYou: 'NEEDS YOU',
  working: 'WORKING',
  resumable: 'RESUMABLE',
  attention: 'ATTENTION',
  idle: 'IDLE',
}

const STRIP_GLYPH: Record<HrcTopTriageBucket, string> = {
  needsYou: '◈',
  working: '●',
  resumable: '◇',
  attention: '✕',
  idle: '○',
}

// -- Row projection -----------------------------------------------------------

type RowFact = {
  source: HrcTopRow
  handle: string
  displayState: HrcTargetOperatorDisplayState
  operatorAttachable: boolean
  hasValidContinuation: boolean
  action: HrcTopPrimaryAction
  bucket: HrcTopTriageBucket
}

function projectRowFact(row: HrcTopRow): RowFact {
  const projection = projectTargetOperatorState(row.target, {
    runtimeStatus: row.runtime?.status,
    operatorAttachable: row.target.runtime?.operatorAttachable,
    hasValidContinuation: row.hasContinuation,
  })
  const handle = handleForRow(row)
  const action = recommendPrimaryAction({
    handle,
    target: row.target,
    displayState: projection.displayState,
    operatorAttachable: projection.operatorAttachable,
    hasValidContinuation: projection.hasValidContinuation,
  })
  const group = groupTriageRows([
    {
      id: row.id,
      displayState: projection.displayState,
      hasValidContinuation: projection.hasValidContinuation,
    },
  ])
  return {
    source: row,
    handle,
    displayState: projection.displayState,
    operatorAttachable: projection.operatorAttachable,
    hasValidContinuation: projection.hasValidContinuation,
    action,
    bucket: group[0]?.bucket ?? 'idle',
  }
}

function gutterGlyphFor(fact: RowFact): string {
  if (fact.displayState === 'starting') return '◐'
  if (fact.displayState === 'broken' || fact.displayState === 'ambiguous') return '✕'
  switch (fact.action.kind) {
    case 'attach':
      return '●'
    case 'resume':
      return '◇'
    case 'unavailable':
      return '✕'
    default:
      return '○'
  }
}

// -- Triage view --------------------------------------------------------------

type TriageView = {
  orderedFacts: RowFact[]
  sections: { bucket: HrcTopTriageBucket; rows: RowFact[] }[]
  idleCollapsed?: { count: number } | undefined
  counts: HrcTopTriageCounts
  filterActive: boolean
  visibleRows: number
  totalRows: number
}

/**
 * The single source of triage ordering + collapse policy, shared by the screen
 * model and the nav visible-row seam so display order and cursor traversal never
 * diverge. Idle collapses ONLY in the unfiltered default view; an active filter
 * or `.` show-all reveals the (faint) idle rows so a filter never hides matches.
 */
function computeTriageView(
  model: HrcTopReadModel,
  opts: { filterText?: string | undefined; showAll?: boolean | undefined }
): TriageView {
  const factRows: (HrcTopFilterRow & { fact: RowFact })[] = model.rows.map((row) => {
    const fact = projectRowFact(row)
    return {
      id: row.id,
      visibleTargetText: fact.handle,
      action: fact.action.kind,
      target: row.target,
      fact,
    }
  })
  const filter = applyFilter(factRows, opts.filterText ?? '')

  const groups = groupTriageRows(
    filter.rows.map((row) => ({
      id: row.id,
      displayState: row.fact.displayState,
      hasValidContinuation: row.fact.hasValidContinuation,
      lastActivityAt: row.fact.source.last.at,
    }))
  )
  const factById = new Map(filter.rows.map((row) => [row.id, row.fact]))

  const collapseIdle = !opts.showAll && !filter.active
  const sections: { bucket: HrcTopTriageBucket; rows: RowFact[] }[] = []
  const orderedFacts: RowFact[] = []
  let idleCollapsed: { count: number } | undefined

  for (const group of groups) {
    const rows = group.rows
      .map((row) => factById.get(row.id))
      .filter((fact): fact is RowFact => fact !== undefined)
    if (group.bucket === 'idle' && collapseIdle) {
      idleCollapsed = { count: rows.length }
      continue
    }
    sections.push({ bucket: group.bucket, rows })
    orderedFacts.push(...rows)
  }

  return {
    orderedFacts,
    sections,
    idleCollapsed,
    counts: triageCounts(
      filter.rows.map((row) => ({
        id: row.id,
        displayState: row.fact.displayState,
        hasValidContinuation: row.fact.hasValidContinuation,
      }))
    ),
    filterActive: filter.active,
    visibleRows: filter.visibleRows,
    totalRows: filter.totalRows,
  }
}

/**
 * Filtered visible-row identities in SOURCE order (Ph4 filter seam). Kept for the
 * filter/nav unit tests and as a filter primitive; the interactive loop uses
 * {@link selectVisibleTriageRowIds} so the cursor tracks the triage display order.
 */
export function selectFilteredVisibleRows(
  model: HrcTopReadModel,
  filterText: string | undefined
): { id: string }[] {
  const factRows = model.rows.map((row) => {
    const fact = projectRowFact(row)
    return {
      id: row.id,
      visibleTargetText: fact.handle,
      action: fact.action.kind,
      target: row.target,
    }
  })
  return applyFilter(factRows, filterText ?? '').rows.map((row) => ({ id: row.id }))
}

/**
 * Triage-ordered, collapse-aware visible row identities for the TUI nav-state.
 * This is the seam the interactive loop feeds to `reduceNavState` so movement and
 * marks operate on exactly the rows the triage board renders (collapsed idle
 * rows are not navigable until `.` reveals them).
 */
export function selectVisibleTriageRowIds(
  model: HrcTopReadModel,
  opts: { filterText?: string | undefined; showAll?: boolean | undefined } = {}
): { id: string }[] {
  return computeTriageView(model, opts).orderedFacts.map((fact) => ({ id: fact.source.id }))
}

// -- Screen model -------------------------------------------------------------

export function buildTopScreenModel(input: HrcTopRenderInput): HrcTopScreenModel {
  const width = Math.max(60, input.width ?? 100)
  const view = computeTriageView(input.model, {
    filterText: input.filterText,
    showAll: input.showAll,
  })

  const renderedRows = view.orderedFacts.map((fact) => renderRowModel(fact, input.navState))
  const sections: HrcTopTriageSection[] = view.sections.map((section) => ({
    bucket: section.bucket,
    label: SECTION_LABELS[section.bucket],
    rows: section.rows.map((fact) => renderRowModel(fact, input.navState)),
  }))

  const selected = renderedRows.find((row) => row.selected) ?? renderedRows[0]
  const selectedFact = selected
    ? view.orderedFacts.find((fact) => fact.source.id === selected.id)
    : undefined

  return {
    title: 'HRC TOP',
    counts: input.model.counts,
    triageCounts: view.counts,
    rows: renderedRows,
    sections,
    idleCollapsed: view.idleCollapsed,
    selected,
    focus: selectedFact ? focusPanelForFact(selectedFact) : undefined,
    filterText: input.filterText ?? '',
    filterActive: view.filterActive,
    filterMode: input.filterMode ?? false,
    commandMode: input.commandMode ?? false,
    commandText: input.commandText ?? '',
    focusMode: input.focusMode ?? false,
    showAll: input.showAll ?? false,
    totalRows: view.totalRows,
    visibleRows: view.visibleRows,
    refreshedAt: input.model.refreshedAt,
    width,
    viewportHeight: Math.max(8, input.viewportHeight),
    color: input.color ?? false,
    showHelp: input.showHelp ?? false,
    notice: input.notice,
  }
}

function renderRowModel(fact: RowFact, navState: HrcTopNavState): HrcTopRenderedRow {
  return {
    id: fact.source.id,
    selected: fact.source.id === navState.selectedRowId,
    handle: fact.handle,
    displayState: fact.displayState,
    last: formatLast(fact.source.last.at),
    action: fact.action,
    bucket: fact.bucket,
    glyph: gutterGlyphFor(fact),
    idle: !isActionableBucket(fact.bucket),
  }
}

function focusPanelForFact(fact: RowFact): HrcTopFocusPanelModel {
  return buildFocusPanelModel({
    handle: fact.handle,
    target: fact.source.target,
    displayState: fact.displayState,
    operatorAttachable: fact.operatorAttachable,
    hasValidContinuation: fact.hasValidContinuation,
    latestEventSummary: latestEventSummary(fact.source),
    disabledActions: disabledActionsFor(fact),
  })
}

// -- Serialization ------------------------------------------------------------

const COL = { handle: 40, state: 9, last: 5, action: 9 } as const

export function renderTopScreen(input: HrcTopRenderInput): string {
  return renderTopScreenModel(buildTopScreenModel(input))
}

export function renderTopScreenModel(screen: HrcTopScreenModel): string {
  const painter = createPainter(screen.color)
  if (screen.focusMode && screen.selected && screen.focus) {
    return `${renderFocusLens(screen, painter).join('\n')}\n`
  }
  return `${renderBoard(screen, painter).join('\n')}\n`
}

type BodyLine = { text: string; selected: boolean; sectionHeader?: string | undefined }

function renderBoard(screen: HrcTopScreenModel, p: Painter): string[] {
  const header: string[] = [renderTriageStrip(screen, p), '', renderColumnHeader(p)]

  const footer: string[] = ['', p.paint('─'.repeat(screen.width), { fg: PALETTE.rule })]
  footer.push(...renderFooter(screen, p))

  const body: BodyLine[] = []
  if (screen.sections.length === 0 && !screen.idleCollapsed) {
    body.push({
      text: p.paint('  no targets need you right now.', { fg: PALETTE.dim }),
      selected: false,
    })
  }
  for (const section of screen.sections) {
    const sectionHeader = renderSectionHeader(section, p)
    body.push({ text: sectionHeader, selected: false })
    for (const row of section.rows) {
      body.push({ text: renderRow(row, p), selected: row.selected, sectionHeader })
    }
  }
  if (screen.idleCollapsed) {
    body.push({
      text: p.paint(`  ▸ ${screen.idleCollapsed.count} idle · press . to show`, {
        fg: PALETTE.dim,
      }),
      selected: false,
    })
  }

  // Reserve a small safety margin so a full-height frame's trailing newline (and
  // any PTY winsize vs visible-rows discrepancy) does not scroll the pinned
  // triage strip off the top.
  const bodyHeight = Math.max(1, screen.viewportHeight - header.length - footer.length - 3)
  const windowed = windowBody(body, bodyHeight)
  return [...header, ...windowed.map((line) => line.text), ...footer]
}

/**
 * Window the body around the selected row so the triage strip, column header, and
 * footer stay pinned. When the window opens mid-section, the active section header
 * is re-injected at the top so the operator never loses group context.
 */
function windowBody(body: BodyLine[], height: number): BodyLine[] {
  if (body.length <= height) return body

  const selectedIndex = body.findIndex((line) => line.selected)
  const anchor = selectedIndex < 0 ? 0 : selectedIndex
  const start = Math.min(
    Math.max(0, anchor - Math.floor(height / 2)),
    Math.max(0, body.length - height)
  )
  const windowed = body.slice(start, start + height)

  const first = windowed[0]
  if (first && first.sectionHeader !== undefined && first.text !== first.sectionHeader) {
    return [{ text: first.sectionHeader, selected: false }, ...windowed.slice(1)]
  }
  return windowed
}

function renderTriageStrip(screen: HrcTopScreenModel, p: Painter): string {
  const c = screen.triageCounts
  const segments: string[] = []
  const seg = (bucket: HrcTopTriageBucket, count: number, label: string) => {
    const color = bucket === 'idle' ? PALETTE.dim : stateColorHex(bucketState(bucket))
    return `${p.paint(STRIP_GLYPH[bucket], { fg: color })} ${p.paint(`${count}`, { fg: color, bold: bucket !== 'idle' })} ${p.paint(label, { fg: PALETTE.dim })}`
  }
  segments.push(seg('needsYou', c.needsYou, 'need you'))
  segments.push(seg('working', c.working, 'busy'))
  segments.push(seg('resumable', c.resumable, 'resumable'))
  if (c.attention > 0) segments.push(seg('attention', c.attention, 'attention'))
  segments.push(seg('idle', c.idle, 'idle'))

  const title = p.paint('HRC TOP', { fg: PALETTE.ghost, bold: true })
  const dot = p.paint(' · ', { fg: PALETTE.ghost })
  return `${title}   ${segments.join(dot)}`
}

function renderColumnHeader(p: Painter): string {
  const header = `   ${pad('target', COL.handle)}  ${pad('state', COL.state)}  ${pad('last', COL.last)}  action`
  return p.paint(header, { fg: PALETTE.ghost })
}

function renderSectionHeader(section: HrcTopTriageSection, p: Painter): string {
  const color =
    section.bucket === 'idle' ? PALETTE.faint : stateColorHex(bucketState(section.bucket))
  const glyph = p.paint(STRIP_GLYPH[section.bucket], { fg: color })
  const label = p.paint(section.label, { fg: PALETTE.dim, bold: true })
  const count = p.paint(`${section.rows.length}`, { fg: PALETTE.ghost })
  return `${glyph} ${label} ${count}`
}

type Cell = { text: string; fg?: string | undefined; bold?: boolean | undefined }

function renderRow(row: HrcTopRenderedRow, p: Painter): string {
  const stateHex = stateColorHex(row.displayState)
  const idle = row.idle
  // Idle rows recede to the faint tier across the whole row; actionable rows use
  // the luminance hierarchy (state color > ink handle > dim metadata).
  const glyphFg = idle ? PALETTE.faint : stateHex
  const handleFg = idle ? PALETTE.faint : PALETTE.ink
  const metaFg = idle ? PALETTE.faint : PALETTE.dim
  const stateFg = idle ? PALETTE.faint : stateHex
  const actionFg = idle ? PALETTE.faint : PALETTE.dim

  const marker: Cell = row.selected ? { text: '▌', fg: stateHex, bold: true } : { text: ' ' }
  const caret: Cell = row.selected ? { text: '▸', fg: PALETTE.ink, bold: true } : { text: ' ' }

  const cells: Cell[] = [
    marker,
    caret,
    { text: row.glyph, fg: glyphFg },
    { text: ' ' },
    { text: pad(row.handle, COL.handle), fg: handleFg, bold: row.selected && !idle },
    { text: '  ' },
    { text: pad(row.displayState, COL.state), fg: stateFg, bold: !idle },
    { text: '  ' },
    { text: pad(row.last, COL.last), fg: metaFg },
    { text: '  ' },
    { text: pad(row.action.kind, COL.action), fg: actionFg },
  ]

  return serializeRow(cells, p, row.selected)
}

/**
 * Serialize row cells. A selected row carries a continuous elevated background:
 * the bg is opened once, each styled cell resets only fg+intensity (`22;39`) so
 * the bg survives across separators, and a single reset closes the line.
 */
function serializeRow(cells: Cell[], p: Painter, selected: boolean): string {
  if (!p.enabled) return cells.map((cell) => cell.text).join('')

  if (!selected) {
    return cells.map((cell) => p.paint(cell.text, { fg: cell.fg, bold: cell.bold })).join('')
  }

  const ESC = String.fromCharCode(27)
  const [br, bg, bb] = rgb(PALETTE.selectedBg)
  const open = `${ESC}[48;2;${br};${bg};${bb}m`
  const parts: string[] = [open]
  for (const cell of cells) {
    const codes: string[] = []
    if (cell.bold) codes.push('1')
    if (cell.fg) {
      const [r, g, b] = rgb(cell.fg)
      codes.push(`38;2;${r};${g};${b}`)
    }
    if (codes.length > 0) parts.push(`${ESC}[${codes.join(';')}m${cell.text}${ESC}[22;39m`)
    else parts.push(cell.text)
  }
  parts.push(`${ESC}[0m`)
  return parts.join('')
}

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return [r, g, b]
}

function renderFooter(screen: HrcTopScreenModel, p: Painter): string[] {
  const lines: string[] = []
  const counts = `filter: ${screen.filterText || 'none'}   rows: ${screen.visibleRows}/${screen.totalRows}`
  lines.push(p.paint(counts, { fg: PALETTE.dim }))

  if (screen.filterMode) {
    lines.push(`/${screen.filterText}█   (Enter/Esc keep filter, Backspace edits)`)
  }
  if (screen.commandMode) {
    lines.push(`:${screen.commandText}█`)
  }

  if (screen.notice) lines.push(p.paint(`notice: ${screen.notice}`, { fg: PALETTE.stale }))

  const hint = screen.showAll
    ? 'j/k move · enter focus · o act · / filter · . collapse · q quit'
    : 'j/k move · enter focus · o act · / filter · . show all · q quit'
  lines.push(p.paint(hint, { fg: PALETTE.ghost }))

  if (screen.showHelp) {
    lines.push(
      p.paint(
        "gg/G top/bottom · Ctrl-d/u half-page · Ctrl-f/b page · m<char> mark · '<char> jump · : command",
        { fg: PALETTE.ghost }
      )
    )
  }
  return lines
}

// -- Focus lens ---------------------------------------------------------------

function renderFocusLens(screen: HrcTopScreenModel, p: Painter): string[] {
  const focus = screen.focus
  const row = screen.selected
  if (!focus || !row) return renderBoard(screen, p)

  const stateHex = stateColorHex(row.displayState)
  const lines: string[] = []

  lines.push(
    `${p.paint('◱ FOCUS', { fg: PALETTE.ghost, bold: true })}  ${p.paint(focus.handle, { fg: PALETTE.ink, bold: true })}  ${p.paint(`~${focus.lane}`, { fg: PALETTE.dim })}`
  )
  lines.push('')
  lines.push(labelLine('state', row.displayState, p, { valueFg: stateHex, bold: true }))
  lines.push(labelLine('runtime', runtimeDetail(focus), p))
  lines.push(labelLine('host', focus.hostSessionId ?? '', p))
  lines.push(labelLine('continuation', continuationDetail(focus), p))
  lines.push(labelLine('latest', focus.latestEventSummary, p))
  lines.push('')

  // Recommended action box (accent-barred).
  const bar = p.paint('▌', { fg: stateHex, bold: true })
  const rec = focus.primaryAction
  lines.push(
    `${bar} ${p.paint('RECOMMENDED', { fg: PALETTE.ghost, bold: true })}  ${p.paint(rec.kind, { fg: stateHex, bold: true })}`
  )
  lines.push(`${bar} ${p.paint(rec.reason, { fg: PALETTE.dim })}`)
  if (focus.commandPreview) {
    lines.push(`${bar} ${p.paint(`$ ${focus.commandPreview.join(' ')}`, { fg: PALETTE.ink })}`)
  }
  lines.push('')

  // Enabled + disabled actions.
  lines.push(renderEnabledActions(row, focus, p))
  for (const disabled of focus.disabledActions) {
    const key = ACTION_KEYS[disabled.kind] ?? ''
    lines.push(
      p.paint(`  ${key ? `${key} ` : ''}${disabled.kind} — ${disabled.reason}`, {
        fg: PALETTE.faint,
      })
    )
  }

  if (focus.ambiguityCandidates.length > 0) {
    lines.push('')
    lines.push(p.paint('candidates', { fg: PALETTE.ghost }))
    for (const candidate of focus.ambiguityCandidates) {
      lines.push(p.paint(`  ${candidate.runtimeId}  ${candidate.label}`, { fg: PALETTE.dim }))
    }
  }

  lines.push('')
  lines.push(p.paint('─'.repeat(screen.width), { fg: PALETTE.rule }))
  lines.push(p.paint(renderFocusFooter(row, focus), { fg: PALETTE.ghost }))
  if (screen.notice) lines.push(p.paint(`notice: ${screen.notice}`, { fg: PALETTE.stale }))
  return lines
}

const ACTION_KEYS: Record<string, string> = {
  attach: 'a',
  resume: 'r',
  run: 'R',
  capture: 'c',
  tail: 'e',
  inspect: 'i',
}

function renderEnabledActions(
  row: HrcTopRenderedRow,
  focus: HrcTopFocusPanelModel,
  p: Painter
): string {
  return `  ${enabledActionEntries(row, focus)
    .map((entry) => p.paint(entry, { fg: PALETTE.ready }))
    .join('   ')}`
}

function renderFocusFooter(row: HrcTopRenderedRow, focus: HrcTopFocusPanelModel): string {
  const entries = ['q return']
  if (row.action.kind !== 'unavailable') entries.push('o act')
  entries.push(...enabledActionEntries(row, focus))
  return entries.join(' · ')
}

function enabledActionEntries(row: HrcTopRenderedRow, focus: HrcTopFocusPanelModel): string[] {
  const disabledKinds = new Set(focus.disabledActions.map((action) => action.kind))
  const enabled: string[] = ['enter focus', 'i inspect', 'e tail']
  if (!disabledKinds.has('attach') && row.action.kind === 'attach') enabled.unshift('a attach')
  if (!disabledKinds.has('resume')) enabled.push('r resume')
  if (!disabledKinds.has('run')) enabled.push('R run')
  if (!disabledKinds.has('capture')) enabled.push('c capture')
  return enabled
}

function runtimeDetail(focus: HrcTopFocusPanelModel): string {
  if (!focus.latestRuntimeId) return ''
  const bits = [focus.latestRuntimeId]
  if (focus.transport) bits.push(focus.transport)
  bits.push(focus.operatorAttachable ? 'attachable' : 'not attachable')
  return bits.join(' · ')
}

function continuationDetail(focus: HrcTopFocusPanelModel): string {
  if (!focus.continuationProvider) return ''
  const key = focus.continuationKey ? focus.continuationKey : 'no key'
  const captured = focus.continuationCaptured ? 'captured' : 'not captured'
  return `${focus.continuationProvider} · ${key} · ${captured}`
}

function labelLine(
  label: string,
  value: string,
  p: Painter,
  opts: { valueFg?: string | undefined; bold?: boolean | undefined } = {}
): string {
  const rendered = value
    ? p.paint(value, { fg: opts.valueFg ?? PALETTE.dim, bold: opts.bold })
    : p.paint('—', { fg: PALETTE.faint })
  return `${p.paint(label.padEnd(12), { fg: PALETTE.ghost })} ${rendered}`
}

// -- Helpers ------------------------------------------------------------------

function bucketState(bucket: HrcTopTriageBucket): HrcTargetOperatorDisplayState {
  switch (bucket) {
    case 'needsYou':
      return 'input'
    case 'working':
      return 'busy'
    case 'resumable':
      return 'dormant'
    case 'attention':
      return 'broken'
    case 'idle':
      return 'ready'
  }
}

function disabledActionsFor(
  fact: RowFact
): readonly { kind: 'attach' | 'resume' | 'run' | 'capture'; reason: string }[] {
  const disabled: { kind: 'attach' | 'resume' | 'run' | 'capture'; reason: string }[] = []
  if (!fact.operatorAttachable)
    disabled.push({
      kind: 'attach',
      reason: 'Attach is unavailable: no live operator-attachable runtime exists.',
    })
  if (!fact.hasValidContinuation)
    disabled.push({
      kind: 'resume',
      reason:
        'Resume is unavailable: no captured, non-invalidated continuation exists. ' +
        'hrc top will not fall back to a fresh launch.',
    })
  if (fact.action.kind !== 'run') {
    disabled.push({
      kind: 'run',
      reason: 'Run is unavailable: policy does not allow a fresh launch for this row.',
    })
  }
  if (
    !fact.source.target.runtime?.runtimeId ||
    fact.source.target.runtime?.supportsCapture === false
  )
    disabled.push({
      kind: 'capture',
      reason: 'Capture is unavailable: no runtime capture surface exists.',
    })
  return disabled
}

/**
 * Latest activity, sourced ONLY from the read-model's real `lastActivityAt`.
 * No fabrication: when the read-model carries no activity fact, the focus lens
 * shows an honest absence rather than inventing a summary.
 */
function latestEventSummary(row: HrcTopRow): string {
  if (row.last.at) return `last activity ${formatLast(row.last.at)} ago (${row.last.at})`
  return 'no recorded activity'
}

/**
 * `last` renders ONLY from the real `lastActivityAt` timestamp. When absent it is
 * BLANK — never the literal "unknown", never fabricated.
 */
function formatLast(value: string | undefined): string {
  if (!value) return ''
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
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value
  return clipped.padEnd(width)
}
