/**
 * RED bar for T-05806: runtime-hosting must expose a read-only telemetry
 * extractor that records query identity, a digest of the observed output, and
 * lifecycle facts about the target runtime. The dynamic import keeps this file
 * collectible while the new internal helper/export does not exist yet.
 */

import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import type { HrcRuntimeSnapshot } from 'hrc-core'

function makeRuntime(overrides: Partial<HrcRuntimeSnapshot> = {}): HrcRuntimeSnapshot {
  return {
    runtimeId: 'rt-t05806',
    hostSessionId: 'hsid-t05806',
    scopeRef: 'agent:smokey:project:hrc-runtime:task:T-05806',
    laneRef: 'lane:t05806',
    generation: 7,
    transport: 'headless',
    harness: 'codex',
    provider: 'openai',
    status: 'ready',
    supportsInflightInput: true,
    adopted: false,
    controllerKind: 'harness-broker',
    createdAt: '2026-07-07T17:00:00.000Z',
    updatedAt: '2026-07-07T17:05:00.000Z',
    runtimeStateJson: {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: 'rt-t05806',
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/hrc-test/broker-ipc/rt-t05806.g7.sock',
          attachTokenRef: {
            kind: 'file',
            path: '/tmp/hrc-test/tokens/rt-t05806.g7.token',
            redacted: true,
          },
          protocolVersion: 'harness-broker/0.2',
        },
        substrate: {
          kind: 'leased-tmux',
          tmuxSocketPath: '/tmp/hrc-test/btmux/rt-t05806.sock',
          sessionName: 'hrc-rt-t05806-g7',
          brokerWindow: { sessionId: '$58', windowId: '@106', paneId: '%231' },
          generation: 7,
          eventLedgerPath: '/tmp/hrc-test/broker-ledger/rt-t05806.g7.ndjson',
        },
        presentation: { kind: 'none' },
      },
    },
    ...overrides,
  }
}

function sha256Digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('T-05806 runtime telemetry extractor', () => {
  it('records query identity, output digest, and runtime lifecycle facts without mutating the runtime snapshot', async () => {
    const mod = await import('../broker/runtime-hosting')
    const createRuntimeTelemetryProbe = (mod as Record<string, unknown>)[
      'createRuntimeTelemetryProbe'
    ]
    if (typeof createRuntimeTelemetryProbe !== 'function') {
      expect(typeof createRuntimeTelemetryProbe).toBe('function')
      return
    }

    const runtime = makeRuntime()
    const before = structuredClone(runtime)
    const output = JSON.stringify({
      taskId: 'T-05806',
      state: 'open',
      updatedAt: '2026-07-07T17:28:13Z',
    })

    const probe = createRuntimeTelemetryProbe({
      queryIdentity: {
        projectId: 'P-00328',
        taskId: 'T-05806',
        command: 'wrkq cat T-05806',
      },
      output,
      runtime,
    })

    expect(probe).toEqual({
      queryIdentity: {
        projectId: 'P-00328',
        taskId: 'T-05806',
        command: 'wrkq cat T-05806',
      },
      outputDigest: sha256Digest(output),
      runtimeLifecycle: {
        runtimeId: 'rt-t05806',
        hostSessionId: 'hsid-t05806',
        scopeRef: 'agent:smokey:project:hrc-runtime:task:T-05806',
        laneRef: 'lane:t05806',
        generation: 7,
        status: 'ready',
        transport: 'headless',
        controllerKind: 'harness-broker',
        createdAt: '2026-07-07T17:00:00.000Z',
        updatedAt: '2026-07-07T17:05:00.000Z',
        brokerEndpoint: 'unix-jsonrpc-ndjson',
        brokerSubstrate: 'leased-tmux',
        brokerPresentation: 'none',
      },
    })
    expect(runtime).toEqual(before)
  })
})
