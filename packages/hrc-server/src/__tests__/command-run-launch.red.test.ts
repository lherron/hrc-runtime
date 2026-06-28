import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HrcLifecycleEvent, HrcRunRecord } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.ts'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-command-run-launch-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

function listRuns(): HrcRunRecord[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.runs.listRuns({})
  } finally {
    db.close()
  }
}

function listEventsForRun(runId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).filter((event) => event.runId === runId)
  } finally {
    db.close()
  }
}

function requestFor(
  kind: 'success' | 'failure' | 'wait',
  idempotencyKey: string,
  stdinJson?: Record<string, unknown>
) {
  return {
    // T-05274/daedalus invariant: this is a server-side configured target name,
    // not caller-supplied command/argv/cwd/env material.
    configuredTargetId: `test-command-run-${kind}`,
    sessionRef: `agent:smokey/project:hrc-runtime/task:T-05274/lane:${kind}`,
    idempotencyKey,
    binding: {
      WRKF_TASK_ID: 'T-05274',
      WRKF_ACTION_RUN_ID: `action-run-${kind}`,
      WRKF_RUN_ID: `wrkf-run-${kind}`,
      WRKF_ACTION: 'validate',
      WRKF_ROLE: 'smokey',
      ASP_PROJECT: 'hrc-runtime',
      HRC_SESSION_REF: `agent:smokey/project:hrc-runtime/task:T-05274/lane:${kind}`,
      HRC_LANE: kind,
    },
    stdinJson: stdinJson ?? { expectedExit: kind === 'success' ? 0 : 42 },
  } as const
}

async function waitForRun(
  runId: string,
  predicate: (run: HrcRunRecord) => boolean,
  timeoutMs = 1000
): Promise<HrcRunRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = listRuns().find((candidate) => candidate.runId === runId)
    if (run !== undefined && predicate(run)) {
      return run
    }
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for command-run ${runId}`)
}

describe('POST /v1/command-runs/launch (T-05274 red)', () => {
  it('launches one configured command as a durable run attempt and records success vs failure lifecycle', async () => {
    const client = new HrcClient(fixture.socketPath)

    const success = await client.launchCommandScopedRun(requestFor('success', 'idem-success-1'))
    const failure = await client.launchCommandScopedRun(requestFor('failure', 'idem-failure-1'))
    const completedSuccess = await waitForRun(success.runId, (run) => run.status === 'completed')
    const completedFailure = await waitForRun(failure.runId, (run) => run.status === 'failed')

    expect(success.runId).toMatch(/^run-/)
    expect(success.runId).not.toBe(success.hostSessionId)
    expect(success.runId).not.toBe(success.runtimeId)
    expect(success.hostSessionId).toMatch(/^hsid-/)
    expect(success.runtimeId).toMatch(/^rt-/)
    expect(success.generation).toBeGreaterThanOrEqual(1)
    expect(success.transport).toBe('tmux')
    expect(success.replayed).toBe(false)

    expect(failure.runId).toMatch(/^run-/)
    expect(failure.runId).not.toBe(success.runId)
    expect(failure.transport).toBe('tmux')

    expect(completedSuccess).toMatchObject({
      runId: success.runId,
      hostSessionId: success.hostSessionId,
      runtimeId: success.runtimeId,
      generation: success.generation,
      transport: success.transport,
      status: 'completed',
    })
    expect(completedFailure).toMatchObject({
      runId: failure.runId,
      hostSessionId: failure.hostSessionId,
      runtimeId: failure.runtimeId,
      generation: failure.generation,
      transport: failure.transport,
      status: 'failed',
    })

    expect(listEventsForRun(success.runId).map((event) => event.eventKind)).toEqual(
      expect.arrayContaining(['command_run.started', 'command_run.exited'])
    )
    expect(listEventsForRun(success.runId).at(-1)).toMatchObject({
      eventKind: 'command_run.exited',
      payload: expect.objectContaining({ exitCode: 0 }),
    })
    expect(listEventsForRun(failure.runId).at(-1)).toMatchObject({
      eventKind: 'command_run.exited',
      payload: expect.objectContaining({ exitCode: 42 }),
    })
  })

  it('returns launch correlation before a long-running command process exits', async () => {
    const client = new HrcClient(fixture.socketPath)
    const releasePath = join(fixture.tmpDir, 'release-command-run')

    const launched = await client.launchCommandScopedRun(
      requestFor('wait', 'idem-wait-1', { releasePath })
    )

    expect(launched.runId).toMatch(/^run-/)
    expect(launched.hostSessionId).toMatch(/^hsid-/)
    expect(launched.runtimeId).toMatch(/^rt-/)
    expect(launched.transport).toBe('tmux')
    expect(launched.replayed).toBe(false)
    expect(listRuns().find((run) => run.runId === launched.runId)).toMatchObject({
      status: 'running',
      hostSessionId: launched.hostSessionId,
      runtimeId: launched.runtimeId,
    })

    await writeFile(releasePath, 'ok')
    await waitForRun(launched.runId, (run) => run.status === 'completed')
    expect(listEventsForRun(launched.runId).map((event) => event.eventKind)).toEqual(
      expect.arrayContaining(['command_run.started', 'command_run.exited'])
    )
  })

  it('replays a lost response for the same idempotency key without creating a second live command process', async () => {
    const client = new HrcClient(fixture.socketPath)
    const first = await client.launchCommandScopedRun(requestFor('success', 'idem-replay-1'))

    // Crash/lost-response contract: once HRC has accepted the dispatch, replaying
    // the same action idempotency key returns the same durable run attempt instead
    // of starting another live process for the same WRKF action run.
    const replay = await client.launchCommandScopedRun(requestFor('success', 'idem-replay-1'))

    expect(replay).toMatchObject({
      runId: first.runId,
      hostSessionId: first.hostSessionId,
      runtimeId: first.runtimeId,
      generation: first.generation,
      transport: first.transport,
      replayed: true,
    })

    const matchingRuns = listRuns().filter((run) => run.runId === first.runId)
    expect(matchingRuns).toHaveLength(1)

    const startEvents = listEventsForRun(first.runId).filter(
      (event) => event.eventKind === 'command_run.started'
    )
    expect(startEvents).toHaveLength(1)
  })
})
