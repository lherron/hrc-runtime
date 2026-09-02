import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { BindingRegistry, HrcDatabase } from 'hrc-store-sqlite'

import {
  type ExternalParticipantRpcClient,
  performExternalRegistrationHello,
} from '../external-registration-rendezvous.js'
import {
  type BindingRegistryClient,
  RegistryUnreachableError,
} from '../federation/registry-client.js'
import {
  handleRetireRegistrationScopes,
  projectRegistrationGcCandidates,
} from '../registration-gc-handlers.js'
import { hashRegistrationCredential } from '../registration-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import type { HrcServerOptions } from '../server-types.js'

const REGISTRATION_ID = 'registration-t07139'
const CREDENTIAL = 'credential-t07139'
const SCOPE = 'agent:arris:project:arris:task:reg-t07139'
const OLD = '2026-08-09T20:00:00.000Z'
const NOW = '2026-08-09T20:01:00.000Z'

class HelloClient implements ExternalParticipantRpcClient {
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      return {
        protocolVersion: 'epr/1',
        registrationId: params['registrationId'],
        credential: CREDENTIAL,
        capabilities: { events: true, turns: false, continuations: true },
        participantInfo: { name: 'arris' },
      }
    }
    if (method === 'epr.established') return { ready: true, currentSeq: 0 }
    throw new Error(`unexpected method ${method}`)
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('T-07139 operator-invoked registration retirement', () => {
  let root: string
  let db: HrcDatabase
  let registry: BindingRegistry
  let server: HrcServerInstanceForHandlers
  let runtimeId: string

  beforeEach(async () => {
    root = join(tmpdir(), `hrc-epr-t07139-${crypto.randomUUID()}`)
    await mkdir(root, { recursive: true })
    db = openHrcDatabase(join(root, 'state.sqlite'))
    registry = openBindingRegistry(join(root, 'registry.sqlite'))
    const options = {
      runtimeRoot: join(root, 'run'),
      externalParticipantLingerMs: 1_000,
    } as HrcServerOptions
    server = {
      db,
      options,
      generateBrokerAttachToken: () => 'attach-token-t07139',
      externalParticipantClients: new Map(),
      externalRegistrationOperations: new Map(),
      externalRegistrationEstablishmentOperations: new Map(),
      stopping: false,
      ctx: { notifyEvent: () => undefined },
    } as unknown as HrcServerInstanceForHandlers
    expect(
      db.externalRegistrationGrants.issueWithinCapacity(
        {
          registrationId: REGISTRATION_ID,
          classId: 'arris-agent',
          derivedScope: SCOPE,
          socketPath: join(root, 'participant.sock'),
          credentialHash: hashRegistrationCredential(CREDENTIAL),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          consumed: false,
          turnsAllowed: false,
          provisioner: {},
          createdAt: new Date().toISOString(),
        },
        1,
        new Date().toISOString()
      ).outcome
    ).toBe('issued')
    runtimeId = (await performExternalRegistrationHello(server, REGISTRATION_ID, new HelloClient()))
      .delivery.runtimeId
    options.federationConfig = {
      sourceExists: true,
      nodeId: 'svc',
      peers: new Map(),
      gate: { mode: 'enforce' },
    }
    const binding = registry.establish({
      scopeRef: SCOPE,
      homeNodeId: 'svc',
      now: OLD,
    }).binding
    createPlacementLedgerRepository(db.sqlite).installActive(binding)
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (runtime === null) throw new Error('minted runtime missing')
    db.runtimes.update(runtimeId, {
      status: 'terminated',
      statusChangedAt: OLD,
      lifecycleTerminalReason: 'external_participant_exit',
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status: 'terminated',
        terminalReason: 'external_participant_exit',
      },
      updatedAt: OLD,
    })
  })

  afterEach(async () => {
    db.close()
    registry.close()
    await rm(root, { recursive: true, force: true })
  })

  function client(beforeDelete?: () => void): BindingRegistryClient {
    return {
      async consult(scopeRef) {
        const binding = registry.get(scopeRef)
        if (binding === undefined) return { outcome: 'unbound' }
        return { outcome: 'bound', binding }
      },
      async establish(request) {
        return registry.establish(request)
      },
      async deleteBinding(request) {
        beforeDelete?.()
        return registry.deleteBinding(request)
      },
    }
  }

  function setClient(value: BindingRegistryClient): void {
    ;(
      server as unknown as { federationRegistryClient: BindingRegistryClient }
    ).federationRegistryClient = value
  }

  function request(scopeRefs = [SCOPE]): Request {
    return new Request('http://hrc/v1/admin/registrations/gc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeRefs }),
    })
  }

  test('candidate listing is a read-only terminal + linger + no-continuation projection', () => {
    expect(projectRegistrationGcCandidates(server, NOW).candidates).toEqual([
      expect.objectContaining({
        registrationId: REGISTRATION_ID,
        scopeRef: SCOPE,
        runtimeId,
        terminalReason: 'external_participant_exit',
        terminalAt: OLD,
        eligibleAt: '2026-08-09T20:00:01.000Z',
      }),
    ])
    expect(registry.get(SCOPE)).toBeDefined()
    expect(createPlacementLedgerRepository(db.sqlite).get(SCOPE)?.state).toBe('active')
    expect(db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)?.retiredAt).toBe(
      undefined
    )

    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (runtime === null) throw new Error('runtime missing')
    db.sessions.updateContinuation(
      runtime.hostSessionId,
      { provider: 'openai', key: 'stored-continuation' },
      NOW
    )
    expect(projectRegistrationGcCandidates(server, NOW).candidates).toEqual([])
    // Restore the fixture's original keyless precondition without exposing a
    // production repository path that can erase recorded continuation history.
    db.sqlite
      .query('UPDATE sessions SET continuation_json = NULL WHERE host_session_id = ?')
      .run(runtime.hostSessionId)
    db.runtimes.update(runtimeId, { status: 'detached', updatedAt: NOW })
    expect(projectRegistrationGcCandidates(server, NOW).candidates).toEqual([])
  })

  test('retirement installs the permanent local fence before deleting the registry binding', async () => {
    setClient(
      client(() => {
        expect(createPlacementLedgerRepository(db.sqlite).get(SCOPE)).toMatchObject({
          homeNodeId: 'svc',
          state: 'retired',
          retirementReason: 'external_registration_gc',
        })
        expect(registry.get(SCOPE)).toBeDefined()
      })
    )

    const response = await handleRetireRegistrationScopes.call(server, request())
    expect(await response.json()).toMatchObject({
      results: [{ scopeRef: SCOPE, registrationId: REGISTRATION_ID, status: 'retired' }],
      summary: { requested: 1, retired: 1, idempotent: 0, skipped: 0, errors: 0 },
    })
    expect(registry.get(SCOPE)).toBeUndefined()
    expect(createPlacementLedgerRepository(db.sqlite).get(SCOPE)).toMatchObject({
      state: 'retired',
      retirementReason: 'external_registration_gc',
    })
    expect(db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)).toMatchObject({
      retirementReason: 'external_registration_gc',
    })
    expect(projectRegistrationGcCandidates(server, NOW).candidates).toEqual([])
    expect(db.externalRegistrationGrants.countCapacityOccupants('arris-agent', NOW)).toBe(0)
  })

  test('fence-first partial failure converges on explicit retry with the same timestamp', async () => {
    let fail = true
    setClient({
      ...client(),
      async deleteBinding(request) {
        if (fail) {
          throw new RegistryUnreachableError('registry unavailable after local fence')
        }
        return registry.deleteBinding(request)
      },
    })
    const first = (await (await handleRetireRegistrationScopes.call(server, request())).json()) as {
      results: Array<{ status: string }>
    }
    expect(first.results[0]?.status).toBe('authority_unavailable')
    const fence = createPlacementLedgerRepository(db.sqlite).get(SCOPE)
    expect(fence).toMatchObject({
      state: 'retired',
      retirementReason: 'external_registration_gc',
    })
    expect(registry.get(SCOPE)).toBeDefined()

    fail = false
    const second = (await (
      await handleRetireRegistrationScopes.call(server, request())
    ).json()) as {
      results: Array<{ status: string }>
    }
    expect(second.results[0]?.status).toBe('retired')
    expect(registry.get(SCOPE)).toBeUndefined()
    expect(createPlacementLedgerRepository(db.sqlite).get(SCOPE)?.retiredAt).toBe(fence?.retiredAt)
  })

  test('empty or non-candidate mutation requests cannot reach authority retirement', async () => {
    let deletes = 0
    setClient(
      client(() => {
        deletes += 1
      })
    )
    await expect(handleRetireRegistrationScopes.call(server, request([]))).rejects.toThrow(
      'at least one exact scopeRef'
    )

    const missing = await handleRetireRegistrationScopes.call(
      server,
      request(['agent:arris:project:arris:task:reg-missing'])
    )
    expect(await missing.json()).toMatchObject({
      results: [{ status: 'not_candidate' }],
    })
    expect(deletes).toBe(0)
    expect(registry.get(SCOPE)).toBeDefined()
  })
})
