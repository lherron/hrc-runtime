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

function registration(joinDirection: ParticipantRegistration['join']): ParticipantRegistration {
  return {
    registrationId: `registration-${joinDirection}`,
    classId: `class-${joinDirection}`,
    adapterId: 'controlled-participant',
    join: joinDirection,
    participantKey: `key-${joinDirection}`,
    scopeRef: 'agent:larry:project:hrc-runtime:task:participant-hosting-intent',
    laneRef: 'main',
    hostSessionId: 'hsid-hosting-intent',
    generation: 1,
    workspaceCwd: '/tmp/participant-workspace',
    ...(joinDirection === 'participant-served' ? { socketPath: '/tmp/served broker.sock' } : {}),
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
    classId: 'class-hrc-hosted',
    join: 'hrc-hosted',
    participantKey: 'key-hrc-hosted',
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

test('preserves every hosted command argv through shell rendering and records requested presentation', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 't08349 path '))
  temporaryRoots.push(runtimeRoot)
  const baseProfile = await controlledProfile()
  const hosted = await createParticipantHostingIntent(
    server(runtimeRoot),
    registration('hrc-hosted'),
    attempt('rt host intent'),
    baseProfile
  )
  expect(hosted.presentation).toEqual({ kind: 'none' })
  expect(hosted.hrcHosted).toBeDefined()
  const hostedIntent = hosted.hrcHosted!
  const shell = Bun.spawn(
    [
      '/bin/sh',
      '-c',
      `set -- ${hostedIntent.brokerCommand.slice('exec '.length)}; printf '%s\\n' "$@"`,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  expect(await shell.exited).toBe(0)
  expect(await new Response(shell.stdout).text()).toBe(`${hostedIntent.brokerArgv.join('\n')}\n`)
  const tokenPath = hosted.endpoint.attachTokenRef.path
  expect(await readFile(tokenPath, 'utf8')).toBe('durable-token-for-test')
  expect(JSON.stringify(hosted)).not.toContain('durable-token-for-test')

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
    registration('participant-served'),
    attempt('rt served intent'),
    servedProfile
  )
  expect(served.presentation).toEqual({ kind: 'tmux-tui' })
  expect(served.hrcHosted).toBeUndefined()
  expect(served.endpoint.socketPath).toBe('/tmp/served broker.sock')
})
