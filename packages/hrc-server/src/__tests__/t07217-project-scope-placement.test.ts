import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { resolveNodeLocalPlacement } from '../federation/summon-capability.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE_REF = 'agent:mable:project:hrc-runtime:task:primary'
const SESSION_REF = `${SCOPE_REF}/lane:main`
const HOST_SESSION_ID = 'hsid-t07217-stale-placement'

describe('T-07217 project-scoped spawn placement', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let originalCwd: string
  let originalAgentsRoot: string | undefined
  let workspaceRoot: string
  let projectRoot: string
  let agentRoot: string

  beforeEach(async () => {
    fixture = await createHrcTestFixture('h7217-')
    originalCwd = process.cwd()
    originalAgentsRoot = process.env['ASP_AGENTS_ROOT']
    workspaceRoot = join(fixture.tmpDir, 'collective')
    projectRoot = join(workspaceRoot, 'hrc-runtime')
    agentRoot = join(workspaceRoot, 'var', 'agents', 'mable')

    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await mkdir(join(projectRoot, 'packages', 'hrc-server'), { recursive: true })
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n')

    workspaceRoot = await realpath(workspaceRoot)
    projectRoot = join(workspaceRoot, 'hrc-runtime')
    agentRoot = join(workspaceRoot, 'var', 'agents', 'mable')

    process.chdir(workspaceRoot)
    process.env['ASP_AGENTS_ROOT'] = join(workspaceRoot, 'var', 'agents')
  })

  afterEach(async () => {
    await server?.stop()
    process.chdir(originalCwd)
    if (originalAgentsRoot === undefined) {
      process.env['ASP_AGENTS_ROOT'] = undefined
    } else {
      process.env['ASP_AGENTS_ROOT'] = originalAgentsRoot
    }
    await fixture.cleanup()
  })

  test('node-local project placement always uses the checkout root as cwd', () => {
    const resolved = resolveNodeLocalPlacement(SCOPE_REF, {
      cwd: join(projectRoot, 'packages', 'hrc-server'),
      env: { ASP_AGENTS_ROOT: join(workspaceRoot, 'var', 'agents') },
    })

    expect(resolved.placement).toMatchObject({
      agentRoot,
      projectRoot,
      cwd: projectRoot,
    })
  })

  test('a local successor stops trusting a stale agent-home placement', async () => {
    const staleIntent: HrcRuntimeIntent = {
      placement: {
        agentRoot,
        cwd: agentRoot,
        runMode: 'task',
        bundle: { kind: 'agent-project', agentName: 'mable' },
        dryRun: false,
      },
      harness: { provider: 'anthropic', interactive: false, id: 'claude-code' },
      execution: { preferredMode: 'nonInteractive' },
    }
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.sessions.insert({
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        generation: 1,
        status: 'archived',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
        lastAppliedIntentJson: staleIntent,
        continuation: { provider: 'claude', kind: 'session', key: 'session-t07217' },
      })
      db.continuities.upsert({
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        activeHostSessionId: HOST_SESSION_ID,
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    server = await createHrcServer(fixture.serverOpts())
    const response = await fixture.postJson('/v1/sessions/create-successor', {
      sessionRef: SESSION_REF,
      priorHostSessionId: HOST_SESSION_ID,
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { hostSessionId: string }
    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const successor = verifyDb.sessions.getByHostSessionId(body.hostSessionId)
      expect(successor?.lastAppliedIntentJson?.placement).toMatchObject({
        agentRoot,
        projectRoot,
        cwd: projectRoot,
      })
    } finally {
      verifyDb.close()
    }
  })
})
