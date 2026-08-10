import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, hashRegistrationCredential } from '../index.js'
import type { HrcServer, RegistrationClassConfig } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

describe('T-07134 POST /v1/registrations', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  const arrisClass: RegistrationClassConfig = {
    classId: 'arris-agent',
    scopeTemplate: { agent: 'arris', project: 'arris' },
    maxInstances: 2,
    defaultTtl: 90,
    turnsAllowed: false,
  }

  beforeEach(async () => {
    fixture = await createHrcTestFixture('epr-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function start(registrationClasses: readonly RegistrationClassConfig[] = [arrisClass]) {
    server = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses })
    )
  }

  function request(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      classId: 'arris-agent',
      socketPath: '/tmp/arris-agent.sock',
      provisioner: { name: 'arris', version: '1.0.0', pid: 123 },
      ...patch,
    }
  }

  test('derives a fresh node-free scope and returns the raw credential exactly once', async () => {
    await start()
    const before = Date.now()
    const response = await fixture.postJson('/v1/registrations', request())
    const after = Date.now()
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, string>
    expect(body['registrationId']).toMatch(/^registration-[0-9a-f-]{36}$/)
    expect(body['derivedScope']).toMatch(/^agent:arris:project:arris:task:reg-[0-9a-f]{24}$/)
    expect(body['derivedScope']).not.toContain('node')
    expect(body['credential']).toMatch(/^epr_[A-Za-z0-9_-]{43}$/)
    expect(body).not.toHaveProperty('placementAdvisory')
    expect(new Date(body['expiresAt']!).getTime()).toBeGreaterThanOrEqual(before + 90_000)
    expect(new Date(body['expiresAt']!).getTime()).toBeLessThanOrEqual(after + 90_000)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const grant = db.externalRegistrationGrants.getByRegistrationId(body['registrationId']!)
      expect(grant).toMatchObject({
        classId: 'arris-agent',
        derivedScope: body['derivedScope'],
        socketPath: '/tmp/arris-agent.sock',
        credentialHash: hashRegistrationCredential(body['credential']!),
        consumed: false,
        turnsAllowed: false,
        provisioner: { name: 'arris', version: '1.0.0', pid: 123 },
      })
      expect(grant?.credentialHash).not.toBe(body['credential'])
    } finally {
      db.close()
    }
  })

  test('advises when declared placement designates another node without gating issuance', async () => {
    await writeFile(
      join(fixture.stateRoot, 'federation.json'),
      JSON.stringify({ nodeId: 'max3', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    await start()
    Object.assign(server!, {
      policyFor: async () => ({
        claimsTask: false,
        placement: { defaultHomeNode: 'svc', pins: {} },
      }),
    })

    const response = await fixture.postJson('/v1/registrations', request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      placementAdvisory:
        'policy designates svc as home; this registration will be noncanonical on max3',
    })

    Object.assign(server!, { policyFor: async () => Promise.reject(new Error('unreadable')) })
    const unreadable = await fixture.postJson(
      '/v1/registrations',
      request({ socketPath: '/tmp/unreadable.sock' })
    )
    expect(unreadable.status).toBe(200)
    expect(await unreadable.json()).not.toHaveProperty('placementAdvisory')
  })

  test('returns the three typed issuance refusals', async () => {
    await start([{ ...arrisClass, maxInstances: 1 }])

    const unknown = await fixture.postJson('/v1/registrations', request({ classId: 'native' }))
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_class' } })

    for (const malformed of [
      request({ socketPath: 'relative.sock' }),
      request({ ttlSeconds: 301 }),
      request({ requestedScope: 'agent:cody:project:hrc-runtime:task:primary' }),
      { classId: 'arris-agent', socketPath: '/tmp/a.sock' },
    ]) {
      const response = await fixture.postJson('/v1/registrations', malformed)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'malformed' } })
    }

    const invalidJson = await fixture.fetchSocket('/v1/registrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(invalidJson.status).toBe(400)
    expect(await invalidJson.json()).toMatchObject({ error: { code: 'malformed' } })

    expect((await fixture.postJson('/v1/registrations', request())).status).toBe(200)
    const exhausted = await fixture.postJson('/v1/registrations', request())
    expect(exhausted.status).toBe(409)
    expect(await exhausted.json()).toMatchObject({
      error: {
        code: 'instances_exhausted',
        detail: { classId: 'arris-agent', maxInstances: 1, occupied: 1 },
      },
    })
  })

  test('capacity admission is atomic and an expired-unconsumed grant frees its slot', async () => {
    await start([{ ...arrisClass, maxInstances: 1 }])
    const simultaneous = await Promise.all([
      fixture.postJson('/v1/registrations', request({ socketPath: '/tmp/a.sock' })),
      fixture.postJson('/v1/registrations', request({ socketPath: '/tmp/b.sock' })),
    ])
    expect(simultaneous.map((response) => response.status).sort()).toEqual([200, 409])

    const raw = new Database(fixture.dbPath)
    try {
      raw
        .query("UPDATE external_registration_grants SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run()
    } finally {
      raw.close()
    }
    expect((await fixture.postJson('/v1/registrations', request())).status).toBe(200)
  })
})
