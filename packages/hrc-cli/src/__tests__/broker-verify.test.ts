import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { readProviderJsonl } from '../broker-verify/adapters.js'
import { verifyInvocation } from '../broker-verify/comparator.js'
import { hashPayload } from '../broker-verify/json.js'
import { BrokerVerifyStore } from '../broker-verify/store.js'
import type { ProviderTranscript } from '../broker-verify/types.js'

const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-04861'
const HOST_SESSION_ID = 'hsid_verify'
const RUNTIME_ID = 'rt_verify'
const OPERATION_ID = 'op_verify'
const INVOCATION_ID = 'inv_verify'
const RUN_ID = 'run_verify'

type Fixture = Awaited<ReturnType<typeof makeFixture>>

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

describe('broker verify provider adapters', () => {
  it('normalizes minimized Codex JSONL with line numbers and tool correlation ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-verify-jsonl-'))
    const path = join(dir, 'codex.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: '{"cmd":"date"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'Tue' },
        }),
      ].join('\n')
    )

    try {
      const transcript = await readProviderJsonl(path)
      expect(transcript.provider).toBe('codex')
      expect(transcript.observed.map((event) => [event.line, event.type, event.correlationKey])).toEqual([
        [1, 'assistant.message.completed', undefined],
        [2, 'tool.call.started', 'call-1'],
        [3, 'tool.call.completed', 'call-1'],
      ])
      expect(transcript.observed[1]?.normalizedPayload).toEqual({
        toolCallId: 'call-1',
        name: 'command',
        input: { cmd: 'date' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes minimized Claude JSONL user, assistant, tool_use, and tool_result records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-verify-claude-'))
    const path = join(dir, 'claude.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'pwd' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }],
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await readProviderJsonl(path)
      expect(transcript.provider).toBe('claude')
      expect(transcript.observed.map((event) => [event.line, event.type, event.correlationKey])).toEqual([
        [1, 'user.message', undefined],
        [2, 'tool.call.started', 'toolu-1'],
        [3, 'tool.call.completed', 'toolu-1'],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('broker verify store and comparator', () => {
  it('lists candidates by exact scope using invocation_id as stable id', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' })
    fixture.db.brokerInvocations.insert({
      invocationId: 'inv_verify_second',
      operationId: 'op_verify_second',
      runtimeId: RUNTIME_ID,
      runId: RUN_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'completed',
      capabilitiesJson: '{}',
      specHash: 'sha256:spec2',
      startRequestHash: 'sha256:req2',
      selectedProfileHash: 'sha256:profile2',
      createdAt: ts(10),
      updatedAt: ts(10),
    })

    const store = new BrokerVerifyStore(fixture.dbPath)
    try {
      const candidates = store.listCandidates(SCOPE_REF)
      expect(candidates.map((candidate) => candidate.invocationId)).toContain(INVOCATION_ID)
      expect(candidates.map((candidate) => candidate.invocationId)).toContain('inv_verify_second')
      expect(candidates.every((candidate) => candidate.confidence === 'exact-scope')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('passes clean ledger, raw mirror, lifecycle, and provider matching checks', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' })
    seedLifecycle(fixture, 'turn.user_prompt', { type: 'message_end' })

    const report = verifyFixture(fixture, {
      observed: [
        {
          line: 1,
          provider: 'codex',
          type: 'user.message',
          normalizedPayload: { content: 'hello' },
          payloadHash: hashForTest({ content: 'hello' }),
        },
      ],
    })

    expect(report.ok).toBe(true)
    expect(report.rawMirror).toEqual({ checked: 1, matched: 1 })
    expect(report.providerMatches[0]?.status).toBe('matched')
    expect(report.lifecycle[0]?.status).toBe('present')
  })

  it('fails on seq holes and non-applied broker projection status', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' })
    seedBrokerEvent(fixture, 3, 'turn.completed', {}, { projectionStatus: 'pending' })

    const report = verifyFixture(fixture)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain('seq_hole')
    expect(report.issues.map((issue) => issue.code)).toContain('projection_not_applied')
  })

  it('fails on missing raw mirror rows and raw mirror payload mismatches', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'user.message', { content: 'hello' }, { mirrorPayload: { content: 'other' } })
    seedBrokerEvent(fixture, 2, 'turn.completed', {}, { skipMirror: true })

    const report = verifyFixture(fixture)
    expect(report.ok).toBe(false)
    expect(report.issues.map((issue) => issue.code)).toContain('raw_mirror_mismatch')
    expect(report.issues.map((issue) => issue.code)).toContain('raw_mirror_seq_missing')
  })

  it('reports missing provider transcript events and strict assistant text mismatches', async () => {
    const fixture = await makeFixture()
    seedBrokerEvent(fixture, 1, 'assistant.message.completed', {
      content: [{ type: 'text', text: 'broker text' }],
    })

    const defaultReport = verifyFixture(fixture, {
      observed: [
        {
          line: 1,
          provider: 'codex',
          type: 'assistant.message.completed',
          normalizedPayload: { content: 'provider text' },
          payloadHash: hashForTest({ content: 'provider text' }),
          text: 'provider text',
        },
      ],
    })
    expect(defaultReport.ok).toBe(true)
    expect(defaultReport.providerMatches[0]?.status).toBe('text-mismatch-tolerated')

    const strictReport = verifyFixture(
      fixture,
      {
        observed: [
          {
            line: 1,
            provider: 'codex',
            type: 'assistant.message.completed',
            normalizedPayload: { content: 'provider text' },
            payloadHash: hashForTest({ content: 'provider text' }),
            text: 'provider text',
          },
          {
            line: 2,
            provider: 'codex',
            type: 'tool.call.started',
            correlationKey: 'missing',
            normalizedPayload: { toolCallId: 'missing', name: 'Bash', input: {} },
            payloadHash: hashForTest({ toolCallId: 'missing', name: 'Bash', input: {} }),
          },
        ],
      },
      { strictText: true }
    )
    expect(strictReport.ok).toBe(false)
    expect(strictReport.issues.map((issue) => issue.code)).toContain(
      'provider_event_payload_divergent'
    )
    expect(strictReport.issues.map((issue) => issue.code)).toContain(
      'provider_event_missing_in_broker'
    )
  })
})

async function makeFixture(): Promise<{
  dir: string
  dbPath: string
  db: ReturnType<typeof openHrcDatabase>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-broker-verify-'))
  const dbPath = join(dir, 'state.sqlite')
  const db = openHrcDatabase(dbPath)
  fixtures.push({ dir, dbPath, db })
  const now = ts()

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'started',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'turn_active',
    capabilitiesJson: '{}',
    specHash: 'sha256:spec',
    startRequestHash: 'sha256:req',
    selectedProfileHash: 'sha256:profile',
    currentHarnessGeneration: 1,
    currentTurnAttempt: 1,
    createdAt: now,
    updatedAt: now,
  })
  return { dir, dbPath, db }
}

function seedBrokerEvent(
  fixture: Fixture,
  seq: number,
  type: string,
  payload: unknown,
  options: {
    projectionStatus?: 'pending' | 'applied' | 'failed'
    mirrorPayload?: unknown
    skipMirror?: boolean
  } = {}
): void {
  let hrcEventSeq: number | undefined
  if (!options.skipMirror) {
    const mirror = fixture.db.events.append({
      ts: ts(seq),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      runId: RUN_ID,
      runtimeId: RUNTIME_ID,
      source: 'broker',
      eventKind: `broker.${type}`,
      eventJson: {
        invocationId: INVOCATION_ID,
        seq,
        type,
        time: ts(seq),
        payload: options.mirrorPayload ?? payload,
      },
    })
    hrcEventSeq = mirror.seq
  }
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    harnessGeneration: 1,
    turnAttempt: 1,
    payload,
    ...(hrcEventSeq !== undefined ? { hrcEventSeq } : {}),
    projectionStatus: options.projectionStatus ?? 'applied',
  })
}

function seedLifecycle(fixture: Fixture, eventKind: string, payload: unknown): void {
  fixture.db.hrcEvents.append({
    ts: ts(20),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    category: 'turn',
    eventKind,
    transport: 'headless',
    payload,
  })
}

function verifyFixture(
  fixture: Fixture,
  transcript?: Pick<ProviderTranscript, 'observed'> & Partial<Omit<ProviderTranscript, 'observed'>>,
  options: { strictText?: boolean } = {}
): ReturnType<typeof verifyInvocation> {
  const store = new BrokerVerifyStore(fixture.dbPath)
  try {
    const invocation = store.getInvocation(INVOCATION_ID)
    if (invocation === undefined) throw new Error('missing invocation')
    return verifyInvocation({
      store,
      invocation,
      events: store.listBrokerEvents(INVOCATION_ID),
      ...(transcript !== undefined
        ? {
            transcript: {
              path: 'fixture.jsonl',
              provider: 'codex',
              warnings: [],
              lineCount: 1,
              ...transcript,
            },
          }
        : {}),
      strictText: options.strictText ?? false,
    })
  } finally {
    store.close()
  }
}

function ts(offsetSeconds = 0): string {
  return new Date(Date.UTC(2026, 5, 16, 12, 0, offsetSeconds)).toISOString()
}

function hashForTest(value: unknown): string {
  return hashPayload(value)
}
