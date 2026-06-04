/**
 * RED test (T-01733 / T-01730 GAP 2) — broker-tmux GENERATION PERSISTENCE.
 *
 * Governing plan: C-02889 on T-01730. Restart reconcile must be able to tell a
 * re-associated lease from a stale one across a generation rotation. For that
 * the persisted lease has to carry the runtime `generation` it was allocated
 * for — both in `runtime.tmuxJson` (the canonical lease projection) and in
 * `runtime.runtimeStateJson.tmux` (the runtime-state mirror).
 *
 * At HEAD the controller persists the pane ids + socket + driver but NOT the
 * generation, so this test fails: `generation` is absent from both shapes. It
 * turns green once `paneIdsFromAllocation` / `extractRuntimeStateTmux` thread
 * the allocation/runtime generation through.
 *
 * Uses a compact fake BrokerClient; no live broker process is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type HrcDatabase, openHrcDatabase } from 'hrc-store-sqlite'
import type {
  BrokerHealthResponse,
  BrokerHelloResponse,
  InvocationCapabilities,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusResponse,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'

import { type BrokerClientLike, HarnessBrokerController } from '../broker/controller'

import { makeCompileResponse, makeIdentity, makeInteractiveTmuxProfile } from './broker-compile-fixtures'

const NOW = '2026-05-28T12:00:00.000Z'

function invocationCapabilities(): InvocationCapabilities {
  return {
    input: {
      user: true,
      steer: true,
      appendContext: true,
      localImages: true,
      fileRefs: true,
      queue: false,
    },
    turns: { concurrency: 'single', interrupt: 'protocol' },
    continuation: { supported: true, provider: 'openai', keyKind: 'thread' },
    events: {
      assistantDeltas: true,
      toolCalls: true,
      usage: true,
      diagnostics: true,
      replay: false,
      ack: false,
    },
    control: { stop: true, dispose: true, status: true, attach: false },
    permissions: { brokerToClientRequests: true, eventAudit: true },
  } as unknown as InvocationCapabilities
}

/** Async iterable that closes immediately (no events needed for the start path). */
class EmptyEvents implements AsyncIterable<InvocationEventEnvelope> {
  [Symbol.asyncIterator](): AsyncIterator<InvocationEventEnvelope> {
    return {
      next: () => Promise.resolve({ done: true, value: undefined }),
    }
  }
}

class FakeBrokerClient implements BrokerClientLike {
  startCalls = 0
  helloResponse: BrokerHelloResponse = {
    brokerInfo: { name: 'harness-broker', version: '0.2.0-test' },
    protocolVersion: 'harness-broker/0.2',
    capabilities: {
      multiInvocation: false,
      transports: ['stdio-jsonrpc-ndjson'],
      eventNotifications: true,
      brokerToClientRequests: true,
    },
    drivers: [
      {
        kind: 'claude-code-tmux',
        version: '0.1.1-test',
        available: true,
        capabilities: invocationCapabilities(),
      },
    ],
  }

  startResponse: InvocationStartResponse = {
    invocationId: 'invocation_w2',
    state: 'ready',
    capabilities: invocationCapabilities(),
  }

  async hello(): Promise<BrokerHelloResponse> {
    return this.helloResponse
  }

  async health(): Promise<BrokerHealthResponse> {
    return { status: 'ok', activeInvocations: 0, drivers: this.helloResponse.drivers }
  }

  async startInvocationFromRequest(): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }> {
    this.startCalls += 1
    return {
      invocationId: this.startResponse.invocationId,
      response: this.startResponse,
      events: new EmptyEvents(),
    }
  }

  async input(): Promise<InvocationInputResponse> {
    return { inputId: 'i', accepted: true, disposition: 'started' }
  }

  async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    return { accepted: true, effect: 'turn_interrupted' }
  }

  async stop(): Promise<InvocationStopResponse> {
    return { accepted: true, state: 'stopping' }
  }

  async status(): Promise<InvocationStatusResponse> {
    return this.startResponse as unknown as InvocationStatusResponse
  }

  async dispose(_req: InvocationDisposeRequest): Promise<void> {}

  onPermissionRequest(
    _handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void {}

  onClose(_handler: (error: Error) => void): void {}

  async close(): Promise<void> {}
}

let db: HrcDatabase
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-pane-lease-generation-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: 'hostSession_w2',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-01733',
    laneRef: 'main',
    generation: 7,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('RED (GAP 2): broker-tmux persists generation in lease projections', () => {
  it('writes the allocated generation into tmuxJson AND runtimeStateJson.tmux', async () => {
    const generation = 7
    const identity = makeIdentity({
      runtimeId: 'runtime_tmux_gen',
      invocationId: 'invocation_tmux_gen',
      runId: 'run_tmux_gen',
      generation,
    })
    const { profile, startRequest } = makeInteractiveTmuxProfile(identity)
    const response = makeCompileResponse(identity, [profile])
    if (!response.ok) throw new Error('fixture compile response unexpectedly failed')

    const fake = new FakeBrokerClient()
    fake.startResponse = { ...fake.startResponse, invocationId: 'invocation_tmux_gen' }

    const controller = new HarnessBrokerController({
      db,
      brokerClientFactory: async () => fake,
      tmuxAllocator: {
        async allocate({ runtimeId, brokerDriver }) {
          const sessionName = `hrc-${brokerDriver}-${runtimeId}`
          return {
            socketPath: `/tmp/hrc-runtime/${brokerDriver}/${runtimeId}/tmux.sock`,
            allocatedAt: NOW,
            lease: {
              kind: 'tmux-pane',
              ownership: 'hrc',
              socketPath: `/tmp/hrc-runtime/${brokerDriver}/${runtimeId}/tmux.sock`,
              sessionId: '$1',
              windowId: '@1',
              paneId: '%1',
              sessionName,
              windowName: 'main',
              allowedOps: {
                inspect: true,
                sendInput: true,
                sendInterrupt: true,
                capture: true,
                resize: false,
              },
            },
          } as never
        },
      },
      now: () => NOW,
    })

    const result = await controller.start({
      plan: response.plan,
      profile,
      startRequest,
      specHash: profile.harnessInvocation.specHash,
      startRequestHash: profile.harnessInvocation.startRequestHash,
      identity,
      dispatchEnv: { HRC_DISPATCH: 'yes' },
    })
    expect(result.ok).toBe(true)

    const runtime = db.runtimes.getByRuntimeId('runtime_tmux_gen')
    expect(runtime?.tmuxJson?.['generation']).toBe(generation)
    const stateTmux = runtime?.runtimeStateJson?.['tmux'] as Record<string, unknown> | undefined
    expect(stateTmux?.['generation']).toBe(generation)
  })
})
