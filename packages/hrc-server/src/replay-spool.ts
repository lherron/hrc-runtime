import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcLaunchRecord, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  applyHookLifecycleEnvelope,
  buildStaleLaunchCallbackRejection,
  parseHookEnvelope,
  parseLaunchContinuationPayload,
  parseLaunchEventPayload,
  parseLaunchLifecyclePayload,
} from './hook-lifecycle.js'
import { appendHrcEvent, deriveSemanticTurnEventFromLaunchEvent } from './hrc-event-helper.js'
import { readSpoolEntries } from './launch/index.js'
import { requireSession } from './require-helpers.js'
import { findLatestRunForRuntime } from './runtime-select.js'
import { isRecord } from './server-parsers.js'
import type { HrcServerOptions } from './server-types.js'
import { timestamp, unlinkIfExists } from './server-util.js'
import { appendMissingHeadlessTurnCompleted, logStartupIssue } from './startup-reconcile.js'

export async function replaySpool(options: HrcServerOptions, db: HrcDatabase): Promise<void> {
  let launchIds: string[]
  try {
    launchIds = (await readdir(options.spoolDir)).sort()
  } catch {
    return
  }

  for (const launchId of launchIds) {
    const launchDir = join(options.spoolDir, launchId)
    const launchDirStat = await stat(launchDir).catch(() => null)
    if (!launchDirStat?.isDirectory()) {
      continue
    }

    const entries = await readSpoolEntries(options.spoolDir, launchId)
    let hadFailure = false
    for (const entry of entries) {
      try {
        await replaySpoolEntry(db, entry.payload)
        await unlinkIfExists(entry.path)
      } catch (error) {
        hadFailure = true
        logStartupIssue('spool replay failed', { launchId, path: entry.path }, error)
      }
    }

    if (!hadFailure) {
      await rm(launchDir, { recursive: true, force: true })
    }
  }
}

function appendReplaySemanticLaunchEvent(
  db: HrcDatabase,
  input: {
    launch: HrcLaunchRecord
    session: HrcSessionRecord
    runtime?: HrcRuntimeSnapshot | null | undefined
    runId?: string | undefined
    launchId: string
    ts: string
    semanticEvent: NonNullable<ReturnType<typeof deriveSemanticTurnEventFromLaunchEvent>>
  }
): void {
  const alreadyCompleted =
    input.semanticEvent.eventKind === 'turn.completed' &&
    input.runId !== undefined &&
    db.hrcEvents.listByRun(input.runId, { eventKind: 'turn.completed' }).length > 0
  if (alreadyCompleted) {
    return
  }

  appendHrcEvent(db, input.semanticEvent.eventKind, {
    ts: input.ts,
    hostSessionId: input.launch.hostSessionId,
    scopeRef: input.session.scopeRef,
    laneRef: input.session.laneRef,
    generation: input.launch.generation,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.runtime ? { runtimeId: input.runtime.runtimeId } : {}),
    launchId: input.launchId,
    replayed: true,
    ...(input.runtime?.transport === 'headless' ? { transport: 'headless' as const } : {}),
    payload: input.semanticEvent.payload,
  })
}

async function replaySpoolEntry(db: HrcDatabase, payload: unknown): Promise<void> {
  if (!isRecord(payload)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spool entry must be an object')
  }

  const endpoint = payload['endpoint']
  const replayPayload = payload['payload']
  if (typeof endpoint !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spool entry endpoint must be a string'
    )
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/wrapper-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/wrapper-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'wrapper-started')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(
      db,
      session,
      launchId,
      'wrapper_started',
      true
    )
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'wrapper_started',
      wrapperPid: body.wrapperPid,
      wrapperStartedAt: now,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        wrapperPid: replayedLaunch.wrapperPid,
        launchId,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.wrapper_started', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { wrapperPid: body.wrapperPid },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/child-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/child-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'child-started')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(
      db,
      session,
      launchId,
      'child_started',
      true
    )
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        childPid: replayedLaunch.childPid,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.child_started', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { childPid: body.childPid },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/continuation')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/continuation', '')
    const body = parseLaunchContinuationPayload(replayPayload)
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'continuation', true)
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    const replayedLaunch = upsertLaunch(db, launchId, session, {
      status: 'child_started',
      continuation: body.continuation,
      ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      updatedAt: now,
    })
    db.sessions.updateContinuation(session.hostSessionId, body.continuation, now)
    if (replayedLaunch.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.continuation_captured', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: replayedLaunch.runtimeId,
      launchId,
      replayed: true,
      payload: {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/event')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/event', '')
    const body = parseLaunchEventPayload(replayPayload)
    const launch = db.launches.getByLaunchId(launchId)
    if (!launch) {
      return
    }
    const session = requireSession(db, launch.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'event', true)
    if (rejection) {
      return
    }

    const now = timestamp()
    const runtime = launch.runtimeId ? db.runtimes.getByRuntimeId(launch.runtimeId) : null
    const runId = runtime ? findLatestRunForRuntime(db, runtime.runtimeId)?.runId : undefined
    db.events.append({
      ts: now,
      hostSessionId: launch.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: launch.generation,
      ...(runId ? { runId } : {}),
      ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
      source: 'hrc',
      eventKind: body.type,
      eventJson: body,
    })
    if (runtime) {
      db.runtimes.updateActivity(runtime.runtimeId, now, now)
    }
    const semanticEvent = deriveSemanticTurnEventFromLaunchEvent(body)
    if (semanticEvent) {
      appendReplaySemanticLaunchEvent(db, {
        launch,
        session,
        runtime,
        runId,
        launchId,
        ts: now,
        semanticEvent,
      })
    }
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/exited')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/exited', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'exited')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'exited', true)
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'exited',
      exitedAt: now,
      exitCode: body.exitCode,
      signal: body.signal,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      const runtime = db.runtimes.getByRuntimeId(replayedLaunch.runtimeId)
      const activeRunId = runtime?.activeRunId
      db.runtimes.updateRunId(replayedLaunch.runtimeId, undefined, now)
      db.runtimes.update(replayedLaunch.runtimeId, {
        status: 'ready',
        updatedAt: now,
        lastActivityAt: now,
      })
      if (activeRunId) {
        appendMissingHeadlessTurnCompleted(db, {
          session,
          runtime,
          runId: activeRunId,
          launchId,
          exitCode: body.exitCode,
          ts: now,
          replayed: true,
        })
        db.runs.markCompleted(activeRunId, {
          status: body.exitCode === 0 ? 'completed' : 'failed',
          completedAt: now,
          updatedAt: now,
          ...(body.exitCode === 0
            ? {}
            : {
                errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
                errorMessage: `launch exited with code ${body.exitCode ?? 'unknown'}`,
              }),
        })
      }
    }
    appendHrcEvent(db, 'launch.exited', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { exitCode: body.exitCode, signal: body.signal },
    })
    return
  }

  if (endpoint === '/v1/internal/hooks/ingest') {
    const envelope = parseHookEnvelope(replayPayload)
    applyHookLifecycleEnvelope(db, envelope, { replayed: true })
    return
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `unsupported spool endpoint "${endpoint}"`,
    { endpoint }
  )
}

export function upsertLaunch(
  db: HrcDatabase,
  launchId: string,
  session: HrcSessionRecord,
  patch: Partial<HrcLaunchRecord> & { updatedAt: string; status: string }
): HrcLaunchRecord {
  const existing = db.launches.getByLaunchId(launchId)
  if (existing) {
    return db.launches.update(launchId, patch) ?? existing
  }

  const now = patch.updatedAt
  const created = db.launches.insert({
    launchId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: '',
    status: patch.status,
    createdAt: now,
    updatedAt: now,
    ...(patch.wrapperPid !== undefined ? { wrapperPid: patch.wrapperPid } : {}),
    ...(patch.childPid !== undefined ? { childPid: patch.childPid } : {}),
    ...(patch.wrapperStartedAt !== undefined ? { wrapperStartedAt: patch.wrapperStartedAt } : {}),
    ...(patch.childStartedAt !== undefined ? { childStartedAt: patch.childStartedAt } : {}),
    ...(patch.exitedAt !== undefined ? { exitedAt: patch.exitedAt } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
  })

  return created
}
