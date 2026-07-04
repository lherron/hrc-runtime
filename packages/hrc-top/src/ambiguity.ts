import type { HrcTargetAmbiguityCandidateView, HrcTargetRuntimeView, HrcTargetView } from 'hrc-core'

import { handleForRow } from './commands.js'
import { projectTargetRow } from './read-model.js'
import type { HrcTopRow } from './read-model.js'

export type HrcTopAmbiguityAction = 'attach' | 'inspect'

export type HrcTopAmbiguitySourceIdentity = {
  rowId?: string | undefined
  sessionRef: string
  activeHostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
}

export type HrcTopAmbiguityCandidate = {
  runtimeId?: string | undefined
  label: string
  command?: string[] | undefined
  attachable: boolean
  disabledReason?: string | undefined
  source: HrcTopAmbiguitySourceIdentity
  row: HrcTopRow
}

export type HrcTopAmbiguityGroup = {
  handle: string
  ambiguous: boolean
  attachCandidates: readonly HrcTopAmbiguityCandidate[]
  inspectCandidates: readonly HrcTopAmbiguityCandidate[]
}

export type HrcTopAmbiguityModel = {
  byHandle: ReadonlyMap<string, HrcTopAmbiguityGroup>
  byRowId: ReadonlyMap<string, HrcTopAmbiguityGroup>
}

const TERMINAL_RUNTIME_STATUSES = new Set([
  'terminated',
  'terminal',
  'dead',
  'exited',
  'stopped',
  'failed',
])

export function buildHrcTopAmbiguityModel(rows: readonly HrcTopRow[]): HrcTopAmbiguityModel {
  const candidatesByHandle = new Map<string, HrcTopAmbiguityCandidate[]>()

  for (const row of rows) {
    const handle = handleForRow(row)
    pushCandidate(candidatesByHandle, handle, candidateFromRow(row, row.id))

    for (const hidden of row.target.ambiguityCandidates ?? []) {
      pushCandidate(candidatesByHandle, handle, candidateFromTargetCandidate(hidden))
    }
  }

  const byHandle = new Map<string, HrcTopAmbiguityGroup>()
  const byRowId = new Map<string, HrcTopAmbiguityGroup>()

  for (const [handle, rawCandidates] of candidatesByHandle) {
    const candidates = dedupeCandidates(rawCandidates).sort(compareCandidates)
    const inspectCandidates = candidates.filter((candidate) => isInspectable(candidate.row.target))
    const attachCandidates = candidates
    const ambiguous = inspectCandidates.length > 1 || attachCandidates.length > 1
    if (!ambiguous) continue

    const group: HrcTopAmbiguityGroup = {
      handle,
      ambiguous,
      attachCandidates,
      inspectCandidates,
    }
    byHandle.set(handle, group)
    for (const candidate of candidates) {
      byRowId.set(candidate.row.id, group)
    }
  }

  return { byHandle, byRowId }
}

export function ambiguityGroupForRow(
  model: HrcTopAmbiguityModel,
  row: HrcTopRow
): HrcTopAmbiguityGroup | undefined {
  return model.byRowId.get(row.id) ?? model.byHandle.get(handleForRow(row))
}

export function candidatesForAmbiguousAction(
  group: HrcTopAmbiguityGroup | undefined,
  action: HrcTopAmbiguityAction
): readonly HrcTopAmbiguityCandidate[] {
  if (!group?.ambiguous) return []
  return action === 'attach' ? group.attachCandidates : group.inspectCandidates
}

export function actionNeedsAmbiguityResolution(
  group: HrcTopAmbiguityGroup | undefined,
  action: HrcTopAmbiguityAction
): boolean {
  return candidatesForAmbiguousAction(group, action).length > 1
}

export function sameAmbiguitySource(
  left: HrcTopAmbiguitySourceIdentity,
  right: HrcTopAmbiguitySourceIdentity
): boolean {
  return (
    left.rowId === right.rowId &&
    left.sessionRef === right.sessionRef &&
    left.activeHostSessionId === right.activeHostSessionId &&
    left.generation === right.generation &&
    left.runtimeId === right.runtimeId
  )
}

function pushCandidate(
  candidatesByHandle: Map<string, HrcTopAmbiguityCandidate[]>,
  handle: string,
  candidate: HrcTopAmbiguityCandidate
): void {
  const candidates = candidatesByHandle.get(handle)
  if (candidates) candidates.push(candidate)
  else candidatesByHandle.set(handle, [candidate])
}

function candidateFromRow(row: HrcTopRow, rowId: string | undefined): HrcTopAmbiguityCandidate {
  return candidateForTarget(row.target, row, rowId)
}

function candidateFromTargetCandidate(
  candidate: HrcTargetAmbiguityCandidateView
): HrcTopAmbiguityCandidate {
  const target: HrcTargetView = {
    sessionRef: candidate.sessionRef,
    scopeRef: candidate.scopeRef,
    laneRef: candidate.laneRef,
    state: candidate.state,
    activeHostSessionId: candidate.activeHostSessionId,
    generation: candidate.generation,
    runtime: candidate.runtime,
    capabilities: {
      state: candidate.state,
      modesSupported: candidate.runtime
        ? [candidate.runtime.transport === 'sdk' ? 'nonInteractive' : 'headless']
        : [],
      defaultMode: candidate.runtime
        ? candidate.runtime.transport === 'sdk'
          ? 'nonInteractive'
          : 'headless'
        : 'none',
      dmReady: candidate.runtime !== undefined,
      sendReady: candidate.runtime?.supportsLiteralSend ?? false,
      peekReady: candidate.runtime?.supportsCapture ?? false,
    },
  }
  return candidateForTarget(target, projectTargetRow(target), undefined)
}

function candidateForTarget(
  target: HrcTargetView,
  row: HrcTopRow,
  rowId: string | undefined
): HrcTopAmbiguityCandidate {
  const runtime = target.runtime
  const runtimeId = runtime?.runtimeId
  const attachable =
    runtimeId !== undefined && runtimeAttachable(runtime) && !runtimeTerminal(runtime)
  return {
    runtimeId,
    label: candidateLabel(target),
    ...(attachable && runtimeId ? { command: ['hrc', 'attach', runtimeId] } : {}),
    attachable,
    disabledReason: attachable ? undefined : disabledAttachReason(runtime),
    source: {
      rowId,
      sessionRef: target.sessionRef,
      activeHostSessionId: target.activeHostSessionId,
      generation: target.generation,
      runtimeId,
    },
    row,
  }
}

function dedupeCandidates(
  candidates: readonly HrcTopAmbiguityCandidate[]
): HrcTopAmbiguityCandidate[] {
  const seen = new Map<string, HrcTopAmbiguityCandidate>()
  for (const candidate of candidates) {
    const key = [
      candidate.source.sessionRef,
      candidate.source.activeHostSessionId ?? '',
      candidate.source.generation ?? '',
      candidate.source.runtimeId ?? '',
    ].join('\0')
    if (!seen.has(key)) seen.set(key, candidate)
  }
  return Array.from(seen.values())
}

function compareCandidates(a: HrcTopAmbiguityCandidate, b: HrcTopAmbiguityCandidate): number {
  const attachable = Number(b.attachable) - Number(a.attachable)
  if (attachable !== 0) return attachable

  const aLive = Number(a.runtimeId !== undefined && !runtimeTerminal(a.row.target.runtime))
  const bLive = Number(b.runtimeId !== undefined && !runtimeTerminal(b.row.target.runtime))
  if (aLive !== bLive) return bLive - aLive

  const generation = (b.source.generation ?? -1) - (a.source.generation ?? -1)
  if (generation !== 0) return generation

  const activity = compareIsoDesc(
    a.row.target.runtime?.lastActivityAt,
    b.row.target.runtime?.lastActivityAt
  )
  if (activity !== 0) return activity

  return sourceSortKey(a.source).localeCompare(sourceSortKey(b.source))
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NaN
  const rightMs = right ? Date.parse(right) : Number.NaN
  const leftValid = !Number.isNaN(leftMs)
  const rightValid = !Number.isNaN(rightMs)
  if (leftValid !== rightValid) return leftValid ? -1 : 1
  if (!leftValid || leftMs === rightMs) return 0
  return rightMs - leftMs
}

function sourceSortKey(source: HrcTopAmbiguitySourceIdentity): string {
  return [
    source.runtimeId ?? '',
    source.activeHostSessionId ?? '',
    source.generation ?? '',
    source.sessionRef,
  ].join(':')
}

function candidateLabel(target: HrcTargetView): string {
  const runtime = target.runtime
  const parts = [
    runtime?.runtimeId ?? 'no-runtime',
    runtime?.status,
    runtime?.transport,
    runtime?.presentation,
    target.activeHostSessionId ? `host=${target.activeHostSessionId}` : undefined,
    target.generation !== undefined ? `gen=${target.generation}` : undefined,
    runtime?.lastActivityAt ? `last=${runtime.lastActivityAt}` : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0)
  return parts.join(' ')
}

function runtimeAttachable(runtime: HrcTargetRuntimeView | undefined): boolean {
  if (!runtime) return false
  return runtime.operatorAttachable === true || runtime.presentation === 'tmux-tui'
}

function runtimeTerminal(runtime: HrcTargetRuntimeView | undefined): boolean {
  return runtime?.status !== undefined && TERMINAL_RUNTIME_STATUSES.has(runtime.status)
}

function disabledAttachReason(runtime: HrcTargetRuntimeView | undefined): string {
  if (!runtime?.runtimeId) return 'no concrete runtime id'
  if (runtimeTerminal(runtime)) return `runtime status ${runtime.status} is not attachable`
  return 'runtime is not operator-attachable'
}

function isInspectable(target: HrcTargetView): boolean {
  return target.runtime !== undefined || target.activeHostSessionId !== undefined
}
