/** T-08584: app-session ensure dry-run plans carry no `invocation` on either site. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EnsureAppSessionRequest, HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { handleEnsureAppSessionDryRun } from '../app-session-handlers'
import type { HrcServerInstanceForHandlers } from '../server-instance-context'

const NOW = '2026-09-17T19:00:00.000Z'
let root: string
let db: HrcDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't08584-dryrun-'))
  db = openHrcDatabase(join(root, 'state.sqlite'))
})

afterEach(async () => {
  db.close()
  await rm(root, { recursive: true, force: true })
})

function dryRunIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: '/tmp/t08584-agent',
      projectRoot: '/tmp/t08584-project',
      cwd: '/tmp/t08584-project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
      correlation: {
        sessionRef: {
          scopeRef: 'agent:mux:project:hrc-runtime:task:T-08584',
          laneRef: 'lane:main',
        },
        hostSessionId: 'hsid-t08584-preview',
        generation: 3,
        runId: 'run-t08584-preview',
      },
    },
    harness: { provider: 'anthropic', id: 'claude-code', interactive: true },
  } as HrcRuntimeIntent
}

function instance(): HrcServerInstanceForHandlers {
  return { db } as unknown as HrcServerInstanceForHandlers
}

async function dryRunPlan(body: EnsureAppSessionRequest): Promise<Record<string, unknown>> {
  const response = await handleEnsureAppSessionDryRun.call(instance(), body, body.spec)
  const payload = (await response.json()) as { dryRun: Record<string, unknown> }
  return payload.dryRun
}

describe('T-08584 app-session ensure dry-run carries no invocation', () => {
  it('fresh site: create plan with no invocation key', async () => {
    const plan = await dryRunPlan({
      selector: { appId: 't08584', appSessionKey: 'new' },
      spec: { kind: 'harness', runtimeIntent: dryRunIntent() },
      dryRun: true,
    })
    expect(plan['action']).toBe('create')
    expect(plan['sessionExists']).toBe(false)
    expect('invocation' in plan).toBe(false)
  })

  it('existing-session site: create plan with no invocation key', async () => {
    const hostSessionId = 'hsid-t08584-existing'
    db.sessions.insert({
      hostSessionId,
      scopeRef: 'app:t08584',
      laneRef: 'assistant',
      generation: 1,
      status: 'active',
      continuation: { provider: 'anthropic', key: `cont-${hostSessionId}` },
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    db.appManagedSessions.create({
      appId: 't08584',
      appSessionKey: 'existing',
      kind: 'harness',
      activeHostSessionId: hostSessionId,
      generation: 1,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const plan = await dryRunPlan({
      selector: { appId: 't08584', appSessionKey: 'existing' },
      spec: { kind: 'harness', runtimeIntent: dryRunIntent() },
      dryRun: true,
    })
    expect(plan['action']).toBe('create')
    expect(plan['sessionExists']).toBe(true)
    expect('invocation' in plan).toBe(false)
  })
})
