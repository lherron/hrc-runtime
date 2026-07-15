import { parseSelector, splitSessionRef } from 'hrc-core'
import type { HrcRuntimeSnapshot, HrcSelector, HrcSessionRecord } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

export type SelectorTargetKind = 'runtime' | 'host-session' | 'message' | 'bridge'

export type RuntimeSnapshot = Pick<HrcRuntimeSnapshot, 'runtimeId' | 'scopeRef' | 'laneRef'> & {
  createdAt?: string | undefined
}

export type SessionSnapshot = Pick<HrcSessionRecord, 'hostSessionId' | 'scopeRef' | 'laneRef'>

export type SelectorSnapshot = {
  runtimes: RuntimeSnapshot[]
  sessions: SessionSnapshot[]
}

export type ResolvedRuntime = { kind: 'runtime'; runtimeId: string }
export type ResolvedSession = { kind: 'host-session'; hostSessionId: string }
export type ResolvedMessage =
  | { kind: 'message'; messageId: string }
  | { kind: 'message-seq'; seq: number }
export type ResolvedBridge = { kind: 'bridge'; bridgeId: string }
export type ResolvedTarget = ResolvedRuntime | ResolvedSession | ResolvedMessage | ResolvedBridge

export type SelectorResolutionErrorCode =
  | 'type-mismatch'
  | 'ambiguous'
  | 'not-found'
  | 'parse-error'

export class SelectorResolutionError extends Error {
  constructor(
    readonly code: SelectorResolutionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SelectorResolutionError'
  }
}

type SnapshotEntry = RuntimeSnapshot | SessionSnapshot

function acceptedForms(expect: SelectorTargetKind): string {
  switch (expect) {
    case 'runtime':
      return 'runtime selectors: raw runtimeId, runtime:<runtimeId>, scope:<scopeRef>, session:<sessionRef>, or bare target handle'
    case 'host-session':
      return 'host-session selectors: raw hostSessionId, host:<hostSessionId>, session:<sessionRef>, scope:<scopeRef>, or bare target handle'
    case 'message':
      return 'message selectors: msg:<messageId> or seq:<messageSeq>'
    case 'bridge':
      return 'bridge selectors: raw bridgeId'
  }
}

function selectorKindName(selector: HrcSelector): string {
  return selector.kind
}

function typeMismatch(rawArg: string, expect: SelectorTargetKind, received: string): never {
  throw new SelectorResolutionError(
    'type-mismatch',
    `selector "${rawArg}" resolved as ${received}; expected ${expect}. Accepted ${acceptedForms(expect)}`
  )
}

function notFound(rawArg: string, expect: SelectorTargetKind): never {
  throw new SelectorResolutionError(
    'not-found',
    `selector "${rawArg}" did not match any ${expect}. Accepted ${acceptedForms(expect)}`
  )
}

function ambiguous(
  rawArg: string,
  expect: SelectorTargetKind,
  matches: readonly SnapshotEntry[]
): never {
  const ids = matches.map((entry) =>
    'runtimeId' in entry
      ? `${entry.runtimeId} (${entry.laneRef})`
      : `${entry.hostSessionId} (${entry.laneRef})`
  )
  throw new SelectorResolutionError(
    'ambiguous',
    `selector "${rawArg}" matched multiple ${expect} targets: ${ids.join(', ')}`
  )
}

function parseCliSelector(rawArg: string): HrcSelector {
  try {
    // A canonical ScopeRef starts with `agent:`. The generic monitor parser
    // otherwise treats `agent` as an unknown selector prefix, while operator
    // commands have historically accepted both scope:<ref> and the bare ref.
    return parseSelector(rawArg.startsWith('agent:') ? `scope:${rawArg}` : rawArg)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SelectorResolutionError('parse-error', `invalid selector "${rawArg}": ${message}`)
  }
}

function exactNativeMatch(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot
): ResolvedRuntime | ResolvedSession | undefined {
  if (expect === 'runtime') {
    const runtime = snapshot.runtimes.find((entry) => entry.runtimeId === rawArg)
    return runtime ? { kind: 'runtime', runtimeId: runtime.runtimeId } : undefined
  }

  if (expect === 'host-session') {
    const session = snapshot.sessions.find((entry) => entry.hostSessionId === rawArg)
    return session ? { kind: 'host-session', hostSessionId: session.hostSessionId } : undefined
  }

  return undefined
}

function rejectOtherNativeId(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot
): void {
  if (expect !== 'runtime' && snapshot.runtimes.some((entry) => entry.runtimeId === rawArg)) {
    typeMismatch(rawArg, expect, 'runtimeId')
  }
  if (
    expect !== 'host-session' &&
    snapshot.sessions.some((entry) => entry.hostSessionId === rawArg)
  ) {
    typeMismatch(rawArg, expect, 'hostSessionId')
  }
}

function resolveUniqueRuntime(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot,
  predicate: (entry: RuntimeSnapshot) => boolean,
  latest = false
): ResolvedRuntime {
  if (expect !== 'runtime') {
    typeMismatch(rawArg, expect, 'scope/session target')
  }

  const matches = snapshot.runtimes.filter(predicate)
  if (matches.length === 0) {
    notFound(rawArg, expect)
  }
  if (matches.length > 1 && !latest) {
    ambiguous(rawArg, expect, matches)
  }
  const match = latest
    ? [...matches].sort(
        (left, right) =>
          Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '') ||
          right.runtimeId.localeCompare(left.runtimeId)
      )[0]
    : matches[0]
  if (!match) {
    notFound(rawArg, expect)
  }
  return { kind: 'runtime', runtimeId: match.runtimeId }
}

function resolveUniqueSession(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot,
  predicate: (entry: SessionSnapshot) => boolean
): ResolvedSession {
  if (expect !== 'host-session') {
    typeMismatch(rawArg, expect, 'scope/session target')
  }

  const matches = snapshot.sessions.filter(predicate)
  if (matches.length === 0) {
    notFound(rawArg, expect)
  }
  if (matches.length > 1) {
    ambiguous(rawArg, expect, matches)
  }
  const match = matches[0]
  if (!match) {
    notFound(rawArg, expect)
  }
  return { kind: 'host-session', hostSessionId: match.hostSessionId }
}

function hasExplicitLane(raw: string): boolean {
  return raw.includes('~')
}

function resolveScopeTarget(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot,
  scopeRef: string,
  latest = false
): ResolvedRuntime | ResolvedSession {
  if (expect === 'runtime') {
    return resolveUniqueRuntime(
      rawArg,
      expect,
      snapshot,
      (entry) => entry.scopeRef === scopeRef,
      latest
    )
  }
  if (expect === 'host-session') {
    return resolveUniqueSession(rawArg, expect, snapshot, (entry) => entry.scopeRef === scopeRef)
  }
  typeMismatch(rawArg, expect, 'scope')
}

function resolveSessionTarget(
  rawArg: string,
  expect: SelectorTargetKind,
  snapshot: SelectorSnapshot,
  scopeRef: string,
  laneRef: string,
  latest = false
): ResolvedRuntime | ResolvedSession {
  if (expect === 'runtime') {
    return resolveUniqueRuntime(
      rawArg,
      expect,
      snapshot,
      (entry) => entry.scopeRef === scopeRef && entry.laneRef === laneRef,
      latest
    )
  }
  if (expect === 'host-session') {
    return resolveUniqueSession(
      rawArg,
      expect,
      snapshot,
      (entry) => entry.scopeRef === scopeRef && entry.laneRef === laneRef
    )
  }
  typeMismatch(rawArg, expect, 'session')
}

export function resolveSelectorTarget(
  rawArg: string,
  opts: {
    expect: SelectorTargetKind
    snapshot: SelectorSnapshot
    latest?: boolean | undefined
  }
): ResolvedTarget {
  const raw = rawArg.trim()
  const exact = exactNativeMatch(raw, opts.expect, opts.snapshot)
  if (exact) {
    return exact
  }

  rejectOtherNativeId(raw, opts.expect, opts.snapshot)

  const selector = parseCliSelector(raw)

  switch (selector.kind) {
    case 'runtime':
      if (opts.expect !== 'runtime') typeMismatch(raw, opts.expect, selectorKindName(selector))
      return { kind: 'runtime', runtimeId: selector.runtimeId }

    case 'host':
      if (opts.expect !== 'host-session') typeMismatch(raw, opts.expect, selectorKindName(selector))
      return { kind: 'host-session', hostSessionId: selector.hostSessionId }

    case 'message':
      if (opts.expect !== 'message') typeMismatch(raw, opts.expect, selectorKindName(selector))
      return { kind: 'message', messageId: selector.messageId }

    case 'message-seq':
      if (opts.expect !== 'message') typeMismatch(raw, opts.expect, selectorKindName(selector))
      return { kind: 'message-seq', seq: selector.messageSeq }

    case 'scope':
      return resolveScopeTarget(raw, opts.expect, opts.snapshot, selector.scopeRef, opts.latest)

    case 'session': {
      const { scopeRef, laneRef } = splitSessionRef(selector.sessionRef)
      return resolveSessionTarget(raw, opts.expect, opts.snapshot, scopeRef, laneRef, opts.latest)
    }

    case 'target':
      if (hasExplicitLane(selector.raw)) {
        const { scopeRef, laneRef } = splitSessionRef(selector.sessionRef)
        return resolveSessionTarget(raw, opts.expect, opts.snapshot, scopeRef, laneRef, opts.latest)
      }
      return resolveScopeTarget(raw, opts.expect, opts.snapshot, selector.scopeRef, opts.latest)

    case 'stable':
    case 'concrete':
      typeMismatch(raw, opts.expect, selectorKindName(selector))
  }
}

export async function fetchSelectorSnapshot(client: HrcClient): Promise<SelectorSnapshot> {
  const [runtimes, sessions] = await Promise.all([client.listRuntimes(), client.listSessions()])
  return {
    runtimes: runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      createdAt: runtime.createdAt,
    })),
    sessions: sessions.map((session) => ({
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
    })),
  }
}

export async function resolveRuntimeArg(
  rawArg: string,
  client: HrcClient,
  options: { latest?: boolean | undefined } = {}
): Promise<string> {
  const target = resolveSelectorTarget(rawArg, {
    expect: 'runtime',
    snapshot: await fetchSelectorSnapshot(client),
    latest: options.latest,
  })
  if (target.kind !== 'runtime') {
    typeMismatch(rawArg, 'runtime', target.kind)
  }
  return target.runtimeId
}

export async function resolveSessionArg(rawArg: string, client: HrcClient): Promise<string> {
  const target = resolveSelectorTarget(rawArg, {
    expect: 'host-session',
    snapshot: await fetchSelectorSnapshot(client),
  })
  if (target.kind !== 'host-session') {
    typeMismatch(rawArg, 'host-session', target.kind)
  }
  return target.hostSessionId
}
