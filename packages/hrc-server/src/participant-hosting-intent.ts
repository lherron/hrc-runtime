import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type { BrokerLifecyclePolicyOverlay } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { resolveBrokerBinary } from './broker-interactive-handlers/substrate-allocator.js'
import { resolveLifecyclePolicyOverlay } from './broker/lifecycle-overlay.js'
import type { BrokerAttachTokenRef } from './broker/runtime-state.js'
import { shellQuote } from './dispatch-invocation.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { getBrokerIpcSocketPath, getBrokerTmuxSocketPath } from './tmux-socket.js'

/**
 * Boundary two of the generic participant path. It records HRC's hosting
 * choices before any broker or tmux effect. The adapter profile is only an
 * input: this code never authors or mutates its invocation request.
 */
export type ParticipantHostingIntent = {
  schemaVersion: 'participant-hosting-intent/v1'
  join: ParticipantRegistration['join']
  endpoint: {
    kind: 'unix-jsonrpc-ndjson'
    socketPath: string
    attachTokenRef: BrokerAttachTokenRef
    protocolVersion: 'harness-broker/0.2'
  }
  lifecyclePolicy: BrokerLifecyclePolicyOverlay
  hrcHosted?: {
    brokerDriver: string
    brokerBinary: string
    brokerCommand: string
    tmuxSocketPath: string
    sessionName: string
    eventLedgerPath: string
    presentation: 'none'
  }
}

function attachTokenFor(server: HrcServerInstanceForHandlers): string {
  return server.generateBrokerAttachToken?.() ?? randomUUID()
}

async function writeAttachTokenOnce(path: string, token: string): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  // The permanent registration's roster lock serializes this. `wx` still makes
  // an accidental second token writer fail closed rather than replace evidence.
  try {
    await writeFile(path, token, { mode: 0o600, flag: 'wx' })
    await chmod(path, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // A process crash after token creation but before the SQLite boundary has
    // no authorized spawn. The identity-derived, owner-only file is safe to
    // retain and reference on retry, but an empty/torn credential is never
    // treated as a successful recovery.
    if ((await readFile(path, 'utf8')).trim().length === 0) {
      throw new Error('existing participant attach token is empty')
    }
  }
}

export async function createParticipantHostingIntent(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  attempt: ParticipantAttempt,
  profile: BrokerExecutionProfile
): Promise<ParticipantHostingIntent> {
  const lifecyclePolicy = resolveLifecyclePolicyOverlay({
    routeId: `participant:${registration.classId}`,
    brokerRoute: true,
  })
  if (lifecyclePolicy === undefined) {
    throw new Error('generic participant broker route did not receive an HRC lifecycle policy')
  }

  const brokerIpcSocketPath = getBrokerIpcSocketPath(
    server.options,
    profile.brokerDriver,
    attempt.runtimeId
  )
  const attachTokenPath = join(dirname(brokerIpcSocketPath), 'attach.token')
  await writeAttachTokenOnce(attachTokenPath, attachTokenFor(server))
  const attachTokenRef: BrokerAttachTokenRef = {
    kind: 'file',
    path: attachTokenPath,
    redacted: true,
  }

  if (registration.join === 'participant-served') {
    if (registration.socketPath === undefined) {
      throw new Error('participant-served registration is missing its durable serving socket')
    }
    return {
      schemaVersion: 'participant-hosting-intent/v1',
      join: registration.join,
      endpoint: {
        kind: 'unix-jsonrpc-ndjson',
        socketPath: registration.socketPath,
        attachTokenRef,
        protocolVersion: 'harness-broker/0.2',
      },
      lifecyclePolicy,
    }
  }

  const brokerBinary = resolveBrokerBinary(profile.brokerDriver)
  const btmuxSocketPath = getBrokerTmuxSocketPath(
    server.options,
    profile.brokerDriver,
    attempt.runtimeId
  )
  const sessionName = `hrc-${profile.brokerDriver}-${attempt.runtimeId}`
  const eventLedgerPath = join(dirname(brokerIpcSocketPath), 'events.ndjson')
  const brokerCommand = `exec ${shellQuote(brokerBinary)} run --transport unix --socket ${brokerIpcSocketPath} --event-ledger ${eventLedgerPath} --runtime-id ${attempt.runtimeId} --host-session-id ${registration.hostSessionId} --generation ${registration.generation} --attach-token-file ${attachTokenPath} 2>${join(dirname(brokerIpcSocketPath), 'broker.err')}`

  return {
    schemaVersion: 'participant-hosting-intent/v1',
    join: registration.join,
    endpoint: {
      kind: 'unix-jsonrpc-ndjson',
      socketPath: brokerIpcSocketPath,
      attachTokenRef,
      protocolVersion: 'harness-broker/0.2',
    },
    lifecyclePolicy,
    hrcHosted: {
      brokerDriver: profile.brokerDriver,
      brokerBinary,
      brokerCommand,
      tmuxSocketPath: btmuxSocketPath,
      sessionName,
      eventLedgerPath,
      presentation: 'none',
    },
  }
}
