import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcLifecycleEvent, HrcRunRecord, HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-startup-headless-orphan-')
})

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  await fixture.cleanup()
})

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString()
}

function getRun(runId: string): HrcRunRecord | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.getByRunId(runId)
  } finally {
    db.close()
  }
}

function getRuntime(runtimeId: string): HrcRuntimeSnapshot | null {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runtimes.getByRuntimeId(runtimeId)
  } finally {
    db.close()
  }
}

function listEvents(eventKind: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((event) => event.eventKind === eventKind)
  } finally {
    db.close()
  }
}

describe('startup reconciliation for headless orphaned launches', () => {
  it('reaps the active headless run immediately and stamps launch.orphaned with runId', async () => {
    const hostSessionId = 'hsid-startup-headless-orphan'
    const scopeRef = 'agent:startup-headless-orphan'
    const runtimeId = 'rt-startup-headless-orphan'
    const runId = 'run-startup-headless-orphan'
    const launchId = 'launch-startup-headless-orphan'
    const timestamp = isoMinutesAgo(60)

    fixture.seedSession(hostSessionId, scopeRef)
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'busy',
        launchId,
        activeRunId: runId,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      db.runs.insert({
        runId,
        hostSessionId,
        runtimeId,
        scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'headless',
        status: 'started',
        acceptedAt: timestamp,
        startedAt: timestamp,
        updatedAt: timestamp,
      })
      db.launches.insert({
        launchId,
        hostSessionId,
        generation: 1,
        runtimeId,
        harness: 'codex-cli',
        provider: 'openai',
        launchArtifactPath: `/tmp/${launchId}.json`,
        wrapperPid: 999999,
        childPid: 999999,
        status: 'child_started',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    server = await createHrcServer(fixture.serverOpts())

    expect(getRun(runId)).toMatchObject({
      status: 'failed',
      errorCode: 'runtime_unavailable_with_active_run',
    })
    expect(getRun(runId)?.completedAt).toBeDefined()
    expect(getRuntime(runtimeId)).toMatchObject({
      status: 'stale',
      activeRunId: undefined,
    })

    const orphaned = listEvents('launch.orphaned')
    expect(orphaned).toHaveLength(1)
    expect(orphaned[0]).toMatchObject({ runId, runtimeId, launchId })

    const reaped = listEvents('turn.reaped')
    expect(reaped).toHaveLength(1)
    expect(reaped[0]).toMatchObject({ runId, runtimeId })
    expect(reaped[0]?.payload).toMatchObject({
      reason: 'orphaned-headless',
      launchId,
      launchStatus: 'orphaned',
      runtimeOwnershipCleared: true,
    })
    expect(listEvents('turn.zombied')).toHaveLength(0)
  })
})
