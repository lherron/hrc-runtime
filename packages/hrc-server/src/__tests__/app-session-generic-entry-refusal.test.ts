/**
 * T-08576 R-G1a..R-G13c: generic session-addressed routes must not act on app identity.
 *
 * Each case runs through the real Unix HTTP router over a real SQLite store. Row counts are
 * sampled only for the acceptance effect tables; request metrics are intentionally excluded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

const NOW = '2026-09-17T07:00:00.000Z'
const APP_HOST = `hsid-${randomUUID()}`
const APP_RUNTIME = `rt-${randomUUID()}`

let root: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let dbPath: string
let server: HrcServer

const intent = {
  placement: {
    agentRoot: '/tmp/t08576-agent',
    projectRoot: '/tmp/t08576-project',
    cwd: '/tmp/t08576-project',
    runMode: 'task' as const,
    bundle: { kind: 'compose' as const, compose: [] },
    dryRun: true,
  },
  harness: { provider: 'anthropic' as const, id: 'claude-code', interactive: true },
}

beforeEach(async () => {
  Reflect.deleteProperty(process.env, 'HRC_ALLOW_HARNESS_SHIM')
  root = await mkdtemp(join(tmpdir(), 't08576-generic-'))
  runtimeRoot = join(root, 'run')
  stateRoot = join(root, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  dbPath = join(stateRoot, 'state.sqlite')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath: join(runtimeRoot, 'server.lock'),
    spoolDir: join(runtimeRoot, 'spool'),
    dbPath,
    tmuxSocketPath: join(runtimeRoot, 'tmux.sock'),
    commandRunTargets: {
      t08576: { launchMode: 'exec', argv: ['/bin/true'] },
    },
  })
  const db = openHrcDatabase(dbPath)
  try {
    db.sessions.insert({
      hostSessionId: APP_HOST,
      scopeRef: 'app:t08576',
      laneRef: 'assistant',
      generation: 1,
      status: 'active',
      continuation: { provider: 'anthropic', key: 'cont-t08576' },
      lastAppliedIntentJson: intent,
      createdAt: NOW,
      updatedAt: NOW,
      ancestorScopeRefs: [],
    })
    db.sqlite.run(
      'INSERT INTO continuities (scope_ref, lane_ref, active_host_session_id, updated_at) VALUES (?, ?, ?, ?)',
      ['app:t08576', 'assistant', APP_HOST, NOW]
    )
    db.appManagedSessions.create({
      appId: 't08576',
      appSessionKey: 'assistant',
      kind: 'harness',
      activeHostSessionId: APP_HOST,
      generation: 1,
      status: 'active',
      lastAppliedSpec: { kind: 'harness', runtimeIntent: intent },
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.runtimes.insert({
      runtimeId: APP_RUNTIME,
      hostSessionId: APP_HOST,
      scopeRef: 'app:t08576',
      laneRef: 'assistant',
      generation: 1,
      transport: 'headless',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: true,
      adopted: false,
      createdAt: NOW,
      updatedAt: NOW,
    })
    db.localBridges.create({
      bridgeId: 'bridge-t08576-app',
      hostSessionId: APP_HOST,
      runtimeId: APP_RUNTIME,
      transport: 'tmux',
      target: '%t08576',
      createdAt: NOW,
    })
  } finally {
    db.close()
  }
})

afterEach(async () => {
  await server.stop()
  await rm(root, { recursive: true, force: true })
})

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost${path}`, {
    unix: socketPath,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  return { status: response.status, body: parsed }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://localhost${path}`, { unix: socketPath })
  return { status: response.status, body: await response.json() }
}

const EFFECT_TABLES = [
  'sessions',
  'continuities',
  'session_index',
  'app_managed_sessions',
  'runtimes',
  'runs',
  'runtime_operations',
  'broker_invocations',
  'local_bridges',
  'surface_bindings',
  'active_input_deliveries',
  'hrc_events',
] as const

function effectState(): Record<string, unknown> {
  const db = openHrcDatabase(dbPath)
  try {
    const existing = new Set(
      db.sqlite
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    )
    return {
      counts: Object.fromEntries(
        EFFECT_TABLES.filter((table) => existing.has(table)).map((table) => [
          table,
          db.sqlite.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count ?? 0,
        ])
      ),
      session: db.sqlite
        .query<
          {
            status: string
            last_applied_intent_json: string | null
            continuation_reuse_disabled: number
          },
          [string]
        >(
          'SELECT status, last_applied_intent_json, continuation_reuse_disabled FROM sessions WHERE host_session_id = ?'
        )
        .get(APP_HOST),
    }
  } finally {
    db.close()
  }
}

type RefusalCase = { gate: string; path: string; body: () => unknown }

function commandBinding(sessionRef: string, lane: string): Record<string, string> {
  return {
    WRKF_TASK_ID: 'T-08576',
    WRKF_ACTION_RUN_ID: `action-${lane}`,
    WRKF_RUN_ID: `workflow-${lane}`,
    WRKF_ACTION: 'validate',
    WRKF_ROLE: 'smokey',
    ASP_PROJECT: 'hrc-runtime',
    HRC_SESSION_REF: sessionRef,
    HRC_LANE: lane,
  }
}

const refusalCases: RefusalCase[] = [
  {
    gate: 'R-G1a enqueue',
    path: '/v1/submissions/enqueue',
    body: () => ({
      target: APP_HOST,
      body: 'x',
      origin: { principalRef: 'agent:smokey' },
      wait: false,
    }),
  },
  {
    gate: 'R-G1b invoke',
    path: '/v1/submissions/invoke',
    body: () => ({
      target: APP_HOST,
      body: 'x',
      origin: { principalRef: 'agent:smokey' },
      wait: false,
    }),
  },
  {
    gate: 'R-G1c preempt',
    path: '/v1/submissions/preempt',
    body: () => ({
      target: APP_HOST,
      body: 'x',
      origin: { principalRef: 'agent:smokey' },
      wait: false,
    }),
  },
  {
    gate: 'R-G1e invoke freshContext',
    path: '/v1/submissions/invoke',
    body: () => ({
      target: APP_HOST,
      body: 'x',
      origin: { principalRef: 'agent:smokey' },
      freshContext: true,
      wait: false,
    }),
  },
  {
    gate: 'R-G1f participant-shaped submission',
    path: '/v1/submissions/enqueue',
    body: () => ({
      target: APP_HOST,
      body: 'x',
      origin: { principalRef: 'participant:test' },
      wait: false,
    }),
  },
  {
    gate: 'R-G2 turns',
    path: '/v1/turns',
    body: () => ({ hostSessionId: APP_HOST, prompt: 'x', idempotencyKey: 't08576-g2' }),
  },
  {
    gate: 'R-G3 runtimes ensure',
    path: '/v1/runtimes/ensure',
    body: () => ({ hostSessionId: APP_HOST, intent }),
  },
  {
    gate: 'R-G4 runtimes start',
    path: '/v1/runtimes/start',
    body: () => ({ hostSessionId: APP_HOST, intent }),
  },
  {
    gate: 'R-G5 broker open',
    path: '/v1/broker-sessions/open',
    body: () => ({ hostSessionId: APP_HOST, runtimeIntent: intent }),
  },
  {
    gate: 'R-G6 prepare attached',
    path: '/v1/runs/prepare-attached',
    body: () => ({ hostSessionId: APP_HOST, intent }),
  },
  {
    gate: 'R-G7a command launch must not mint app identity',
    path: '/v1/command-runs/launch',
    body: () => ({
      configuredTargetId: 't08576',
      idempotencyKey: 't08576-g7a',
      sessionRef: 'app:t08576/lane:newkey',
      binding: commandBinding('app:t08576/lane:newkey', 'newkey'),
      input: {},
    }),
  },
  {
    gate: 'R-G7b command launch existing app continuity',
    path: '/v1/command-runs/launch',
    body: () => ({
      configuredTargetId: 't08576',
      idempotencyKey: 't08576-g7b',
      sessionRef: 'app:t08576/lane:assistant',
      binding: commandBinding('app:t08576/lane:assistant', 'assistant'),
      input: {},
    }),
  },
  {
    gate: 'R-G8 resolve create',
    path: '/v1/sessions/resolve',
    body: () => ({ sessionRef: 'app:t08576/lane:newkey', create: true }),
  },
  {
    gate: 'R-G10 in-flight input',
    path: '/v1/in-flight-input',
    body: () => ({ runtimeId: APP_RUNTIME, runId: 'run-t08576', prompt: 'x' }),
  },
  {
    gate: 'R-G11 active run contribution',
    path: '/v1/active-run-contributions',
    body: () => ({
      selector: { runtimeId: APP_RUNTIME },
      inputAttemptId: 'ia-t08576',
      inputApplicationId: 'iap-t08576',
      prompt: 'x',
    }),
  },
  {
    gate: 'R-G12a bridge target app selector',
    path: '/v1/bridges/target',
    body: () => ({
      selector: { appSession: { appId: 't08576', appSessionKey: 'assistant' } },
      bridge: 'tmux',
    }),
  },
  {
    gate: 'R-G12b bridge target host',
    path: '/v1/bridges/target',
    body: () => ({
      hostSessionId: APP_HOST,
      transport: 'tmux',
      target: '%t08576',
      runtimeId: APP_RUNTIME,
    }),
  },
  {
    gate: 'R-G12c bridge deliver text',
    path: '/v1/bridges/deliver-text',
    body: () => ({ bridgeId: 'bridge-t08576-app', text: 'must-not-send', enter: false }),
  },
  {
    gate: 'R-G13a drop continuation',
    path: '/v1/sessions/drop-continuation',
    body: () => ({ hostSessionId: APP_HOST }),
  },
  {
    gate: 'R-G13b create successor',
    path: '/v1/sessions/create-successor',
    body: () => ({ sessionRef: 'app:t08576/lane:assistant', priorHostSessionId: APP_HOST }),
  },
  {
    gate: 'R-G13c adopt',
    path: '/v1/runtimes/adopt',
    body: () => ({ runtimeId: APP_RUNTIME }),
  },
]

describe('T-08576 generic entry refusal matrix', () => {
  for (const testCase of refusalCases) {
    it(`${testCase.gate} refuses before every durable effect`, async () => {
      const before = effectState()
      const response = await post(testCase.path, testCase.body())
      const after = effectState()

      expect({ response, effectsUnchanged: after }).toEqual({
        response: {
          status: 422,
          body: {
            error: expect.objectContaining({
              code: 'session_kind_mismatch',
              detail: expect.objectContaining({ reason: 'app-session-route-required' }),
            }),
          },
        },
        effectsUnchanged: before,
      })
    })
  }

  it('R-G1d(i) steer keeps the existing strict-parser refusal and zero effects', async () => {
    const before = effectState()
    const response = await post('/v1/submissions/steer', {
      target: 'app:t08576/lane:assistant',
      body: 'x',
      origin: { principalRef: 'agent:smokey' },
      wait: false,
    })
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('invalid_selector')
    expect(effectState()).toEqual(before)
  })

  it('R-G7 control executes a configured target for an agent session', async () => {
    const sessionRef = 'agent:smokey/project:hrc-runtime/task:T-08576/lane:g7-control'
    const response = await post('/v1/command-runs/launch', {
      configuredTargetId: 't08576',
      idempotencyKey: 't08576-g7-control',
      sessionRef,
      binding: commandBinding(sessionRef, 'g7-control'),
      input: {},
    })
    const db = openHrcDatabase(dbPath)
    try {
      const run = db.sqlite
        .query<
          {
            host_session_id: string
            runtime_id: string | null
            scope_ref: string
            lane_ref: string
            generation: number
          },
          [string]
        >(
          `SELECT host_session_id, runtime_id, scope_ref, lane_ref, generation
             FROM runs WHERE run_id = ?`
        )
        .get(response.body.runId)
      const startedEvents = db.sqlite
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM hrc_events
             WHERE run_id = ? AND event_kind = 'command_run.started'`
        )
        .get(response.body.runId)?.count

      expect({ response, run, startedEvents }).toEqual({
        response: {
          status: 200,
          body: {
            runId: expect.any(String),
            hostSessionId: expect.any(String),
            runtimeId: expect.any(String),
            generation: 1,
            transport: 'tmux',
            replayed: false,
          },
        },
        run: {
          host_session_id: response.body.hostSessionId,
          runtime_id: response.body.runtimeId,
          scope_ref: 'agent:smokey:project:hrc-runtime:task:T-08576',
          lane_ref: 'g7-control',
          generation: 1,
        },
        startedEvents: 1,
      })
    } finally {
      db.close()
    }
  })

  it('R-G8 read-only resolve remains allowed', async () => {
    const response = await post('/v1/sessions/resolve', {
      sessionRef: 'app:t08576/lane:assistant',
      create: false,
    })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ found: true, hostSessionId: APP_HOST, created: false })
  })

  it('R-G9(i) live dispatchable app runtime attach matches the GET attach surface', async () => {
    const runtimeId = `rt-${randomUUID()}`
    const db = openHrcDatabase(dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId: APP_HOST,
        scopeRef: 'app:t08576',
        laneRef: 'assistant',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        controllerKind: 'harness-broker',
        supportsInflightInput: true,
        adopted: false,
        runtimeStateJson: {
          broker: {
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: '/tmp/t08576-viewer.sock',
              attachTokenRef: { kind: 'file', path: '/tmp/t08576-viewer.token' },
            },
            substrate: {
              kind: 'leased-tmux',
              tmuxSocketPath: '/tmp/t08576-viewer-tmux.sock',
              sessionName: 't08576-viewer',
              brokerWindow: { sessionId: '$1', windowId: '@1', paneId: '%1' },
              generation: 1,
            },
            presentation: {
              kind: 'tmux-tui',
              tuiWindow: { sessionId: '$1', windowId: '@2', paneId: '%2' },
              operatorAttachTarget: true,
            },
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      })
    } finally {
      db.close()
    }
    ;(server as any).reconcileTmuxRuntimeLiveness = async (runtime: unknown) => runtime
    const before = effectState()
    const readAttach = await get(`/v1/attach?runtimeId=${encodeURIComponent(runtimeId)}`)
    const liveAttach = await post('/v1/runtimes/attach', { runtimeId })

    expect(liveAttach).toEqual(readAttach)
    expect(liveAttach).toMatchObject({
      status: 200,
      body: {
        transport: 'tmux',
        bindingFence: { hostSessionId: APP_HOST, runtimeId, generation: 1 },
      },
    })
    expect(effectState()).toEqual(before)
  })

  it('R-G9 stale/non-dispatchable attach refuses without reprovision effects', async () => {
    let staleMarks = 0
    let starts = 0
    ;(server as any).markRuntimeStaleForBrokerReprovision = () => {
      staleMarks += 1
    }
    ;(server as any).startRuntimeForSession = async () => {
      starts += 1
      throw new Error('T-08576 unexpected app attach reprovision')
    }
    const before = effectState()
    const response = await post('/v1/runtimes/attach', { runtimeId: APP_RUNTIME })
    expect(response.status).toBe(503)
    expect(response.body.error?.code).toBe('runtime_unavailable')
    expect(response.body.error?.message).toContain(
      'runtime cannot be attached without replacing it'
    )
    expect({ staleMarks, starts }).toEqual({ staleMarks: 0, starts: 0 })
    expect(effectState()).toEqual(before)
  })

  it('X-route strict parser control stays invalid_selector with zero effects', async () => {
    const before = effectState()
    const response = await post('/v1/turns/by-selector', {
      selector: { sessionRef: 'app:t08576/lane:assistant' },
      prompt: 'x',
    })
    expect(response.status).toBe(400)
    expect(response.body.error?.code).toBe('invalid_selector')
    expect(effectState()).toEqual(before)
  })
})
