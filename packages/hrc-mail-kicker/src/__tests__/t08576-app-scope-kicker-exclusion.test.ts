/**
 * T-08576 D2 completeness: app sessions are not wrkq mail targets.
 *
 * These tests keep the local reconciliation/disposal work real and observable while recording
 * every ledger call. The application-scope rows are negative guards: local cleanup must still
 * happen, but no app:* target may cross the wrkq ledger boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'

import type { HrcMailDriveWakeReason } from 'hrc-store-sqlite'
import type { MailKickerContext } from '../context.js'
import { observeMailDriveLifecycleEvent } from '../controller.js'
import { driveMailTargetOnce } from '../drive/target-driver.js'
import type { T08094Harness } from './t08094-harness.js'
import {
  HOST_SESSION_ID,
  RUNTIME_ID,
  SCOPE_REF,
  TARGET_REF,
  createT08094Harness,
  destroyT08094Harness,
} from './t08094-harness.js'

const APP_SCOPE = 'app:t08576'
const APP_LANE = 'assistant'
const APP_TARGET = `${APP_SCOPE}/lane:${APP_LANE}`
const APP_HOST_SESSION = 'hsid-t08576-app-kicker'
const APP_RUNTIME = 'rt-t08576-app-kicker'

type LedgerCall = { method: string; args: unknown[] }

let harness: T08094Harness

beforeEach(async () => {
  harness = await createT08094Harness()
})

afterEach(async () => {
  await destroyT08094Harness(harness)
})

function installRecordingLedger(context: MailKickerContext): LedgerCall[] {
  const calls: LedgerCall[] = []
  const target = context.ledger as object
  context.ledger = new Proxy(target, {
    get(ledger, property, receiver) {
      const value: unknown = Reflect.get(ledger, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args })
        return Reflect.apply(value, ledger, args)
      }
    },
  }) as MailKickerContext['ledger']
  return calls
}

function pendingViewScopes(calls: LedgerCall[]): string[][] {
  return calls
    .filter((call) => call.method === 'pendingView')
    .map((call) => {
      const params = call.args[0] as { scopes?: string[] } | undefined
      return params?.scopes ?? []
    })
}

function insertAppRuntime(): HrcSessionRecord {
  const now = new Date().toISOString()
  harness.db.sessions.insert({
    hostSessionId: APP_HOST_SESSION,
    scopeRef: APP_SCOPE,
    laneRef: APP_LANE,
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  harness.db.runtimes.insert({
    runtimeId: APP_RUNTIME,
    hostSessionId: APP_HOST_SESSION,
    scopeRef: APP_SCOPE,
    laneRef: APP_LANE,
    generation: 1,
    transport: 'tmux',
    harness: 'claude-code',
    provider: 'anthropic',
    status: 'busy',
    supportsInflightInput: true,
    adopted: false,
    createdAt: now,
    updatedAt: now,
  })
  const session = harness.db.sessions.getByHostSessionId(APP_HOST_SESSION)
  if (session === null) throw new Error('app kicker fixture session missing')
  return session
}

function lifecycleEvent(input: {
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  eventKind: string
  hrcSeq: number
}): HrcLifecycleEvent {
  return {
    hrcSeq: input.hrcSeq,
    streamSeq: input.hrcSeq,
    ts: new Date().toISOString(),
    hostSessionId: input.hostSessionId,
    scopeRef: input.scopeRef,
    laneRef: input.laneRef,
    generation: 1,
    runtimeId: input.runtimeId,
    category: input.eventKind.startsWith('runtime.') ? 'runtime' : 'turn',
    eventKind: input.eventKind,
    replayed: false,
    payload: {},
  }
}

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function seedOpenIntent(targetSessionRef: string, runtimeId: string, suffix: string): string {
  const envelope = harness.ledger.say()
  const opened = harness.db.mailDelivery.openIntent({
    envelopeId: envelope.id,
    targetSessionRef,
    door: 'steer',
    form: 'full',
    presentationId: `present-${suffix}`,
    runtimeId,
    submittedHrcSeq: 1,
  })
  if (opened === undefined) throw new Error('failed to seed kicker intent')
  return envelope.id
}

function seedLandedPresentation(
  targetSessionRef: string,
  runtimeId: string,
  suffix: string
): string {
  const envelope = harness.ledger.say()
  envelope.state = 'presented'
  envelope.presentedTo = [
    {
      memberRef: targetSessionRef,
      runtimeId,
      driveAttemptId: `present-${suffix}`,
      presentedAt: new Date().toISOString(),
    },
  ]
  harness.db.mailDelivery.recordPresentation({
    envelopeId: envelope.id,
    runtimeId,
    targetSessionRef,
    generation: 1,
    presentationId: `present-${suffix}`,
    deliveryOutcome: 'steered',
    landingHrcSeq: 10,
  })
  if (!harness.db.mailDelivery.markReceiptCommitted(envelope.id, runtimeId)) {
    throw new Error('failed to commit kicker presentation receipt')
  }
  return envelope.id
}

function installDeterministicWake(context: MailKickerContext): Promise<unknown>[] {
  const operations: Promise<unknown>[] = []
  context.wake = (targetSessionRef: string, reason: HrcMailDriveWakeReason) => {
    operations.push(driveMailTargetOnce(context, targetSessionRef, reason))
  }
  return operations
}

async function observeRuntimeTerminal(input: {
  context: MailKickerContext
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  targetSessionRef: string
  suffix: string
}): Promise<{ envelopeId: string }> {
  const envelopeId = seedOpenIntent(input.targetSessionRef, input.runtimeId, input.suffix)
  harness.db.runtimes.updateStatus(input.runtimeId, 'terminated', new Date().toISOString())
  observeMailDriveLifecycleEvent.call(
    input.context,
    lifecycleEvent({
      ...input,
      eventKind: 'runtime.terminated',
      hrcSeq: 20,
    })
  )
  await waitFor(
    `${input.suffix} intent reconciliation`,
    () =>
      harness.db.mailDelivery.getIntent(envelopeId)?.uncertainCause ===
      'runtime_terminated_before_landing'
  )
  await Promise.resolve()
  return { envelopeId }
}

async function observeTurnCompleted(input: {
  context: MailKickerContext
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  targetSessionRef: string
  suffix: string
}): Promise<{ envelopeId: string; wakeOperations: Promise<unknown>[] }> {
  const envelopeId = seedLandedPresentation(input.targetSessionRef, input.runtimeId, input.suffix)
  const wakeOperations = installDeterministicWake(input.context)
  observeMailDriveLifecycleEvent.call(
    input.context,
    lifecycleEvent({
      ...input,
      eventKind: 'turn.completed',
      hrcSeq: 20,
    })
  )
  await Promise.all([...input.context.mailKickerDisposalsPending])
  await Promise.all(wakeOperations)
  return { envelopeId, wakeOperations }
}

describe('T-08576 app-scope kicker exclusion', () => {
  it('R-K1 reconciles an app runtime terminal locally without reading wrkq', async () => {
    const appSession = insertAppRuntime()
    const calls = installRecordingLedger(harness.context)
    harness.context.port.findTargetSession = (target) =>
      target === APP_TARGET ? appSession : harness.session

    const { envelopeId } = await observeRuntimeTerminal({
      context: harness.context,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      hostSessionId: APP_HOST_SESSION,
      runtimeId: APP_RUNTIME,
      targetSessionRef: APP_TARGET,
      suffix: 't08576-rk1-app',
    })

    expect({
      pendingViewScopes: pendingViewScopes(calls),
      localIntentCause: harness.db.mailDelivery.getIntent(envelopeId)?.uncertainCause,
    }).toEqual({
      pendingViewScopes: [],
      localIntentCause: 'runtime_terminated_before_landing',
    })
  })

  it('R-K2 disposes an app turn locally without waking a wrkq read', async () => {
    const appSession = insertAppRuntime()
    const calls = installRecordingLedger(harness.context)
    harness.context.port.findTargetSession = (target) =>
      target === APP_TARGET ? appSession : harness.session

    const { envelopeId, wakeOperations } = await observeTurnCompleted({
      context: harness.context,
      scopeRef: APP_SCOPE,
      laneRef: APP_LANE,
      hostSessionId: APP_HOST_SESSION,
      runtimeId: APP_RUNTIME,
      targetSessionRef: APP_TARGET,
      suffix: 't08576-rk2-app',
    })

    expect({
      pendingViewScopes: pendingViewScopes(calls),
      wakeCount: wakeOperations.length,
      reminderArmed:
        harness.db.mailDelivery.getPresentation(envelopeId, APP_RUNTIME)?.reminderArmedAt !==
        undefined,
      ledgerMethods: calls.map((call) => call.method),
    }).toEqual({
      pendingViewScopes: [],
      wakeCount: 0,
      reminderArmed: true,
      ledgerMethods: ['envelopeShow'],
    })
  })

  it('control keeps the agent runtime-terminal wrkq lapse read', async () => {
    const calls = installRecordingLedger(harness.context)
    const { envelopeId } = await observeRuntimeTerminal({
      context: harness.context,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      targetSessionRef: TARGET_REF,
      suffix: 't08576-rk1-agent',
    })

    expect({
      pendingViewScopes: pendingViewScopes(calls),
      localIntentCause: harness.db.mailDelivery.getIntent(envelopeId)?.uncertainCause,
    }).toEqual({
      pendingViewScopes: [[TARGET_REF]],
      localIntentCause: 'runtime_terminated_before_landing',
    })
  })

  it('control keeps the agent turn-terminal disposal and wrkq wake read', async () => {
    const calls = installRecordingLedger(harness.context)
    const { envelopeId, wakeOperations } = await observeTurnCompleted({
      context: harness.context,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      targetSessionRef: TARGET_REF,
      suffix: 't08576-rk2-agent',
    })

    expect({
      pendingViewScopes: pendingViewScopes(calls),
      wakeCount: wakeOperations.length,
      reminderArmed:
        harness.db.mailDelivery.getPresentation(envelopeId, RUNTIME_ID)?.reminderArmedAt !==
        undefined,
    }).toEqual({
      pendingViewScopes: [[TARGET_REF]],
      wakeCount: 1,
      reminderArmed: true,
    })
  })
})
