/**
 * T-08555 — the aspd-prepared app-server viewer as the node-default Codex route
 * (docs/aspd-headless-codex-integration.md §1.3,
 * hrc-runtime.aspd-prepared-execution-release). Shares the T-08542 doubles.
 *
 * Real pieces: the real HRC handlers (start and dispatch doors), the real
 * `HarnessBrokerController` and substrate allocators, and a Unix-socket aspd
 * double speaking the ASPC wire. The interactive tmux executors are OBSERVED,
 * never run: they record which admission outcome reached them and refuse, so no
 * real tmux or broker is touched and a cross-transport start is visible as an
 * aspd compile or a headless runtime row.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { AspcFacadeBrokerClient } from '../agent-spaces-adapter/aspc-facade-client'
import { decideInteractiveBrokerAdmission } from '../broker-decisions'
import {
  createBrokerDurableHeadlessAllocator,
  createBrokerTmuxTuiAllocator,
} from '../broker-interactive-handlers/substrate-allocator'
import { HarnessBrokerController } from '../broker/controller'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import {
  createStartBirthDecision,
  decideCrossingBirthRoute,
  decideRedirectOffCodexRoute,
  findEstablishedBrokerRuntime,
  recordStartBirth,
  startBirthOf,
} from '../presentation-operator'
import {
  type AspdDouble,
  type HostingLedger,
  type Release,
  makeRelease,
  startAspdDouble,
  tmuxManagerDouble,
  workerClient,
} from './fixtures/aspd-route-doubles'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'

const SCOPE = 'agent:t08555:project:hrc-runtime:task:T-08555'

let fixture: HrcServerTestFixture
let server: HrcServer
let scratch: string
let aspd: AspdDouble
let releaseA: Release
let ledger: HostingLedger
let facadeSpy: ReturnType<typeof spyOn>
let observed: Observed
let callerAspHome: string
const savedEnv: Record<string, string | undefined> = {}

type Observed = { reuse: string[]; interactiveStart: HrcRuntimeIntent[] }

type Internal = {
  db: HrcDatabase
  options: { runtimeRoot: string }
  harnessBrokerController?: HarnessBrokerController
  runtimeStartOperations: Map<string, Promise<HrcRuntimeSnapshot>>
}

function internal(): Internal {
  return server as unknown as Internal
}

function headlessIntent(): HrcRuntimeIntent {
  return {
    placement: {
      agentRoot: fixture.tmpDir,
      projectRoot: fixture.tmpDir,
      cwd: fixture.tmpDir,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex-cli', interactive: false },
    execution: { preferredMode: 'headless' },
  } as HrcRuntimeIntent
}

function interactiveIntent(): HrcRuntimeIntent {
  const base = headlessIntent()
  return {
    ...base,
    harness: { ...base.harness, interactive: true },
    execution: { preferredMode: 'interactive' },
  }
}

async function session(scope = SCOPE): Promise<HrcSessionRecord> {
  const resolved = await fixture.resolveSession(scope)
  const record = internal().db.sessions.getByHostSessionId(resolved.hostSessionId)
  if (record === null) throw new Error('session missing')
  return record
}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * Boot the server under test. `redirect` is the node's Codex interactive
 * redirect control; max3 after T-08555 is `false` with a `tmux-tui` default.
 */
async function bootServer(redirect: boolean): Promise<void> {
  server = await createHrcServer(
    fixture.serverOpts({
      headlessCodexBrokerEnabled: true,
      codexCliTmuxBrokerEnabled: redirect,
      otelListenerEnabled: false,
    })
  )
  const tmuxManagerFactory = tmuxManagerDouble(ledger)
  internal().harnessBrokerController = new HarnessBrokerController({
    db: internal().db,
    brokerUnixClientFactory: async () =>
      workerClient(ledger, [releaseA], ledger.commands.at(-1)) as never,
    headlessSubstrateAllocator: createBrokerDurableHeadlessAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08555',
    }),
    tmuxTuiAllocator: createBrokerTmuxTuiAllocator(internal().options, {
      tmuxManagerFactory: tmuxManagerFactory as never,
      generateAttachToken: () => 'attach-token-t08555-tui',
    }),
    now: () => new Date().toISOString(),
  } as unknown as ConstructorParameters<typeof HarnessBrokerController>[0])

  observed = { reuse: [], interactiveStart: [] }
  const refuse = async (route: string) => {
    const { HrcRuntimeUnavailableError } = await import('hrc-core')
    throw new HrcRuntimeUnavailableError('interactive route observed', { route })
  }
  const target = server as unknown as Record<string, unknown>
  target['executeInteractiveBrokerInputTurn'] = async (
    _s: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot
  ) => {
    observed.reuse.push(runtime.runtimeId)
    return await refuse('observed-interactive-reuse')
  }
  target['handleInteractiveTmuxBrokerDispatchTurn'] = async (
    _s: HrcSessionRecord,
    intent: HrcRuntimeIntent
  ) => {
    observed.interactiveStart.push(intent)
    return await refuse('observed-interactive-start')
  }
  target['startInteractiveTmuxBrokerRuntime'] = async (
    _s: HrcSessionRecord,
    intent: HrcRuntimeIntent
  ) => {
    observed.interactiveStart.push(intent)
    return await refuse('observed-interactive-start')
  }
}

async function reboot(redirect: boolean): Promise<void> {
  await server.stop()
  await bootServer(redirect)
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08555-')
  scratch = await mkdtemp(join(tmpdir(), 't8555-'))
  releaseA = makeRelease(join(scratch, 'releases'), 'a')
  const aspdSocket = join(scratch, 'aspd.sock')
  aspd = startAspdDouble(aspdSocket, releaseA)
  setEnv('HRC_ASPD_SOCKET', aspdSocket)
  setEnv('HRC_CODEX_APP_SERVER_OPERATOR_PRESENTATION', 'tmux-tui')
  setEnv('HRC_HARNESS_BROKER_CMD', '/nonexistent/resolver-selected-harness-broker')
  callerAspHome = join(scratch, 'caller-asp-home')
  setEnv('ASP_HOME', callerAspHome)
  ledger = { commands: [], killedServers: [], startCalls: [], attachCalls: 0 }
  await bootServer(false)
  facadeSpy = spyOn(AspcFacadeBrokerClient, 'start').mockImplementation(async () => {
    throw new Error('bundled facade must not be reached on a configured node')
  })
})

afterEach(async () => {
  facadeSpy.mockRestore()
  aspd.stop()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  await server.stop()
  await fixture.cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function turn(hostSessionId: string, runtimeIntent: unknown, extra = {}) {
  return await fixture.postJson('/v1/turns', {
    hostSessionId,
    prompt: 'x',
    runtimeIntent,
    waitFor: 'accepted',
    ...extra,
  })
}

async function start(hostSessionId: string, intent: HrcRuntimeIntent) {
  return await fixture.postJson('/v1/runtimes/start', { hostSessionId, intent })
}

function preparations(hostSessionId: string) {
  return internal()
    .db.sqlite.query<{ preparation_json: string | null }, [string]>(
      `SELECT preparation_json FROM runtime_operations
        WHERE host_session_id = ? ORDER BY created_at ASC`
    )
    .all(hostSessionId)
    .map((row) => JSON.parse(row.preparation_json ?? '{}'))
}

function runtimeRow(
  s: HrcSessionRecord,
  runtimeId: string,
  overrides: {
    transport: 'headless' | 'tmux'
    provider?: 'openai' | 'anthropic'
    harness?: string
    status?: string
    driver?: string
  }
) {
  const now = new Date(
    Date.now() + internal().db.runtimes.listByHostSessionId(s.hostSessionId).length
  )
  return {
    runtimeId,
    hostSessionId: s.hostSessionId,
    scopeRef: s.scopeRef,
    laneRef: s.laneRef,
    generation: s.generation,
    transport: overrides.transport,
    harness: overrides.harness ?? 'codex-cli',
    provider: overrides.provider ?? 'openai',
    status: overrides.status ?? 'ready',
    controllerKind: 'harness-broker',
    supportsInflightInput: true,
    adopted: false,
    activeInvocationId: `inv-${runtimeId}`,
    runtimeStateJson: {
      broker: {
        endpoint: {
          kind: 'unix-jsonrpc-ndjson',
          socketPath: '/tmp/t08555.sock',
          attachTokenRef: { kind: 'file', path: '/tmp/t08555.token' },
        },
        // An external substrate is not probed for tmux liveness, so the row
        // stays established for the routing decision under test.
        substrate: { kind: 'external' },
        presentation: { kind: 'none' },
      },
      ...(overrides.transport === 'tmux'
        ? { tmux: { brokerDriver: overrides.driver ?? 'codex-app-server' } }
        : {}),
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

/** Seed an established runtime plus its broker invocation in `invocationState`. */
function seed(
  s: HrcSessionRecord,
  runtimeId: string,
  overrides: Parameters<typeof runtimeRow>[2] & { invocationState?: string }
): HrcRuntimeSnapshot {
  const row = runtimeRow(s, runtimeId, overrides)
  internal().db.runtimes.insert(row as never)
  internal().db.brokerInvocations.insert({
    invocationId: row.activeInvocationId,
    operationId: `op-${runtimeId}`,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: overrides.driver ?? 'codex-app-server',
    invocationState: overrides.invocationState ?? 'ready',
    capabilitiesJson: JSON.stringify({ inputQueue: { mode: 'fifo' } }),
    specHash: 'sha256:t08555-spec',
    startRequestHash: 'sha256:t08555-request',
    selectedProfileHash: 'sha256:t08555-profile',
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  } as never)
  return internal().db.runtimes.getByRuntimeId(runtimeId) as HrcRuntimeSnapshot
}

// ── Decision 1: explicit interactive Codex stays admissible ───────────────────

describe('T-08555 decision 1 — the redirect control is not an admission gate', () => {
  it('interactive Codex admission ignores the Codex redirect control', () => {
    const decision = decideInteractiveBrokerAdmission(interactiveIntent(), null, {
      claudeCodeTmuxBrokerEnabled: false,
      piTuiTmuxBrokerEnabled: false,
    })
    expect(decision).toMatchObject({
      decision: 'broker-start',
      allowedBrokerDriver: 'codex-app-server',
    })
  })

  it('an explicit interactive start on a redirect-off node reaches the interactive broker', async () => {
    const s = await session()
    const response = await start(s.hostSessionId, interactiveIntent())
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { detail: { route?: string } } }
    expect(body.error.detail.route).toBe('observed-interactive-start')
    expect(observed.interactiveStart).toHaveLength(1)
    expect(aspd.compileCalls).toBe(0)
  })
})

// ── Rules 3–5: the established-runtime predicate ──────────────────────────────

describe('T-08555 established runtime predicate', () => {
  function snap(
    runtimeId: string,
    transport: 'headless' | 'tmux',
    extra: Partial<HrcRuntimeSnapshot> = {}
  ): HrcRuntimeSnapshot {
    return {
      runtimeId,
      hostSessionId: 'hsid-p',
      transport,
      provider: 'openai',
      harness: 'codex-cli',
      status: 'ready',
      controllerKind: 'harness-broker',
      ...extra,
    } as HrcRuntimeSnapshot
  }

  it('nothing established runs headless; dead, failed and non-broker rows never count', () => {
    const intent = headlessIntent()
    expect(decideRedirectOffCodexRoute(intent, [])).toBe('headless')
    expect(
      decideRedirectOffCodexRoute(intent, [
        snap('rt-dead', 'tmux', { status: 'terminated' }),
        snap('rt-failed', 'tmux', { status: 'failed' }),
        snap('rt-crashed', 'tmux', { status: 'crashed' }),
        snap('rt-exec', 'tmux', { controllerKind: 'legacy' as never }),
      ])
    ).toBe('headless')
  })

  it('an established tmux runtime of any harness selects interactive admission', () => {
    const intent = headlessIntent()
    expect(decideRedirectOffCodexRoute(intent, [snap('rt-codex', 'tmux')])).toBe('interactive')
    expect(
      decideRedirectOffCodexRoute(intent, [
        snap('rt-claude', 'tmux', { provider: 'anthropic', harness: 'claude-code' }),
      ])
    ).toBe('interactive')
    expect(decideRedirectOffCodexRoute(intent, [snap('rt-busy', 'tmux', { status: 'busy' })])).toBe(
      'interactive'
    )
  })

  it('an established headless runtime selects headless for the same harness and refuses any other', () => {
    const intent = headlessIntent()
    expect(decideRedirectOffCodexRoute(intent, [snap('rt-h', 'headless')])).toBe('headless')
    expect(() =>
      decideRedirectOffCodexRoute(intent, [
        snap('rt-agent-harness', 'headless', { harness: 'agent-harness' as never }),
      ])
    ).toThrow('another harness')
  })

  it('the most recent established runtime decides', () => {
    const rows = [snap('rt-old-tmux', 'tmux'), snap('rt-new-headless', 'headless')]
    expect(findEstablishedBrokerRuntime(rows)?.runtimeId).toBe('rt-new-headless')
    expect(decideRedirectOffCodexRoute(headlessIntent(), rows)).toBe('headless')
    expect(decideRedirectOffCodexRoute(headlessIntent(), [...rows].reverse())).toBe('interactive')
  })
})

// ── Default cold launch and redirect-on regression ────────────────────────────

describe('T-08555 default cold launch', () => {
  it('dispatch door: an omitted choice with nothing established prepares the aspd viewer, source node-default', async () => {
    const s = await session()
    const response = await turn(s.hostSessionId, headlessIntent())
    await Bun.sleep(80)
    expect(response.status).toBeLessThan(500)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(facadeSpy).not.toHaveBeenCalled()
    expect(aspd.compileCalls).toBe(1)
    const [record] = preparations(s.hostSessionId)
    expect(record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      operatorPresentation: 'tmux-tui',
      operatorPresentationSource: 'node-default',
    })
    expect(record.hosting.presentation).toBe('tmux-tui')
    expect(record.intent.presentation?.operator).toBeUndefined()
    // HRC's own ASP_HOME rides the compile, so the worker's codex home is the one
    // every other route resolves, never the aspd daemon's environment.
    expect(aspd.compileAspHomes).toEqual([callerAspHome])
    expect(record.dispatch.routeDecision.aspHome).toBe(callerAspHome)
    expect(ledger.commands.at(-1) ?? '').toContain(join(releaseA.releaseRoot, 'harness-broker'))
  })

  it('start door: an omitted-choice start prepares the aspd viewer, source node-default', async () => {
    const s = await session()
    await start(s.hostSessionId, headlessIntent())
    expect(observed.interactiveStart).toHaveLength(0)
    expect(aspd.compileCalls).toBe(1)
    const [record] = preparations(s.hostSessionId)
    expect(record.dispatch.routeDecision).toMatchObject({
      preparation: 'aspd',
      operatorPresentationSource: 'node-default',
    })
    expect(record.hosting.presentation).toBe('tmux-tui')
  })

  it('redirect-on node: the omitted choice keeps the Codex redirect at both doors', async () => {
    await reboot(true)
    const s = await session()
    await turn(s.hostSessionId, headlessIntent())
    await start(s.hostSessionId, headlessIntent())
    expect(observed.interactiveStart).toHaveLength(2)
    expect(observed.interactiveStart.every((intent) => intent.harness.interactive)).toBe(true)
    expect(aspd.compileCalls).toBe(0)
  })
})

// ── Rules 3–4 at both doors against established runtimes ─────────────────────

describe('T-08555 established runtimes on a redirect-off node', () => {
  it('omitted input to an established codex-tui runtime is delivered into it (dispatch door)', async () => {
    const s = await session()
    const tui = seed(s, 'rt-t08555-tui', { transport: 'tmux' })
    const before = internal().db.runtimes.getByRuntimeId(tui.runtimeId)
    await turn(s.hostSessionId, headlessIntent())
    expect(observed.reuse).toEqual([tui.runtimeId])
    expect(observed.interactiveStart).toHaveLength(0)
    expect(aspd.compileCalls).toBe(0)
    expect(internal().db.runtimes.getByRuntimeId(tui.runtimeId)?.status).toBe(before?.status)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(1)
  })

  it('responseFormat to an established codex-tui runtime rides interactive admission, not the headless route', async () => {
    const s = await session()
    const tui = seed(s, 'rt-t08555-tui-rf', { transport: 'tmux' })
    await turn(s.hostSessionId, headlessIntent(), {
      responseFormat: { kind: 'json_schema', schema: { type: 'object' } },
    })
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse).toEqual([tui.runtimeId])
    expect(
      internal()
        .db.runtimes.listByHostSessionId(s.hostSessionId)
        .map((r) => r.runtimeId)
    ).toEqual([tui.runtimeId])
  })

  it('a high-risk request against an established codex-tui runtime is refused before any effect', async () => {
    const s = await session()
    const tui = seed(s, 'rt-t08555-tui-hr', { transport: 'tmux' })
    const before = internal().db.runtimes.getByRuntimeId(tui.runtimeId)
    const intent = {
      ...headlessIntent(),
      execution: {
        preferredMode: 'headless',
        actuatorSplit: {
          schemaVersion: 'hrc.actuator-split-policy/v1',
          mode: 'high-risk',
          workflowRef: 'wrkf:t08555',
          laneClass: 'verifier',
          codeMutation: 'forbidden',
          productionCodePaths: ['packages'],
        },
      },
    }
    const response = await turn(s.hostSessionId, intent)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).toContain('high-risk-route-requires-headless-codex-broker')
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse).toHaveLength(0)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(internal().db.runtimes.getByRuntimeId(tui.runtimeId)).toEqual(before)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toHaveLength(1)
  })

  it('a transitional codex-tui runtime still selects interactive admission, which owns its replacement', async () => {
    const s = await session()
    seed(s, 'rt-t08555-stopping', { transport: 'tmux', invocationState: 'stopping' })
    await turn(s.hostSessionId, headlessIntent())
    expect(observed.reuse).toHaveLength(0)
    expect(observed.interactiveStart).toHaveLength(1)
    expect(observed.interactiveStart[0]?.harness.interactive).toBe(true)
    expect(aspd.compileCalls).toBe(0)
    expect(
      internal()
        .db.runtimes.listByHostSessionId(s.hostSessionId)
        .filter((r) => r.transport === 'headless')
    ).toHaveLength(0)
  })

  it('an established Claude tui selects interactive admission rather than a headless writer beside it', async () => {
    const s = await session()
    seed(s, 'rt-t08555-claude', {
      transport: 'tmux',
      provider: 'anthropic',
      harness: 'claude-code',
      driver: 'claude-code-tmux',
    })
    await turn(s.hostSessionId, headlessIntent())
    expect(aspd.compileCalls).toBe(0)
    expect(observed.interactiveStart).toHaveLength(1)
  })

  it('a foreign-harness headless runtime refuses before any effect at both doors', async () => {
    const s = await session()
    const foreign = seed(s, 'rt-t08555-agent-harness', {
      transport: 'headless',
      harness: 'agent-harness',
    })
    const before = internal().db.runtimes.getByRuntimeId(foreign.runtimeId)
    for (const response of [
      await turn(s.hostSessionId, headlessIntent()),
      await start(s.hostSessionId, headlessIntent()),
    ]) {
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: { detail: { reason?: string } } }
      expect(body.error.detail.reason).toBe('established_runtime_harness_mismatch')
    }
    expect(aspd.compileCalls).toBe(0)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(internal().db.runtimes.getByRuntimeId(foreign.runtimeId)).toEqual(before)
    expect(preparations(s.hostSessionId)).toEqual([])
  })

  it('start door: an established codex-tui runtime is reused by interactive admission, never a headless start', async () => {
    const s = await session()
    const tui = seed(s, 'rt-t08555-tui-start', { transport: 'tmux' })
    // The seeded pane has no tmux server; liveness probing is not under test.
    ;(server as unknown as Record<string, unknown>)['reconcileTmuxRuntimeLiveness'] = async (
      runtime: HrcRuntimeSnapshot
    ) => runtime
    const response = await start(s.hostSessionId, headlessIntent())
    // Interactive admission reuses the matching established pane as it is.
    expect(((await response.json()) as { runtimeId: string }).runtimeId).toBe(tui.runtimeId)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(aspd.compileCalls).toBe(0)
    expect(
      internal()
        .db.runtimes.listByHostSessionId(s.hostSessionId)
        .filter((r) => r.transport === 'headless')
    ).toHaveLength(0)
  })

  function inFlight(s: HrcSessionRecord) {
    let born!: (runtime: HrcRuntimeSnapshot) => void
    const birth = new Promise<HrcRuntimeSnapshot>((resolve) => {
      born = resolve
    })
    internal().runtimeStartOperations.set(s.hostSessionId, birth)
    return {
      birth,
      settle(runtime: HrcRuntimeSnapshot) {
        internal().runtimeStartOperations.delete(s.hostSessionId)
        born(runtime)
      },
    }
  }

  it('a dispatch crossing a same-harness interactive birth with no row yet takes interactive admission', async () => {
    const s = await session()
    const start = inFlight(s)
    recordStartBirth(start.birth, { transport: 'tmux', provider: 'openai', harness: 'codex-cli' })
    const pending = turn(s.hostSessionId, headlessIntent())
    await Bun.sleep(50)
    // No row exists yet, and the crossing dispatch started no headless writer.
    expect(aspd.compileCalls).toBe(0)
    start.settle(seed(s, 'rt-t08555-birth', { transport: 'tmux' }))
    await pending
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse.length + observed.interactiveStart.length).toBe(1)
  })

  it('a crossing same-harness tmux birth is joined only through admission caller policy (T-07397)', async () => {
    const s = await session()
    const refusing = {
      ...headlessIntent(),
      execution: { preferredMode: 'headless', allowInteractiveSurfaceReuse: false },
    }
    const cases: Array<{ label: string; intent: unknown; extra: object; delivered: boolean }> = [
      { label: 'reuse refusal', intent: refusing, extra: {}, delivered: false },
      {
        label: 'forged proof',
        intent: headlessIntent(),
        extra: { establishedBrokerInvocationId: 'inv-forged' },
        delivered: false,
      },
      {
        label: 'own proof',
        intent: refusing,
        extra: { establishedBrokerInvocationId: 'inv-rt-t08555-own' },
        delivered: true,
      },
    ]
    for (const [index, entry] of cases.entries()) {
      const start = inFlight(s)
      recordStartBirth(start.birth, { transport: 'tmux', provider: 'openai', harness: 'codex-cli' })
      const pending = turn(s.hostSessionId, entry.intent, entry.extra)
      await Bun.sleep(30)
      const runtimeId = entry.delivered ? 'rt-t08555-own' : `rt-t08555-newborn-${index}`
      const newborn = seed(s, runtimeId, { transport: 'tmux' })
      const before = internal().db.runtimes.getByRuntimeId(newborn.runtimeId)
      start.settle(newborn)
      const response = await pending
      expect({ label: entry.label, status: response.status }).toEqual({
        label: entry.label,
        status: 503,
      })
      const text = await response.text()
      if (entry.delivered) {
        expect(text).toContain('observed-interactive-reuse')
        expect(observed.reuse.at(-1)).toBe(newborn.runtimeId)
      } else {
        expect(text).toContain('caller-surface-reuse-refusal')
        expect(internal().db.runtimes.getByRuntimeId(newborn.runtimeId)).toEqual(before)
      }
      internal().db.runtimes.update(newborn.runtimeId, { status: 'terminated' } as never)
    }
    expect(observed.reuse).toEqual(['rt-t08555-own'])
    expect(observed.interactiveStart).toHaveLength(0)
    expect(aspd.compileCalls).toBe(0)
  })

  it('turnover: a start swapped in after routing is re-checked at the join, never consumed under the old route', async () => {
    const s = await session()
    const codexTmux = { transport: 'tmux', provider: 'openai', harness: 'codex-cli' } as const
    const cases = [
      {
        label: 'interactive → foreign tmux birth',
        classified: codexTmux,
        swapped: { transport: 'tmux', provider: 'anthropic', harness: 'claude-code' } as const,
        reason: 'start_in_flight_harness_mismatch',
      },
      {
        label: 'headless → foreign headless birth',
        classified: { transport: 'headless', provider: 'openai', harness: 'codex-cli' } as const,
        swapped: { transport: 'headless', provider: 'openai', harness: 'agent-harness' } as const,
        reason: 'established_runtime_harness_mismatch',
      },
      {
        label: 'interactive → same-harness headless birth',
        classified: codexTmux,
        swapped: { transport: 'headless', provider: 'openai', harness: 'codex-cli' } as const,
        reason: 'start_in_flight_changed',
      },
      {
        label: 'interactive → unrecorded start',
        classified: codexTmux,
        swapped: undefined,
        reason: 'start_in_flight_unclassified',
      },
    ]
    for (const entry of cases) {
      const first = inFlight(s)
      const decision = createStartBirthDecision()
      recordStartBirth(first.birth, decision.decided)
      const pending = turn(s.hostSessionId, headlessIntent())
      await Bun.sleep(30)
      // Settle the routing decision and, before the dispatch resumes, replace
      // the in-flight start with a different one.
      const second = new Promise<HrcRuntimeSnapshot>(() => {})
      if (entry.swapped !== undefined) recordStartBirth(second, entry.swapped)
      decision.decide(entry.classified)
      internal().runtimeStartOperations.set(s.hostSessionId, second)
      const response = await pending
      expect({ label: entry.label, status: response.status }).toEqual({
        label: entry.label,
        status: 503,
      })
      const body = (await response.json()) as { error: { detail: { reason?: string } } }
      expect({ label: entry.label, reason: body.error.detail.reason }).toEqual({
        label: entry.label,
        reason: entry.reason,
      })
      internal().runtimeStartOperations.delete(s.hostSessionId)
    }
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse).toHaveLength(0)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toEqual([])
  })

  it('a recorded same-harness tmux birth whose newborn is not reusable is refused, not joined', async () => {
    const s = await session()
    const start = inFlight(s)
    recordStartBirth(start.birth, { transport: 'tmux', provider: 'openai', harness: 'codex-cli' })
    const pending = turn(s.hostSessionId, headlessIntent())
    await Bun.sleep(30)
    // The newborn that actually settles is a Claude seat.
    const newborn = seed(s, 'rt-t08555-claude-newborn', {
      transport: 'tmux',
      provider: 'anthropic',
      harness: 'claude-code',
      driver: 'claude-code-tmux',
    })
    const before = internal().db.runtimes.getByRuntimeId(newborn.runtimeId)
    start.settle(newborn)
    const response = await pending
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { detail: { reason?: string } } }
    expect(body.error.detail.reason).toBe('start_in_flight_not_reusable')
    expect(internal().db.runtimes.getByRuntimeId(newborn.runtimeId)).toEqual(before)
    expect(observed.reuse).toHaveLength(0)
  })

  it('a dispatch crossing a foreign-harness birth of either transport refuses before any effect', async () => {
    const s = await session()
    const cases = [
      {
        birth: { transport: 'tmux', provider: 'anthropic', harness: 'claude-code' },
        reason: 'start_in_flight_harness_mismatch',
      },
      {
        birth: { transport: 'headless', provider: 'openai', harness: 'agent-harness' },
        reason: 'established_runtime_harness_mismatch',
      },
    ] as const
    for (const { birth, reason } of cases) {
      const start = inFlight(s)
      recordStartBirth(start.birth, birth)
      const response = await turn(s.hostSessionId, headlessIntent())
      expect(response.status).toBe(503)
      const body = (await response.json()) as { error: { detail: { reason?: string } } }
      expect(body.error.detail.reason).toBe(reason)
      internal().runtimeStartOperations.delete(s.hostSessionId)
    }
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse).toHaveLength(0)
    expect(observed.interactiveStart).toHaveLength(0)
    expect(internal().db.runtimes.listByHostSessionId(s.hostSessionId)).toEqual([])
  })

  it('a start that recorded no birth is awaited in full, never treated as absent', async () => {
    const s = await session()
    const start = inFlight(s)
    const pending = turn(s.hostSessionId, headlessIntent())
    await Bun.sleep(50)
    expect(aspd.compileCalls).toBe(0)
    start.settle(seed(s, 'rt-t08555-unrecorded', { transport: 'tmux' }))
    await pending
    expect(aspd.compileCalls).toBe(0)
    expect(observed.reuse.length + observed.interactiveStart.length).toBe(1)
  })

  it('a decided birth is read without waiting for the boot itself', async () => {
    const decision = createStartBirthDecision()
    const boot = new Promise<HrcRuntimeSnapshot>(() => {})
    recordStartBirth(boot, decision.decided)
    decision.decide({ transport: 'headless', provider: 'openai', harness: 'codex-cli' })
    expect(await startBirthOf(boot)).toMatchObject({ transport: 'headless' })
    expect(await startBirthOf(Promise.resolve({} as HrcRuntimeSnapshot))).toBeUndefined()
    expect(
      decideCrossingBirthRoute(headlessIntent(), {
        transport: 'headless',
        provider: 'openai',
        harness: 'codex-cli',
      })
    ).toBe('headless')
  })
})
