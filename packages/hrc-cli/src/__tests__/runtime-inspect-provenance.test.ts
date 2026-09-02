import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { BrokerInspectResponse, InspectRuntimeResponse } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'
import type { CaptureStateView, EvidenceAuthorityMatrix } from 'spaces-harness-broker-protocol'

import { cmdRuntimeInspect, cmdRuntimeStatus } from '../cli/handlers-runtime.js'

const RUNTIME_ID = 'rt-11111111-1111-4111-8111-111111111111'

const hrcView = {
  runtimeId: RUNTIME_ID,
  hostSessionId: 'hsid-provenance',
  scopeRef: 'agent:cody:project:hrc-runtime:task:T-07011',
  laneRef: 'main',
  generation: 1,
  transport: 'tmux',
  harness: 'codex',
  provider: 'openai',
  status: 'ready',
  createdAt: '2026-07-27T00:00:00.000Z',
  createdAgeSec: 10,
  lastActivityAt: null,
  lastActivityAgeSec: null,
  activeRunId: null,
  wrapperPid: null,
  childPid: null,
  continuation: null,
  continuationKey: null,
  continuationStale: false,
} as InspectRuntimeResponse

function captureStdout(): { read(): string; restore(): void } {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stdout.write = original
    },
  }
}

afterEach(() => {
  mock.restore()
})

beforeEach(() => {
  spyOn(HrcClient.prototype, 'listRuntimes').mockResolvedValue([
    {
      runtimeId: RUNTIME_ID,
      scopeRef: hrcView.scopeRef,
      laneRef: 'main',
      status: 'ready',
      createdAt: hrcView.createdAt,
    },
  ] as Awaited<ReturnType<HrcClient['listRuntimes']>>)
  spyOn(HrcClient.prototype, 'listSessions').mockResolvedValue([])
})

describe('runtime inspect authority provenance', () => {
  test('renders capture state and broker-declared evidence authority', async () => {
    const capture: CaptureStateView = {
      state: 'blocked',
      blockedOn: {
        rawRecordId: 'raw-cli',
        nativeType: 'queue.future_op',
        family: 'input-admission',
        message: 'unknown input admission record',
        sinceIso: '2026-09-01T12:34:56.000Z',
      },
      deferredCount: 3,
    }
    const evidenceAuthority: EvidenceAuthorityMatrix = {
      'invocation-lifecycle': 'broker',
      'harness-lifecycle': 'hook',
      continuation: 'native',
      'input-admission': 'broker',
      'submission-disposition': 'native',
      'turn-bracket': 'native',
      'turn-supervision': 'broker',
      conversation: 'native',
      tool: 'native',
      usage: 'native',
      permission: 'broker',
      diagnostic: 'hook',
      'terminal-surface': 'hook',
      'provider-artifact': 'native',
    }
    const view = { ...hrcView, capture, evidenceAuthority } as InspectRuntimeResponse & {
      capture: CaptureStateView
      evidenceAuthority: EvidenceAuthorityMatrix
    }
    spyOn(HrcClient.prototype, 'inspectRuntime').mockResolvedValue(view)
    spyOn(HrcClient.prototype, 'brokerInspect').mockResolvedValue({
      runtimeId: RUNTIME_ID,
      source: 'hrc-derived',
      transport: 'tmux',
      harness: 'codex',
      status: 'ready',
      lastActivityAt: null,
    })

    const inspectOutput = captureStdout()
    try {
      await cmdRuntimeInspect([RUNTIME_ID])
      expect(inspectOutput.read()).toContain(
        'capture       blocked since 2026-09-01T12:34:56.000Z on raw-cli (input-admission/queue.future_op): unknown input admission record (deferredCount=3)'
      )
      expect(inspectOutput.read()).toContain('input-admission=broker')
      expect(inspectOutput.read()).toContain('conversation=native')
    } finally {
      inspectOutput.restore()
    }

    const statusOutput = captureStdout()
    try {
      await cmdRuntimeStatus([RUNTIME_ID])
      expect(statusOutput.read()).toContain('capture: blocked since 2026-09-01T12:34:56.000Z')
    } finally {
      statusOutput.restore()
    }
  })

  test('keeps HRC and broker JSON as distinct nested authority objects', async () => {
    const brokerView: BrokerInspectResponse = {
      runtimeId: RUNTIME_ID,
      source: 'broker',
      transport: 'tmux',
      harness: 'codex',
      status: 'ready',
      lastActivityAt: null,
      invocations: [{ invocationId: 'inv-1', state: 'idle' }],
    }
    spyOn(HrcClient.prototype, 'inspectRuntime').mockResolvedValue(hrcView)
    spyOn(HrcClient.prototype, 'brokerInspect').mockResolvedValue(brokerView)
    const output = captureStdout()
    try {
      await cmdRuntimeInspect([RUNTIME_ID, '--json'])
      expect(JSON.parse(output.read())).toEqual({ hrc: hrcView, broker: brokerView })
    } finally {
      output.restore()
    }
  })

  test('labels HRC-derived broker fallback without flattening it into HRC runtime facts', async () => {
    const brokerView: BrokerInspectResponse = {
      runtimeId: RUNTIME_ID,
      source: 'hrc-derived',
      transport: 'tmux',
      harness: 'codex',
      status: 'ready',
      lastActivityAt: null,
      lifecycle: { retention: { mode: 'hrc-idle-cleanup', idleTtlMs: 60_000 } },
      note: 'synthesized from HRC runtime facts',
    }
    spyOn(HrcClient.prototype, 'inspectRuntime').mockResolvedValue(hrcView)
    spyOn(HrcClient.prototype, 'brokerInspect').mockResolvedValue(brokerView)
    const output = captureStdout()
    try {
      await cmdRuntimeInspect([RUNTIME_ID])
      expect(output.read()).toContain('HRC authority (source: HRC runtime store)')
      expect(output.read()).toContain('Broker authority (source: hrc-derived)')
      expect(output.read()).toContain('note          synthesized from HRC runtime facts')
    } finally {
      output.restore()
    }
  })
})
