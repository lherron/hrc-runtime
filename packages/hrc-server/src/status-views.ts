import type {
  EnsureRuntimeResponse,
  HrcManagedSessionRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusActiveRuntimeView,
  HrcStatusSessionView,
  HrcStatusTmuxView,
  StartRuntimeResponse,
} from 'hrc-core'
import type { AppManagedSessionRecord, HrcDatabase } from 'hrc-store-sqlite'
import type { GhostmuxSurfaceState } from './ghostmux.js'
import {
  requireGhosttySurface,
  requireTmuxPane,
} from './require-helpers.js'
import { findLatestSessionRuntime } from './runtime-select.js'
import { isRuntimeUnavailableStatus } from './server-util.js'
import type { TmuxPaneState } from './tmux.js'

export function toManagedSessionRecord(record: AppManagedSessionRecord): HrcManagedSessionRecord {
  return {
    appId: record.appId,
    appSessionKey: record.appSessionKey,
    kind: record.kind,
    label: record.label,
    metadata: record.metadata,
    activeHostSessionId: record.activeHostSessionId,
    generation: record.generation,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removedAt: record.removedAt,
  }
}

export function toTmuxJson(tmuxPane: TmuxPaneState): Record<string, unknown> {
  return {
    socketPath: tmuxPane.socketPath,
    sessionName: tmuxPane.sessionName,
    windowName: tmuxPane.windowName,
    sessionId: tmuxPane.sessionId,
    windowId: tmuxPane.windowId,
    paneId: tmuxPane.paneId,
  }
}

export function toSurfaceJson(surface: GhostmuxSurfaceState): Record<string, unknown> {
  return {
    kind: 'ghostty',
    surfaceId: surface.surfaceId,
    title: surface.title,
    createdBy: surface.createdBy,
    ...(surface.anchorSurfaceId ? { anchorSurfaceId: surface.anchorSurfaceId } : {}),
  }
}

export function simplifySurfaceJson(
  surfaceJson: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!surfaceJson) {
    return {}
  }

  return {
    kind: surfaceJson['kind'],
    surfaceId: surfaceJson['surfaceId'],
    title: surfaceJson['title'],
    anchorSurfaceId: surfaceJson['anchorSurfaceId'],
  }
}

export function simplifyTmuxJson(
  tmuxJson: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!tmuxJson) {
    return {}
  }

  return {
    sessionId: tmuxJson['sessionId'],
    windowId: tmuxJson['windowId'],
    paneId: tmuxJson['paneId'],
  }
}

export function toStatusTmuxView(
  tmuxJson: Record<string, unknown> | undefined
): HrcStatusTmuxView | undefined {
  if (!tmuxJson) {
    return undefined
  }

  const tmux: HrcStatusTmuxView = {}
  const socketPath = tmuxJson['socketPath']
  const sessionName = tmuxJson['sessionName']
  const sessionId = tmuxJson['sessionId']
  const windowId = tmuxJson['windowId']
  const paneId = tmuxJson['paneId']

  if (typeof socketPath === 'string') tmux.socketPath = socketPath
  if (typeof sessionName === 'string') tmux.sessionName = sessionName
  if (typeof sessionId === 'string') tmux.sessionId = sessionId
  if (typeof windowId === 'string') tmux.windowId = windowId
  if (typeof paneId === 'string') tmux.paneId = paneId

  return Object.keys(tmux).length > 0 ? tmux : undefined
}

export function toStatusActiveRuntimeView(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): HrcStatusActiveRuntimeView {
  const tmux = runtime.transport === 'tmux' ? toStatusTmuxView(runtime.tmuxJson) : undefined

  return {
    runtime,
    surfaceBindings: db.surfaceBindings.findByRuntime(runtime.runtimeId),
    ...(tmux !== undefined ? { tmux } : {}),
  }
}

export function toStatusSessionView(
  db: HrcDatabase,
  session: HrcSessionRecord
): HrcStatusSessionView {
  const latestRuntime = findLatestSessionRuntime(db, session.hostSessionId)

  if (!latestRuntime || isRuntimeUnavailableStatus(latestRuntime.status)) {
    return { session }
  }

  return {
    session,
    activeRuntime: toStatusActiveRuntimeView(db, latestRuntime),
  }
}

export function toEnsureRuntimeResponse(runtime: HrcRuntimeSnapshot): EnsureRuntimeResponse {
  if (runtime.transport === 'ghostty') {
    const surface = requireGhosttySurface(runtime)
    return {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport: 'ghostty',
      status: runtime.status,
      supportsInFlightInput: runtime.supportsInflightInput,
      surface: {
        surfaceId: surface.surfaceId,
        ...(surface.title ? { title: surface.title } : {}),
      },
    }
  }

  if (runtime.controllerKind === 'harness-broker' && runtime.transport === 'tmux') {
    return {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport: 'tmux',
      status: runtime.status,
      supportsInFlightInput: runtime.supportsInflightInput,
    }
  }

  const tmux = requireTmuxPane(runtime)
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport: 'tmux',
    status: runtime.status,
    supportsInFlightInput: runtime.supportsInflightInput,
    tmux: {
      sessionId: tmux.sessionId,
      windowId: tmux.windowId,
      paneId: tmux.paneId,
    },
  }
}

export function toStartRuntimeResponse(runtime: HrcRuntimeSnapshot): StartRuntimeResponse {
  if (runtime.transport === 'headless') {
    return {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport: 'headless',
      status: runtime.status,
      supportsInFlightInput: runtime.supportsInflightInput,
    }
  }

  return toEnsureRuntimeResponse(runtime)
}
