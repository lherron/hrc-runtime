import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ParticipantAttempt, ParticipantRegistration } from 'hrc-store-sqlite'
import type {
  InvocationDispatchRequest,
  InvocationRuntimeContext,
} from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'

import { filterBrokerDispatchEnvForLockedEnv } from './broker-decisions.js'
import type { DurableTmuxManagerLike } from './broker-interactive-handlers/substrate-allocator.js'
import type { ParticipantHostingIntent } from './participant-hosting-intent.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { timestamp } from './server-util.js'
import { getBrokerTmuxSocketPath } from './tmux-socket.js'
import { createTmuxManager } from './tmux.js'

type TmuxWindow = {
  socketPath: string
  sessionName: string
  windowName: string
  sessionId: string
  windowId: string
  paneId: string
}

type InspectableTmuxManager = DurableTmuxManagerLike & {
  inspectWindow(input: { sessionName: string; windowName: string }): Promise<TmuxWindow | null>
}

type ObservedPaneProcess = NonNullable<
  Awaited<ReturnType<NonNullable<DurableTmuxManagerLike['inspectPaneProcess']>>>
>

/**
 * HRC's observed resource boundary. It intentionally contains concrete lease
 * identities, unlike the prior hosting intent, and is persisted before the
 * immutable broker dispatch envelope is made.
 */
export type ParticipantRealizedHosting = {
  schemaVersion: 'participant-realized-hosting/v1'
  endpoint: ParticipantHostingIntent['endpoint']
  substrate:
    | { kind: 'external' }
    | { kind: 'leased-tmux'; brokerWindow: TmuxWindow; pid: number; command: string }
  presentation: { kind: 'none' } | { kind: 'tmux-tui'; tuiWindow: TmuxWindow }
}

function parseJson<T>(json: string | undefined, label: string): T {
  if (json === undefined) throw new Error(`participant attempt is missing ${label}`)
  try {
    return JSON.parse(json) as T
  } catch {
    throw new Error(`participant attempt has invalid ${label}`)
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function sameWindow(actual: TmuxWindow, expected: TmuxWindow): boolean {
  return (
    actual.socketPath === expected.socketPath &&
    actual.sessionName === expected.sessionName &&
    actual.windowName === expected.windowName &&
    actual.sessionId === expected.sessionId &&
    actual.windowId === expected.windowId &&
    actual.paneId === expected.paneId
  )
}

function toWindow(window: TmuxWindow): TmuxWindow {
  return {
    socketPath: window.socketPath,
    sessionName: window.sessionName,
    windowName: window.windowName,
    sessionId: window.sessionId,
    windowId: window.windowId,
    paneId: window.paneId,
  }
}

function presentationRuntime(
  realized: ParticipantRealizedHosting
): InvocationRuntimeContext | undefined {
  if (realized.presentation.kind === 'none') return undefined
  const tui = realized.presentation.tuiWindow
  return {
    terminalSurface: {
      kind: 'tmux-pane',
      ownership: 'hrc',
      socketPath: tui.socketPath,
      sessionId: tui.sessionId,
      windowId: tui.windowId,
      paneId: tui.paneId,
      sessionName: tui.sessionName,
      windowName: tui.windowName,
      allowedOps: {
        inspect: true,
        sendInput: true,
        sendInterrupt: true,
        capture: true,
        resize: false,
      },
    },
    terminalSurfaceRequired: true,
  }
}

function freezeDispatch(
  profile: BrokerExecutionProfile,
  adapterDispatchEnvJson: string | undefined,
  intent: ParticipantHostingIntent,
  realized: ParticipantRealizedHosting
): InvocationDispatchRequest {
  const storedEnv =
    adapterDispatchEnvJson === undefined
      ? undefined
      : parseJson<unknown>(adapterDispatchEnvJson, 'adapter dispatch environment')
  const parsedEnv = storedEnv === null ? undefined : storedEnv
  if (parsedEnv !== undefined && !isStringRecord(parsedEnv)) {
    throw new Error('participant attempt has an invalid adapter dispatch environment')
  }
  const dispatchEnv = filterBrokerDispatchEnvForLockedEnv(
    parsedEnv,
    profile.harnessInvocation.startRequest
  )
  const runtime = presentationRuntime(realized)
  return {
    startRequest: profile.harnessInvocation.startRequest,
    ...(dispatchEnv === undefined ? {} : { dispatchEnv }),
    ...(runtime === undefined ? {} : { runtime }),
    lifecyclePolicy: intent.lifecyclePolicy,
  }
}

function assertJoinOwnership(
  registration: ParticipantRegistration,
  profile: BrokerExecutionProfile
): void {
  const expected =
    registration.join === 'hrc-hosted' ? 'hrc-owned-process' : 'participant-owned-process'
  if (profile.brokerOwnership !== expected) {
    throw new Error(`participant profile ownership does not match ${registration.join}`)
  }
}

async function inspectedWindow(
  tmux: DurableTmuxManagerLike,
  sessionName: string,
  windowName: string
): Promise<TmuxWindow | null> {
  const window = await tmux.createOrInspectWindow({ sessionName, windowName })
  return toWindow(window)
}

function requireInspectableTmux(tmux: DurableTmuxManagerLike): InspectableTmuxManager {
  if (typeof (tmux as Partial<InspectableTmuxManager>).inspectWindow !== 'function') {
    throw new Error('participant realization requires named-window inspection')
  }
  return tmux as InspectableTmuxManager
}

function assertCommittedHostedWriter(
  process: ObservedPaneProcess,
  hosted: NonNullable<ParticipantHostingIntent['hrcHosted']>
): void {
  if (process.dead || process.pid <= 0) {
    throw new Error('participant broker did not realize a live process')
  }
  // The shipped broker is a Bun shebang script. macOS `ps` reports its post-exec
  // form as `bun <persisted-script-argv...>`; it does not expose a structured
  // argv vector. Compare that observed representation as a complete value, not
  // as a token parser or a substring predicate. This makes it only a live
  // process candidate check: installIdentity below remains the broker-owned
  // identity authority before this attempt may ensure an invocation.
  const commandLine = process.commandLine
  const expectedCommandLine = `bun ${hosted.brokerArgv.join(' ')}`
  if (process.command !== 'bun' || commandLine !== expectedCommandLine) {
    throw new Error('participant broker writer does not match the committed launch identity')
  }
}

async function realizeHosted(
  server: HrcServerInstanceForHandlers,
  intent: ParticipantHostingIntent
): Promise<ParticipantRealizedHosting> {
  const hosted = intent.hrcHosted
  if (hosted === undefined)
    throw new Error('hrc-hosted participant is missing its HRC hosting intent')
  // The intent commits an HRC-owned tmux socket path, but the durable IPC
  // boundary only creates its sibling directory. Establish the tmux parent
  // before the first resource effect so a fresh runtime root can realize it.
  await mkdir(dirname(hosted.tmuxSocketPath), { recursive: true, mode: 0o700 })
  const tmux = (server.brokerTmuxManagerFactory ?? createTmuxManager)({
    socketPath: hosted.tmuxSocketPath,
  })
  await tmux.initialize()

  const inspectable = requireInspectableTmux(tmux)
  let broker = await inspectable.inspectWindow({
    sessionName: hosted.sessionName,
    windowName: 'broker',
  })
  // A bare broker window proves only that the named resource exists, not that
  // the broker was launched. Creation is authorized solely by the committed
  // intent and uses its exact shell rendering.
  if (broker === null) {
    broker = await tmux.createWindowWithCommand({
      sessionName: hosted.sessionName,
      windowName: 'broker',
      command: hosted.brokerCommand,
    })
  }
  const process = await tmux.inspectPaneProcess?.(broker.paneId)
  if (process === undefined) {
    throw new Error('participant broker realization requires pane process inspection')
  }
  if (process === null) throw new Error('participant broker did not realize a live process')
  assertCommittedHostedWriter(process, hosted)

  const tui =
    intent.presentation.kind === 'tmux-tui'
      ? await inspectedWindow(tmux, hosted.sessionName, 'tui')
      : null
  if (intent.presentation.kind === 'tmux-tui' && tui === null) {
    throw new Error('participant requested presentation could not be realized')
  }

  return {
    schemaVersion: 'participant-realized-hosting/v1',
    endpoint: intent.endpoint,
    substrate: {
      kind: 'leased-tmux',
      brokerWindow: toWindow(broker),
      pid: process.pid,
      command: process.command,
    },
    presentation: tui === null ? { kind: 'none' } : { kind: 'tmux-tui', tuiWindow: tui },
  }
}

async function realizeParticipantServed(
  server: HrcServerInstanceForHandlers,
  attempt: ParticipantAttempt,
  intent: ParticipantHostingIntent,
  profile: BrokerExecutionProfile
): Promise<ParticipantRealizedHosting> {
  if (intent.hrcHosted !== undefined) {
    throw new Error('participant-served participant must not carry an HRC broker process intent')
  }
  if (intent.presentation.kind === 'none') {
    return {
      schemaVersion: 'participant-realized-hosting/v1',
      endpoint: intent.endpoint,
      substrate: { kind: 'external' },
      presentation: { kind: 'none' },
    }
  }

  // The participant retains its broker process. This is only the separately
  // HRC-owned operator presentation resource required by the selected profile.
  const tmuxSocketPath = getBrokerTmuxSocketPath(
    server.options,
    `presentation-${profile.brokerDriver}`,
    attempt.runtimeId
  )
  const sessionName = `hrc-presentation-${attempt.runtimeId}`
  const tmux = (server.brokerTmuxManagerFactory ?? createTmuxManager)({
    socketPath: tmuxSocketPath,
  })
  await tmux.initialize()
  const tui = await inspectedWindow(tmux, sessionName, 'tui')
  if (tui === null) throw new Error('participant presentation could not be realized')
  return {
    schemaVersion: 'participant-realized-hosting/v1',
    endpoint: intent.endpoint,
    substrate: { kind: 'external' },
    presentation: { kind: 'tmux-tui', tuiWindow: tui },
  }
}

async function validateRediscovery(
  server: HrcServerInstanceForHandlers,
  realized: ParticipantRealizedHosting,
  intent: ParticipantHostingIntent
): Promise<void> {
  if (realized.substrate.kind === 'leased-tmux') {
    const broker = realized.substrate.brokerWindow
    const tmux = (server.brokerTmuxManagerFactory ?? createTmuxManager)({
      socketPath: broker.socketPath,
    })
    await tmux.initialize()
    const observed = await requireInspectableTmux(tmux).inspectWindow({
      sessionName: broker.sessionName,
      windowName: broker.windowName,
    })
    if (observed === null || !sameWindow(toWindow(observed), broker)) {
      throw new Error('persisted participant broker lease no longer matches the realized resource')
    }
    const process = await tmux.inspectPaneProcess?.(broker.paneId)
    if (
      process === undefined ||
      process === null ||
      process.pid !== realized.substrate.pid ||
      process.command !== realized.substrate.command
    ) {
      throw new Error('persisted participant broker writer cannot be verified')
    }
    if (intent.hrcHosted === undefined) {
      throw new Error('persisted participant broker lease has no committed hosting identity')
    }
    assertCommittedHostedWriter(process, intent.hrcHosted)
  }
  if (realized.presentation.kind === 'tmux-tui') {
    const tui = realized.presentation.tuiWindow
    const tmux = (server.brokerTmuxManagerFactory ?? createTmuxManager)({
      socketPath: tui.socketPath,
    })
    await tmux.initialize()
    const observed = await requireInspectableTmux(tmux).inspectWindow({
      sessionName: tui.sessionName,
      windowName: tui.windowName,
    })
    if (observed === null || !sameWindow(toWindow(observed), tui)) {
      throw new Error(
        'persisted participant presentation lease no longer matches the realized resource'
      )
    }
  }
}

/**
 * Advances only boundaries two→three. It never calls `installIdentity`,
 * `hello`, or `ensureInvocation`: callers may schedule those only after the
 * complete dispatch bytes below have committed.
 */
export async function realizeAndFreezeParticipantDispatch(
  server: HrcServerInstanceForHandlers,
  registration: ParticipantRegistration,
  initialAttempt: ParticipantAttempt
): Promise<ParticipantAttempt> {
  let attempt =
    server.db.participantRegistrations.getAttempt(initialAttempt.attemptId) ?? initialAttempt
  const intent = parseJson<ParticipantHostingIntent>(attempt.hostingIntentJson, 'hosting intent')
  if (attempt.state === 'DISPATCH_FROZEN' || attempt.state === 'INSTALL_CONFIRMED') {
    const realized = parseJson<ParticipantRealizedHosting>(
      attempt.realizedHostingJson,
      'realized hosting'
    )
    // Frozen bytes are immutable, not an evergreen resource assertion. Every
    // eventual install/ensure retry first proves the exact lease/writer still
    // exists, and blocks if it cannot.
    await validateRediscovery(server, realized, intent)
    return attempt
  }
  if (!['HOSTING_INTENT_PERSISTED', 'REALIZED'].includes(attempt.state)) {
    throw new Error(`participant attempt cannot realize from ${attempt.state}`)
  }
  const profile = parseJson<BrokerExecutionProfile>(attempt.preparedProfileJson, 'prepared profile')
  assertJoinOwnership(registration, profile)

  let realized =
    attempt.realizedHostingJson === undefined
      ? undefined
      : parseJson<ParticipantRealizedHosting>(attempt.realizedHostingJson, 'realized hosting')
  if (realized === undefined) {
    realized =
      registration.join === 'hrc-hosted'
        ? await realizeHosted(server, intent)
        : await realizeParticipantServed(server, attempt, intent, profile)
    const now = timestamp()
    server.db.sqlite.transaction(() => {
      server.db.participantRegistrations.setSnapshotIfAbsent(
        attempt.attemptId,
        'realizedHostingJson',
        JSON.stringify(realized),
        now
      )
      server.db.participantRegistrations.transitionAttempt(
        attempt.attemptId,
        ['HOSTING_INTENT_PERSISTED'],
        'REALIZED',
        now
      )
    })()
    attempt = server.db.participantRegistrations.getAttempt(attempt.attemptId) ?? attempt
  } else {
    await validateRediscovery(server, realized, intent)
  }

  if (attempt.dispatchJson !== undefined || attempt.state === 'DISPATCH_FROZEN') return attempt
  if (attempt.state !== 'REALIZED' || attempt.realizedHostingJson === undefined) {
    throw new Error('participant realized hosting was not durably committed')
  }
  const persistedRealized = parseJson<ParticipantRealizedHosting>(
    attempt.realizedHostingJson,
    'realized hosting'
  )
  await validateRediscovery(server, persistedRealized, intent)
  const dispatch = freezeDispatch(
    profile,
    attempt.adapterDispatchEnvJson,
    intent,
    persistedRealized
  )
  const now = timestamp()
  server.db.sqlite.transaction(() => {
    server.db.participantRegistrations.setSnapshotIfAbsent(
      attempt.attemptId,
      'dispatchJson',
      JSON.stringify(dispatch),
      now
    )
    server.db.participantRegistrations.transitionAttempt(
      attempt.attemptId,
      ['REALIZED'],
      'DISPATCH_FROZEN',
      now
    )
  })()
  return server.db.participantRegistrations.getAttempt(attempt.attemptId) ?? attempt
}
