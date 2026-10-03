import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { makeParticipantBrokerDescriptor } from './fixtures/participant-broker-descriptor.fixture.js'

const SCOPE = 'agent:arris:project:hrc-runtime:task:T-10148'
type Registered = {
  status: string
  hostSessionId: string
  generation: number
  scopeRef: string
  rejectedMetadata?: Array<{ key: string }>
  identity: {
    requestId: string
    operationId: string
    runtimeId: string
    invocationId: string
    registrationId: string
    attemptId: string
    attachEpoch: number
    laneRef: string
  }
}

describe('participant metadata through real HTTP request parsers', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer
  beforeEach(async () => {
    fixture = await createHrcTestFixture('t10148-participant-meta-')
    server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
  })
  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function register(metadata?: unknown): Promise<Registered> {
    const response = await fixture.postJson('/v1/participants/register', {
      registrationMode: 'direct',
      requestedSessionRef: SCOPE,
      hostIncarnationId: 't10148-host',
      workspaceCwd: fixture.tmpDir,
      socketPath: `${fixture.tmpDir}/participant.sock`,
      ...(metadata === undefined ? {} : { metadata }),
    })
    const body = (await response.json()) as Registered
    expect(response.status).toBe(200)
    expect(body.status).toBe('registered')
    return body
  }
  function launchRows() {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.sqlite
        .query<{ key: string; value_json: string; source: string }, [string]>(
          "SELECT key,value_json,source FROM session_metadata WHERE scope_ref=? AND source='launch' ORDER BY key"
        )
        .all(SCOPE)
    } finally {
      db.close()
    }
  }
  function changes() {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.hrcEvents
        .listFromHrcSeqFiltered(1, { scopeRef: SCOPE })
        .filter((event) => event.eventKind === 'session.metadata.changed')
        .map((event) => event.payload)
    } finally {
      db.close()
    }
  }

  test('register accepts open metadata, stores launch values, and reports dropped keys', async () => {
    const registered = await register({
      title: 'Joined title',
      appearance: { color: '#2F5FA6', terminalBg: 'invalid' },
      foundry: { workspace: 'open' },
      'bad..key': 1,
    })
    expect(registered.rejectedMetadata?.map((row) => row.key).sort()).toEqual([
      'appearance.terminalBg',
      'bad..key',
    ])
    expect(launchRows()).toEqual([
      { key: 'appearance.color', value_json: '"#2F5FA6"', source: 'launch' },
      { key: 'foundry.workspace', value_json: '"open"', source: 'launch' },
      { key: 'title', value_json: '"Joined title"', source: 'launch' },
    ])
    expect(changes()).toHaveLength(3)
  })

  test('attach accepts metadata, absent preserves it, replacements drop invalid keys, and empty clears', async () => {
    const registered = await register()
    const allocated = registered.identity
    const descriptor = makeParticipantBrokerDescriptor({
      requestId: allocated.requestId,
      operationId: allocated.operationId,
      hostSessionId: registered.hostSessionId,
      generation: registered.generation,
      runtimeId: allocated.runtimeId,
      invocationId: allocated.invocationId,
      cwd: fixture.tmpDir,
    })
    const request = {
      registrationId: allocated.registrationId,
      attemptId: allocated.attemptId,
      attachEpoch: allocated.attachEpoch,
      descriptor,
    }
    async function attach(metadata?: unknown) {
      const response = await fixture.postJson('/v1/participants/attach', {
        ...request,
        ...(metadata === undefined ? {} : { metadata }),
      })
      const body = (await response.json()) as {
        status: string
        rejectedMetadata?: Array<{ key: string }>
      }
      expect(body).toMatchObject({ status: 'attached' })
      expect(response.status).toBe(200)
      return body
    }
    await attach({
      title: 'Attached title',
      appearance: { color: '#2F5FA6' },
      foundry: { workspace: 'open' },
    })
    const before = launchRows()
    expect(before.map((row) => row.key)).toEqual(['appearance.color', 'foundry.workspace', 'title'])
    expect(changes()).toHaveLength(3)
    await attach()
    expect(launchRows()).toEqual(before)
    expect(changes()).toHaveLength(3)
    const replaced = await attach({ title: 'Replacement', appearance: { color: 'invalid' } })
    expect(replaced.rejectedMetadata?.map((row) => row.key)).toEqual(['appearance.color'])
    expect(launchRows()).toEqual([{ key: 'title', value_json: '"Replacement"', source: 'launch' }])
    expect(changes()).toHaveLength(6)
    await attach({})
    expect(launchRows()).toEqual([])
    expect(changes()).toHaveLength(7)
  })
})
