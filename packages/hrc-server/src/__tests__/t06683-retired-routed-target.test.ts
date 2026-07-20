import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createScopeRetirementRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE_REF = 'agent:cody:project:agent-control-plane:task:wrkq-refactor'
const SESSION_REF = `${SCOPE_REF}/lane:main`
const HOST_SESSION_ID = 'hsid-retired-routed-viewer'

describe('T-06683 retired routed target selection', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('h6683-')
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'svc', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: {
        consult: async () => ({ outcome: 'unbound' as const }),
        establish: async () => {
          throw new Error('retirement must refuse before registry establishment')
        },
      },
      policyFor: async () => ({
        placement: { pins: { 'agent-control-plane:wrkq-refactor': 'lab' } },
        claimsTask: false,
      }),
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    })

    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      // Reconciliation removed the archived predecessor, but a selectable
      // active viewer row remains. This is the exact branch that previously
      // dispatched a fresh local harness without consulting retirement.
      db.sessions.insert({
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.continuities.upsert({
        scopeRef: SCOPE_REF,
        laneRef: 'main',
        activeHostSessionId: HOST_SESSION_ID,
        updatedAt: now,
      })
      createScopeRetirementRepository(db.sqlite).retire({
        scopeRef: SCOPE_REF,
        retiredNodeId: 'svc',
        canonicalHomeNodeId: 'lab',
        canonicalPlacementEpoch: 1,
        reason: 'namespace_reconciliation',
        retiredAt: now,
      })
    } finally {
      db.close()
    }
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test('semantic DM refuses before selecting the active viewer or creating a runtime', async () => {
    const captured: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write

    let response: Response
    try {
      response = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'retired routed target probe',
        createIfMissing: true,
        runtimeIntent: {
          placement: {
            agentRoot: '/tmp/agent',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            dryRun: true,
          },
          harness: { provider: 'openai', interactive: false, id: 'codex-cli' },
          execution: { preferredMode: 'nonInteractive' },
        },
      })
    } finally {
      process.stderr.write = original
    }

    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }
    expect(body.error?.code).toBe('stale_context')
    expect(body.error?.message).toContain('canonical home is lab')
    expect(body.error?.detail).toMatchObject({
      scopeRef: SCOPE_REF,
      path: 'archived-successor',
      reason: 'scope-retired',
      retryable: false,
      homeNodeId: 'lab',
    })

    const refusalLines = captured.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
    expect(refusalLines).toHaveLength(1)
    expect(refusalLines[0]).toContain('"path":"archived-successor"')
    expect(refusalLines[0]).toContain('"reason":"scope-retired"')
    expect(refusalLines[0]).toContain('"enforced":true')
    expect(refusalLines[0]).toContain('"mode":"enforce"')
    expect(refusalLines[0]).toContain('"homeNodeId":"lab"')
    expect(refusalLines[0]).toContain('"birthCredentialPresent":false')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const sessions = db.sessions.listByScopeRef(SCOPE_REF)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.hostSessionId).toBe(HOST_SESSION_ID)
      expect(sessions.some((session) => session.status === 'archived')).toBe(false)
      expect(db.runtimes.listByHostSessionId(HOST_SESSION_ID)).toEqual([])
    } finally {
      db.close()
    }
  })

  test('advisory active viewer emits exactly one pre-selection retirement observation', async () => {
    await server?.stop()
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'svc', gate: { mode: 'advisory' } }),
      { mode: 0o600 }
    )
    server = await createHrcServer(fixture.serverOpts())

    const captured: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write

    let response: Response
    try {
      response = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'advisory active viewer observation probe',
        createIfMissing: false,
      })
    } finally {
      process.stderr.write = original
    }

    expect(response.status).toBe(200)
    const refusalLines = captured.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
    expect(refusalLines).toHaveLength(1)
    expect(refusalLines[0]).toContain('"path":"archived-successor"')
    expect(refusalLines[0]).toContain('"reason":"scope-retired"')
    expect(refusalLines[0]).toContain('"enforced":false')
    expect(refusalLines[0]).toContain('"mode":"advisory"')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.sessions.listByScopeRef(SCOPE_REF)).toHaveLength(1)
      expect(verifyDb.runtimes.listByHostSessionId(HOST_SESSION_ID)).toEqual([])
    } finally {
      verifyDb.close()
    }
  })

  test('enforce archived successor emits exactly one pre-selection retirement refusal', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.sessions.updateContinuation(
        HOST_SESSION_ID,
        { provider: 'codex', kind: 'thread', key: 'thread-t06683-enforce-archived' },
        now
      )
      db.sessions.updateStatus(HOST_SESSION_ID, 'archived', now)
    } finally {
      db.close()
    }

    const captured: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write

    let response: Response
    try {
      response = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'enforce archived successor observation probe',
        createIfMissing: false,
      })
    } finally {
      process.stderr.write = original
    }

    expect(response.status).toBe(409)
    const refusalLines = captured.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
    expect(refusalLines).toHaveLength(1)
    expect(refusalLines[0]).toContain('"path":"archived-successor"')
    expect(refusalLines[0]).toContain('"reason":"scope-retired"')
    expect(refusalLines[0]).toContain('"enforced":true')
    expect(refusalLines[0]).toContain('"mode":"enforce"')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.sessions.listByScopeRef(SCOPE_REF)).toHaveLength(1)
      expect(verifyDb.runtimes.listByHostSessionId(HOST_SESSION_ID)).toEqual([])
    } finally {
      verifyDb.close()
    }
  })

  test('advisory archived successor retains its single existing retirement observation', async () => {
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.sessions.updateContinuation(
        HOST_SESSION_ID,
        { provider: 'codex', kind: 'thread', key: 'thread-t06683-archived' },
        now
      )
      db.sessions.updateStatus(HOST_SESSION_ID, 'archived', now)
    } finally {
      db.close()
    }

    await server?.stop()
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'svc', gate: { mode: 'advisory' } }),
      { mode: 0o600 }
    )
    server = await createHrcServer(fixture.serverOpts())

    const captured: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write

    let response: Response
    try {
      response = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: SESSION_REF },
        body: 'advisory archived successor observation probe',
        createIfMissing: false,
      })
    } finally {
      process.stderr.write = original
    }

    expect(response.status).toBe(200)
    const refusalLines = captured.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
    expect(refusalLines).toHaveLength(1)
    expect(refusalLines[0]).toContain('"path":"archived-successor"')
    expect(refusalLines[0]).toContain('"reason":"scope-retired"')
    expect(refusalLines[0]).toContain('"enforced":false')
    expect(refusalLines[0]).toContain('"mode":"advisory"')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.sessions.listByScopeRef(SCOPE_REF)).toHaveLength(2)
      expect(verifyDb.runtimes.listByHostSessionId(HOST_SESSION_ID)).toEqual([])
    } finally {
      verifyDb.close()
    }
  })
})
