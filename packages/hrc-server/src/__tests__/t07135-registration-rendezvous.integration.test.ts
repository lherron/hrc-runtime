import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createServer as createUnixServer } from 'node:net'
import type { Socket, Server as UnixServer } from 'node:net'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer, RegistrationClassConfig } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for EPR establishment')
    await Bun.sleep(10)
  }
}

describe('T-07135 live EPR registration rendezvous', () => {
  let fixture: HrcServerTestFixture
  let hrc: HrcServer | undefined
  let participant: UnixServer | undefined
  let participantSockets: Socket[] = []
  let participantSocketPath: string

  const arrisClass: RegistrationClassConfig = {
    classId: 'arris-agent',
    scopeTemplate: { agent: 'arris', project: 'arris' },
    maxInstances: 1,
    defaultTtl: 60,
    turnsAllowed: false,
  }

  beforeEach(async () => {
    fixture = await createHrcTestFixture('epr-live-')
    participantSocketPath = `/tmp/epr-${crypto.randomUUID().slice(0, 8)}.sock`
  })

  afterEach(async () => {
    await hrc?.stop()
    for (const socket of participantSockets) socket.destroy()
    participantSockets = []
    await new Promise<void>((resolve) => participant?.close(() => resolve()) ?? resolve())
    await rm(participantSocketPath, { force: true })
    await fixture.cleanup()
  })

  test('POST returns the credential, then HRC dials hello and established over real NDJSON', async () => {
    const credential = deferred<string>()
    const methods: string[] = []
    let establishedParams: Record<string, unknown> | undefined

    participant = createUnixServer((socket) => {
      participantSockets.push(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n')
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length === 0) continue
          const message = JSON.parse(line) as {
            id?: number | undefined
            method: string
            params: Record<string, unknown>
          }
          methods.push(message.method)
          if (message.method === 'epr.hello') {
            void credential.promise.then((secret) => {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    protocolVersion: 'epr/1',
                    registrationId: message.params['registrationId'],
                    credential: secret,
                    capabilities: { events: true, turns: false, continuations: false },
                    participantInfo: { name: 'arris-live', version: '1.0.0' },
                  },
                })}\n`
              )
            })
          } else if (message.method === 'epr.established') {
            establishedParams = message.params
            const ackedThroughSeq = message.params['ackedThroughSeq']
            if (!Number.isInteger(ackedThroughSeq) || (ackedThroughSeq as number) < 0) {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32602, message: 'ackedThroughSeq must be nonnegative' },
                })}\n`
              )
              continue
            }
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { ready: true, currentSeq: 0 },
              })}\n`
            )
          } else if (message.method === 'invocation.snapshot') {
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  invocationId: message.params['invocationId'],
                  state: 'ready',
                  capabilities: {},
                  pendingInputIds: [],
                  inputDispositions: {},
                  pendingPermissionRequests: [],
                  currentSeq: 0,
                  retentionFloorSeq: 0,
                },
              })}\n`
            )
          } else if (message.method === 'invocation.eventsSince') {
            const afterSeq = message.params['afterSeq']
            if (!Number.isInteger(afterSeq) || (afterSeq as number) < 0) {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32602, message: 'afterSeq must be nonnegative' },
                })}\n`
              )
              continue
            }
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { events: [], currentSeq: 0, retentionFloorSeq: 0 },
              })}\n`
            )
          } else if (message.method === 'broker.health') {
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { status: 'ok', activeInvocations: 1 },
              })}\n`
            )
          } else if (message.method === 'invocation.status') {
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { invocationId: message.params['invocationId'], state: 'ready' },
              })}\n`
            )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      participant!.once('error', reject)
      participant!.listen(participantSocketPath, resolve)
    })

    hrc = await createHrcServer(
      fixture.serverOpts({ otelListenerEnabled: false, registrationClasses: [arrisClass] })
    )
    const response = await fixture.postJson('/v1/registrations', {
      classId: 'arris-agent',
      socketPath: participantSocketPath,
      provisioner: { name: 'live-test' },
    })
    expect(response.status).toBe(200)
    const registration = (await response.json()) as {
      registrationId: string
      credential: string
      derivedScope: string
    }
    credential.resolve(registration.credential)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      await waitUntil(() => {
        const current = db.externalRegistrationGrants.getByRegistrationId(
          registration.registrationId
        )
        const runtime =
          current?.runtimeId === undefined ? null : db.runtimes.getByRuntimeId(current.runtimeId)
        const control = runtime?.runtimeStateJson?.['control']
        return (
          current?.establishmentState === 'ESTABLISHED' &&
          typeof control === 'object' &&
          control !== null &&
          (control as Record<string, unknown>)['brokerAttached'] === true
        )
      })
      const grant = db.externalRegistrationGrants.getByRegistrationId(registration.registrationId)!
      const runtime = db.runtimes.getByRuntimeId(grant.runtimeId!)!
      expect(methods).toEqual([
        'epr.hello',
        'epr.established',
        'invocation.snapshot',
        'invocation.eventsSince',
        'broker.health',
        'invocation.status',
      ])
      expect(establishedParams).toMatchObject({
        invocationId: grant.invocationId,
        runtimeId: grant.runtimeId,
        derivedScope: registration.derivedScope,
        controllerInstanceId: grant.controllerInstanceId,
        ackedThroughSeq: 0,
      })
      expect(establishedParams?.['attachToken']).toBeString()
      expect(runtime).toMatchObject({
        status: 'ready',
        harness: 'epr-external',
        provider: 'epr-external',
      })
    } finally {
      db.close()
    }
  })

  test('real NDJSON snapshot -32013 finalizes replay_gap and stops the rendezvous loop', async () => {
    const credential = deferred<string>()
    const methods: string[] = []
    let connections = 0

    participant = createUnixServer((socket) => {
      connections += 1
      participantSockets.push(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n')
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line.length === 0) continue
          const message = JSON.parse(line) as {
            id?: number | undefined
            method: string
            params: Record<string, unknown>
          }
          methods.push(message.method)
          if (message.method === 'epr.hello') {
            void credential.promise.then((secret) => {
              socket.write(
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: message.id,
                  result: {
                    protocolVersion: 'epr/1',
                    registrationId: message.params['registrationId'],
                    credential: secret,
                    capabilities: { events: true, turns: false, continuations: false },
                    participantInfo: { name: 'arris-replay-gap' },
                  },
                })}\n`
              )
            })
          } else if (message.method === 'epr.established') {
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                result: { ready: true, currentSeq: 0 },
              })}\n`
            )
          } else if (message.method === 'invocation.snapshot') {
            socket.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32013, message: 'event replay is unavailable' },
              })}\n`
            )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      participant!.once('error', reject)
      participant!.listen(participantSocketPath, resolve)
    })

    hrc = await createHrcServer(
      fixture.serverOpts({
        otelListenerEnabled: false,
        registrationClasses: [arrisClass],
        externalParticipantRendezvousRetryMs: 1,
      })
    )
    const response = await fixture.postJson('/v1/registrations', {
      classId: 'arris-agent',
      socketPath: participantSocketPath,
      provisioner: { name: 'live-replay-gap-test' },
    })
    expect(response.status).toBe(200)
    const registration = (await response.json()) as {
      registrationId: string
      credential: string
    }
    credential.resolve(registration.credential)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      await waitUntil(() => {
        const grant = db.externalRegistrationGrants.getByRegistrationId(registration.registrationId)
        const runtime =
          grant?.runtimeId === undefined ? null : db.runtimes.getByRuntimeId(grant.runtimeId)
        return runtime?.lifecycleTerminalReason === 'replay_gap'
      })
      await Bun.sleep(25)

      const grant = db.externalRegistrationGrants.getByRegistrationId(registration.registrationId)!
      expect(db.runtimes.getByRuntimeId(grant.runtimeId!)).toMatchObject({
        status: 'terminated',
        lifecycleTerminalReason: 'replay_gap',
      })
      expect(
        db.hrcEvents
          .listFromHrcSeq(1, { runtimeId: grant.runtimeId })
          .some((event) => event.payload?.['reason'] === 'replay_gap')
      ).toBe(true)
      expect(connections).toBe(1)
      expect(methods).toEqual(['epr.hello', 'epr.established', 'invocation.snapshot'])
    } finally {
      db.close()
    }
  })
})
