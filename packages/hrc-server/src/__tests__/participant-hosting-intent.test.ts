import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'bun:test'

import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { createParticipantHostingIntent } from '../participant-hosting-intent.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function registration(): ParticipantRegistration {
  return {
    registrationId: 'registration-participant-served',
    classId: 'class-participant-served',
    adapterId: 'controlled-participant',
    join: 'participant-served',
    participantKey: 'key-participant-served',
    scopeRef: 'agent:larry:project:hrc-runtime:task:participant-hosting-intent',
    laneRef: 'main',
    hostSessionId: 'hsid-hosting-intent',
    generation: 1,
    workspaceCwd: '/tmp/participant-workspace',
    socketPath: '/tmp/served broker.sock',
    preparationJson: '{}',
    createdAt: '2026-09-09T22:20:00.000Z',
    updatedAt: '2026-09-09T22:20:00.000Z',
  }
}

function attempt(runtimeId: string): ParticipantAttempt {
  return {
    attemptId: `attempt-${runtimeId}`,
    registrationId: 'registration',
    attachEpoch: 1,
    requestId: 'req-hosting-intent',
    operationId: 'op-hosting-intent',
    invocationId: 'inv-hosting-intent',
    runtimeId,
    state: 'PREPARED',
    createdAt: '2026-09-09T22:20:00.000Z',
    updatedAt: '2026-09-09T22:20:00.000Z',
  }
}

function server(runtimeRoot: string): HrcServerInstanceForHandlers {
  return {
    options: { runtimeRoot },
    generateBrokerAttachToken: () => 'durable-token-for-test',
  } as unknown as HrcServerInstanceForHandlers
}

async function controlledProfile(): Promise<BrokerExecutionProfile> {
  const adapter = createControlledParticipantAdapter({
    adapterId: 'controlled-participant',
    workspaceCwd: '/tmp/participant-workspace',
    driver: 'noop-driver',
  })
  const result = await adapter.prepare({
    classId: 'class-participant-served',
    join: 'participant-served',
    participantKey: 'key-participant-served',
    workspaceCwd: '/tmp/participant-workspace',
    preparation: {},
    identity: {
      requestId: 'req-hosting-intent',
      operationId: 'op-hosting-intent',
      hostSessionId: 'hsid-hosting-intent',
      generation: 1,
      runtimeId: 'rt-hosting-intent',
      invocationId: 'inv-hosting-intent',
    },
    scopeRef: 'agent:larry:project:hrc-runtime:task:participant-hosting-intent',
    laneRef: 'main',
    attachEpoch: 1,
  })
  if (result.status !== 'prepared') throw new Error('controlled adapter did not prepare')
  return result.profile
}

test('records requested presentation and serves the participant-owned endpoint', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 't08349 path '))
  temporaryRoots.push(runtimeRoot)
  const baseProfile = await controlledProfile()
  const servedProfile: BrokerExecutionProfile = {
    ...baseProfile,
    interactionMode: 'interactive',
    brokerTerminal: {
      host: 'tmux',
      startupMethod: 'create-terminal',
      turnDelivery: 'terminal-literal-input',
      operatorAttach: true,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    },
  }
  const served = await createParticipantHostingIntent(
    server(runtimeRoot),
    registration(),
    attempt('rt served intent'),
    servedProfile
  )
  expect(served.presentation).toEqual({ kind: 'tmux-tui' })
  expect('hrcHosted' in served).toBe(false)
  expect(served.endpoint.socketPath).toBe('/tmp/served broker.sock')
  const tokenPath = served.endpoint.attachTokenRef.path
  expect(await readFile(tokenPath, 'utf8')).toBe('durable-token-for-test')
  expect(JSON.stringify(served)).not.toContain('durable-token-for-test')
})
