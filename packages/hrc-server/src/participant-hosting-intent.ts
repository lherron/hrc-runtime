import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open } from 'node:fs/promises'
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
  /** HRC-owned requested resource, distinct from broker process ownership. */
  presentation: { kind: 'none' } | { kind: 'tmux-tui' }
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
    /** Exact executable argv; command is only the tmux shell rendering of this. */
    brokerArgv: string[]
    brokerCommand: string
    tmuxSocketPath: string
    sessionName: string
    eventLedgerPath: string
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
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(token, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // A process crash after token creation but before the SQLite boundary has
    // no authorized spawn. The identity-derived, owner-only file is safe to
    // retain and reference on retry, but an empty/torn credential is never
    // treated as a successful recovery.
    const existing = await open(path, 'r')
    try {
      if ((await existing.readFile({ encoding: 'utf8' })).trim().length === 0) {
        throw new Error('existing participant attach token is empty')
      }
      await existing.sync()
    } finally {
      await existing.close()
    }
  }
  // File bytes alone are insufficient: persist the directory entry before its
  // reference can be committed to SQLite and before any spawn is authorized.
  const directoryHandle = await open(directory, 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
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
  const presentation =
    profile.brokerTerminal === undefined
      ? ({ kind: 'none' } as const)
      : profile.brokerTerminal.host === 'tmux'
        ? ({ kind: 'tmux-tui' } as const)
        : (() => {
            throw new Error('participant profile requests an unsupported HRC presentation resource')
          })()

  if (registration.join === 'participant-served') {
    if (registration.socketPath === undefined) {
      throw new Error('participant-served registration is missing its durable serving socket')
    }
    return {
      schemaVersion: 'participant-hosting-intent/v1',
      join: registration.join,
      presentation,
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
  const brokerStderrPath = join(dirname(brokerIpcSocketPath), 'broker.err')
  const brokerArgv = [
    brokerBinary,
    'run',
    '--transport',
    'unix',
    '--socket',
    brokerIpcSocketPath,
    '--event-ledger',
    eventLedgerPath,
    '--runtime-id',
    attempt.runtimeId,
    '--host-session-id',
    registration.hostSessionId,
    '--generation',
    String(registration.generation),
    '--attach-token-file',
    attachTokenPath,
  ]
  const brokerCommand = `exec ${brokerArgv.map(shellQuote).join(' ')} 2>${shellQuote(brokerStderrPath)}`

  return {
    schemaVersion: 'participant-hosting-intent/v1',
    join: registration.join,
    presentation,
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
      brokerArgv,
      brokerCommand,
      tmuxSocketPath: btmuxSocketPath,
      sessionName,
      eventLedgerPath,
    },
  }
}
