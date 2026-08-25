import { expect } from 'bun:test'

import type { HrcRuntimeIntent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { BrokerEventMapper } from '../../broker/event-mapper'
import type { HrcServer } from '../../index'

import type { HrcServerTestFixture } from './hrc-test-fixture'

const SCOPE_REF = 'agent:smokey:project:hrc-runtime:task:T-05095'
const PROVIDER = 'openai' as const

export function createT05095Helpers(
  fixture: HrcServerTestFixture,
  getServer: () => HrcServer | undefined
) {
  function headlessBrokerIntent(): object {
    return {
      placement: {
        agentRoot: fixture.tmpDir,
        projectRoot: fixture.tmpDir,
        cwd: fixture.tmpDir,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
      },
      harness: {
        provider: PROVIDER,
        interactive: false,
      },
      execution: {
        preferredMode: 'headless',
      },
    }
  }

  function codexHeadlessIntent(): HrcRuntimeIntent {
    return {
      placement: {
        agentRoot: fixture.tmpDir,
        projectRoot: fixture.tmpDir,
        cwd: fixture.tmpDir,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
      },
      harness: { provider: PROVIDER, interactive: false, id: 'codex-cli' },
      execution: { preferredMode: 'nonInteractive' },
    }
  }

  function codexInteractiveIntent(): HrcRuntimeIntent {
    return {
      placement: {
        agentRoot: fixture.tmpDir,
        projectRoot: fixture.tmpDir,
        cwd: fixture.tmpDir,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
      },
      harness: { provider: PROVIDER, interactive: true, id: 'codex-cli' },
      execution: { preferredMode: 'interactive' },
    }
  }

  function claudeSdkIntent(allowInteractiveSurfaceReuse: boolean | undefined): HrcRuntimeIntent {
    return {
      placement: {
        agentRoot: fixture.tmpDir,
        projectRoot: fixture.tmpDir,
        cwd: fixture.tmpDir,
        runMode: 'task',
        bundle: { kind: 'compose', compose: [] },
        dryRun: true,
      },
      harness: { provider: 'anthropic', interactive: false, id: 'agent-sdk' },
      execution: {
        preferredMode: 'nonInteractive',
        ...(allowInteractiveSurfaceReuse !== undefined ? { allowInteractiveSurfaceReuse } : {}),
      },
    }
  }

  function installDispatchInputSpy(): { calls: Array<Record<string, unknown>> } {
    const state = { calls: [] as Array<Record<string, unknown>> }
    ;(getServer() as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: Record<string, unknown>) => {
        state.calls.push(request)
        return {
          ok: true,
          response: {
            inputId: `input-t05095-${state.calls.length}`,
            accepted: true,
            disposition: 'queued',
          },
        }
      },
      waitForAttachedStartReady: async () => Promise.reject(new Error('not applicable')),
    })
    return state
  }

  function installMapperBackedDispatchInputSpy(): { calls: Array<Record<string, unknown>> } {
    const state = { calls: [] as Array<Record<string, unknown>> }
    ;(getServer() as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: {
        runtimeId: string
        input: { inputId: string; metadata?: { runId?: string; repairCorrelationJson?: string } }
      }) => {
        state.calls.push(request as unknown as Record<string, unknown>)
        const db = openHrcDatabase(fixture.dbPath)
        try {
          const runtime = db.runtimes.getByRuntimeId(request.runtimeId)
          if (!runtime?.activeInvocationId) {
            throw new Error(`test dispatch input missing invocation for ${request.runtimeId}`)
          }
          const mapper = new BrokerEventMapper({ db, now: () => new Date().toISOString() })
          const startSeq = db.brokerInvocationEvents.maxBrokerSeq(runtime.activeInvocationId)
          const now = new Date().toISOString()
          const accepted: InvocationEventEnvelope = {
            invocationId: runtime.activeInvocationId,
            seq: startSeq + 1,
            time: now,
            type: 'input.accepted',
            inputId: request.input.inputId as InvocationEventEnvelope['inputId'],
            payload: { inputId: request.input.inputId, accepted: true } as any,
          } as InvocationEventEnvelope
          const completed: InvocationEventEnvelope = {
            invocationId: runtime.activeInvocationId,
            seq: startSeq + 2,
            time: now,
            type: 'turn.completed',
            inputId: request.input.inputId as InvocationEventEnvelope['inputId'],
            payload: { status: 'completed', finalOutput: 'repair complete' } as any,
          } as InvocationEventEnvelope

          // The broker did not provide correlation. HRC owns json_repair
          // correlation and must stamp it before persisting broker_envelope_json.
          mapper.apply(accepted)
          mapper.apply(completed)
        } finally {
          db.close()
        }
        return {
          ok: true,
          response: {
            inputId: request.input.inputId,
            accepted: true,
            disposition: 'started',
          },
        }
      },
      waitForAttachedStartReady: async () => Promise.reject(new Error('not applicable')),
    })
    return state
  }

  function seedQueueCapableBrokerWithLiveRun(input: {
    hostSessionId: string
    generation: number
    runtimeId: string
    invocationId: string
    activeRunId: string
  }): void {
    const db = openHrcDatabase(fixture.dbPath)
    const now = new Date().toISOString()
    const operationId = `op-${input.runtimeId}`

    try {
      db.runtimes.insert({
        runtimeId: input.runtimeId,
        hostSessionId: input.hostSessionId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation: input.generation,
        transport: 'headless',
        harness: 'codex-cli',
        provider: PROVIDER,
        // The review gap is a "ready" reusable runtime whose activeRunId still
        // points at a live run. Queue capability must not override explicit reject.
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: input.invocationId,
        activeRunId: input.activeRunId,
        createdAt: now,
        updatedAt: now,
      })
      db.brokerInvocations.insert({
        invocationId: input.invocationId,
        operationId,
        runtimeId: input.runtimeId,
        runId: input.activeRunId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-app-server',
        invocationState: 'turn_active',
        capabilitiesJson: JSON.stringify({ input: { queue: true } }),
        specHash: `sha256:spec-${input.runtimeId}`,
        startRequestHash: `sha256:req-${input.runtimeId}`,
        selectedProfileHash: `sha256:profile-${input.runtimeId}`,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: input.activeRunId,
        hostSessionId: input.hostSessionId,
        runtimeId: input.runtimeId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation: input.generation,
        transport: 'headless',
        status: 'started',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
        operationId,
        invocationId: input.invocationId,
      })
    } finally {
      db.close()
    }
  }

  function seedReadyBrokerRuntime(input: {
    hostSessionId: string
    generation: number
    runtimeId: string
    invocationId: string
    transport?: 'headless' | 'tmux'
    status?: 'ready' | 'busy'
    activeRunId?: string | undefined
    capabilitiesJson?: Record<string, unknown>
    scopeRef?: string
    provider?: 'anthropic' | 'openai'
    harness?: 'claude-code' | 'codex-cli'
    brokerDriver?: 'claude-code-tmux' | 'codex-app-server' | 'codex-cli-tmux'
  }): void {
    const db = openHrcDatabase(fixture.dbPath)
    const now = new Date().toISOString()
    const operationId = `op-${input.runtimeId}`
    const transport = input.transport ?? 'headless'
    const provider = input.provider ?? PROVIDER
    const harness = input.harness ?? 'codex-cli'
    const brokerDriver =
      input.brokerDriver ?? (transport === 'tmux' ? 'codex-cli-tmux' : 'codex-app-server')

    try {
      db.runtimes.insert({
        runtimeId: input.runtimeId,
        hostSessionId: input.hostSessionId,
        scopeRef: input.scopeRef ?? SCOPE_REF,
        laneRef: 'default',
        generation: input.generation,
        transport,
        harness,
        provider,
        status: input.status ?? 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: input.invocationId,
        ...(input.activeRunId !== undefined ? { activeRunId: input.activeRunId } : {}),
        ...(transport === 'tmux'
          ? {
              tmuxJson: {
                sessionId: 's',
                sessionName: 's',
                windowId: 'w',
                paneId: 'p',
                brokerDriver,
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      })
      db.brokerInvocations.insert({
        invocationId: input.invocationId,
        operationId,
        runtimeId: input.runtimeId,
        ...(input.activeRunId !== undefined ? { runId: input.activeRunId } : {}),
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver,
        invocationState: input.activeRunId !== undefined ? 'turn_active' : 'ready',
        capabilitiesJson: JSON.stringify(input.capabilitiesJson ?? { input: { queue: true } }),
        specHash: `sha256:spec-${input.runtimeId}`,
        startRequestHash: `sha256:req-${input.runtimeId}`,
        selectedProfileHash: `sha256:profile-${input.runtimeId}`,
        createdAt: now,
        updatedAt: now,
      })
      if (input.activeRunId !== undefined) {
        db.runs.insert({
          runId: input.activeRunId,
          hostSessionId: input.hostSessionId,
          runtimeId: input.runtimeId,
          scopeRef: input.scopeRef ?? SCOPE_REF,
          laneRef: 'default',
          generation: input.generation,
          transport,
          status: 'started',
          acceptedAt: now,
          startedAt: now,
          updatedAt: now,
          operationId,
          invocationId: input.invocationId,
        })
      }
    } finally {
      db.close()
    }
  }

  function runIdsForRuntime(runtimeId: string): string[] {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.runs.listByRuntimeId(runtimeId).map((run) => run.runId)
    } finally {
      db.close()
    }
  }

  /** Durable control state that a caller's refusal must never touch (T-07397). */
  function runtimeControlState(runtimeId: string): {
    status?: string
    activeRunId?: string | null
  } {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(runtimeId)
      return { status: runtime?.status, activeRunId: runtime?.activeRunId ?? null }
    } finally {
      db.close()
    }
  }

  function eventKindsForRuntime(runtimeId: string): string[] {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.hrcEvents.listFromHrcSeq(1, { runtimeId }).map((event) => event.eventKind)
    } finally {
      db.close()
    }
  }

  /** Admission options with every interactive broker driver enabled. */
  const ALL_BROKERS = {
    claudeCodeTmuxBrokerEnabled: true,
    codexCliTmuxBrokerEnabled: true,
    piTuiTmuxBrokerEnabled: true,
  }

  function turnUserPromptEventsForRuntime(runtimeId: string): unknown[] {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.hrcEvents
        .listFromHrcSeq(1, { runtimeId })
        .filter((event) => event.eventKind === 'turn.user_prompt')
    } finally {
      db.close()
    }
  }

  function persistedBrokerEnvelopes(invocationId: string): InvocationEventEnvelope[] {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      return db.brokerInvocationEvents.listByInvocationId(invocationId).map((row) => {
        if (!row.brokerEnvelopeJson) {
          throw new Error(`missing brokerEnvelopeJson for ${row.invocationId}/${row.seq}`)
        }
        return JSON.parse(row.brokerEnvelopeJson) as InvocationEventEnvelope
      })
    } finally {
      db.close()
    }
  }

  function seedBrokerEventFixture(input: {
    hostSessionId: string
    runtimeId: string
    runId: string
    invocationId: string
    generation: number
    envelope: InvocationEventEnvelope
    runCorrelation?: Record<string, unknown> | undefined
  }): void {
    const db = openHrcDatabase(fixture.dbPath)
    const now = new Date().toISOString()
    const operationId = `op-${input.runtimeId}`

    try {
      db.runtimes.insert({
        runtimeId: input.runtimeId,
        hostSessionId: input.hostSessionId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation: input.generation,
        transport: 'headless',
        harness: 'codex-cli',
        provider: PROVIDER,
        status: 'ready',
        supportsInflightInput: false,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: input.invocationId,
        createdAt: now,
        updatedAt: now,
      })
      db.runs.insert({
        runId: input.runId,
        hostSessionId: input.hostSessionId,
        runtimeId: input.runtimeId,
        scopeRef: SCOPE_REF,
        laneRef: 'default',
        generation: input.generation,
        transport: 'headless',
        status: 'completed',
        acceptedAt: now,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        operationId,
        invocationId: input.invocationId,
      })
      if (input.runCorrelation !== undefined) {
        db.runs.setCorrelationJson(input.runId, JSON.stringify(input.runCorrelation))
      }
      db.brokerInvocations.insert({
        invocationId: input.invocationId,
        operationId,
        runtimeId: input.runtimeId,
        runId: input.runId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: 'codex-app-server',
        invocationState: 'completed',
        capabilitiesJson: JSON.stringify({ input: { queue: true } }),
        specHash: `sha256:spec-${input.runtimeId}`,
        startRequestHash: `sha256:req-${input.runtimeId}`,
        selectedProfileHash: `sha256:profile-${input.runtimeId}`,
        createdAt: now,
        updatedAt: now,
      })
      db.brokerInvocationEvents.appendEvent({
        invocationId: input.invocationId,
        seq: input.envelope.seq,
        time: input.envelope.time,
        type: input.envelope.type,
        runtimeId: input.runtimeId,
        runId: input.runId,
        payload: input.envelope.payload,
        envelopeJson: JSON.stringify(input.envelope),
        projectionStatus: 'projected',
      })
    } finally {
      db.close()
    }
  }

  function brokerEventsPath(input: {
    invocationId: string
    runId: string
    runtimeId: string
    generation: number
    afterSeq?: number
  }): string {
    const params = new URLSearchParams({
      invocationId: input.invocationId,
      runId: input.runId,
      runtimeId: input.runtimeId,
      generation: String(input.generation),
      afterSeq: String(input.afterSeq ?? 0),
      follow: 'false',
    })
    return `/v1/broker-events?${params.toString()}`
  }

  async function readBrokerEvents(input: {
    invocationId: string
    runId: string
    runtimeId: string
    generation: number
  }): Promise<unknown[]> {
    const res = await fixture.fetchSocket(brokerEventsPath(input))
    expect(res.status).toBe(200)
    return (await res.text())
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
  }
  return {
    headlessBrokerIntent,
    codexHeadlessIntent,
    codexInteractiveIntent,
    claudeSdkIntent,
    installDispatchInputSpy,
    installMapperBackedDispatchInputSpy,
    seedQueueCapableBrokerWithLiveRun,
    seedReadyBrokerRuntime,
    runIdsForRuntime,
    runtimeControlState,
    eventKindsForRuntime,
    turnUserPromptEventsForRuntime,
    persistedBrokerEnvelopes,
    seedBrokerEventFixture,
    readBrokerEvents,
    ALL_BROKERS,
  }
}
