/**
 * T-09861 — HRC server lifecycle authorization (spec rev 4, Daedalus APPROVED
 * EN-20244), exercised against real isolated HrcServer instances: real stores,
 * real unix sockets, real federation peer listeners on loopback. The executor
 * is the one seam: it records the grant instead of exiting the test process.
 * (The spawned-daemon cases — real restart, stop, provenance, CLI — live in
 * packages/hrc-cli/src/__tests__/t09861-server-lifecycle-e2e.test.ts.)
 *
 * Failure modes: var/wrkq-artifacts/T-09861/failure-modes.md (FMn below).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  HRC_LIFECYCLE_CREDENTIAL_HEADER,
  HRC_LIFECYCLE_RUNTIME_HEADER,
  HRC_LIFECYCLE_SESSION_REF_HEADER,
  type HrcServerLifecycleGrant,
  lifecycleCredentialPath,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  DEFAULT_FEDERATION_GATE,
  type FederationConfig,
  type PeerEntry,
} from '../federation/federation-config.js'
import type { NodeId } from '../federation/node-id.js'
import { createPeerProtocolRequestHandler } from '../federation/peer-protocol.js'
import { PeerToken } from '../federation/peer-token.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { createHrcServer } from '../index.js'
import type { HrcServer, HrcServerOptions } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { federationTestHost } from './fixtures/live-tailnet-test.js'

// Peer endpoints must name a tailnet host; the fixture-only transport maps this
// reserved validation address to loopback (listeners bind 127.0.0.1 directly).
federationTestHost(undefined, { HRC_FEDERATION_TEST_MODE: 'loopback' })
const PEER_HOST = '100.64.0.1'

const MABLE_PRIMARY = 'agent:mable:project:hrc-runtime:task:primary'
const CLOD_PRIMARY = 'agent:clod:project:hrc-runtime:task:primary'
const MABLE_MINISVC = 'agent:mable:project:hrc-runtime:task:minisvc'
const NOW = '2026-09-28T12:00:00.000Z'

type Internal = HrcServer & { db: HrcDatabase }

type Node = {
  fixture: HrcServerTestFixture
  server: Internal
  grants: HrcServerLifecycleGrant[]
}

const started: Node[] = []
const extraServers: { stop(close?: boolean): void }[] = []

afterEach(async () => {
  for (const extra of extraServers.splice(0)) extra.stop(true)
  for (const node of started.splice(0)) {
    await node.server.stop().catch(() => undefined)
    await node.fixture.cleanup()
  }
})

function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port as number
}

function federation(input: {
  nodeId: string
  declared?: boolean
  listenPort?: number
  peers?: Record<string, { port: number; token: string }>
}): FederationConfig {
  const peers = new Map<NodeId, PeerEntry>()
  for (const [nodeId, peer] of Object.entries(input.peers ?? {})) {
    peers.set(nodeId as NodeId, {
      nodeId: nodeId as NodeId,
      endpoint: `http://${PEER_HOST}:${peer.port}/`,
      token: new PeerToken(peer.token),
    })
  }
  return {
    nodeId: input.nodeId as NodeId,
    nodeIdProvenance: input.declared === false ? 'derived' : 'declared',
    sourcePath: '/dev/null',
    sourceExists: true,
    peers,
    ...(input.listenPort === undefined
      ? {}
      : { peerListener: { bind: `http://127.0.0.1:${input.listenPort}/` } }),
    gate: DEFAULT_FEDERATION_GATE,
    warnings: [],
  }
}

async function startNode(
  prefix: string,
  options: Partial<HrcServerOptions> & { withExecutor?: boolean } = {}
): Promise<Node> {
  const fixture = await createHrcTestFixture(prefix)
  const grants: HrcServerLifecycleGrant[] = []
  const { withExecutor = true, ...overrides } = options
  const server = (await createHrcServer(
    fixture.serverOpts({
      ...(withExecutor ? { lifecycleExecutor: (grant) => grants.push(grant) } : {}),
      ...overrides,
    })
  )) as Internal
  const node = { fixture, server, grants }
  started.push(node)
  return node
}

/** A live agent runtime inserted through the store, exactly as a launch does. */
function launchSeat(
  node: Node,
  scopeRef: string,
  options: { survivesBoot?: boolean } = {}
): string {
  const suffix = Math.random().toString(36).slice(2, 10)
  const hostSessionId = `hsid-t09861-${suffix}`
  const runtimeId = `rt-t09861-${suffix}`
  node.server.db.sessions.insert({
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  node.server.db.runtimes.insert({
    runtimeId,
    hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'sdk',
    status: 'ready',
    // An externally-owned seat is left alone by boot reconciliation, so it is
    // still live when the successor backfills (the pre-release seat case).
    ...(options.survivesBoot ? { runtimeStateJson: { lifecycleOwner: 'external' } } : {}),
    supportsInflightInput: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return runtimeId
}

function credentialFor(node: Node, runtimeId: string): string {
  return readFileSync(lifecycleCredentialPath(node.fixture.runtimeRoot, runtimeId), 'utf8').trim()
}

function seatHeaders(node: Node, runtimeId: string, scopeRef: string): Record<string, string> {
  return {
    [HRC_LIFECYCLE_RUNTIME_HEADER]: runtimeId,
    [HRC_LIFECYCLE_CREDENTIAL_HEADER]: credentialFor(node, runtimeId),
    [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${scopeRef}/lane:main`,
  }
}

async function lifecycle(
  node: Node,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await node.fixture.fetchSocket('/v1/server/lifecycle', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

function refusalOf(result: { body: Record<string, unknown> }): string | undefined {
  const error = result.body['error'] as { detail?: { refusal?: string } } | undefined
  return error?.detail?.refusal
}

function messageOf(result: { body: Record<string, unknown> }): string {
  return String((result.body['error'] as { message?: string } | undefined)?.message ?? '')
}

/** A busy headless run with fresh activity: what the in-flight gate protects. */
function seedInFlightRun(node: Node, runtimeId: string, scopeRef: string): void {
  const runtime = node.server.db.runtimes.getByRuntimeId(runtimeId)
  if (runtime === null) throw new Error('seed runtime missing')
  node.server.db.runs.insert({
    runId: `run-${runtimeId}`,
    hostSessionId: runtime.hostSessionId,
    runtimeId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'running',
    acceptedAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
  })
  node.server.db.sqlite.run(
    `UPDATE runtimes SET status = 'busy', active_run_id = ? WHERE runtime_id = ?`,
    [`run-${runtimeId}`, runtimeId]
  )
  appendHrcEvent(node.server.db, 'turn.started', {
    ts: new Date().toISOString(),
    hostSessionId: runtime.hostSessionId,
    scopeRef,
    laneRef: 'main',
    generation: 1,
    runtimeId,
    runId: `run-${runtimeId}`,
    payload: {},
  })
}

describe('T-09861 §3 lifecycle credential', () => {
  it('FM7/§3 mints a 0600 file in a 0700 dir at launch and never puts it in the runtime row', async () => {
    const node = await startNode('hrc-t09861-mint-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const path = lifecycleCredentialPath(node.fixture.runtimeRoot, runtimeId)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(node.fixture.runtimeRoot, 'lifecycle')).mode & 0o777).toBe(0o700)
    expect(credentialFor(node, runtimeId)).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(node.server.db.runtimes.getByRuntimeId(runtimeId))).not.toContain(
      credentialFor(node, runtimeId)
    )
  })

  it('§8.12/FM5 a terminated runtime loses its file and its replayed credential is refused', async () => {
    const node = await startNode('hrc-t09861-replay-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const headers = seatHeaders(node, runtimeId, MABLE_PRIMARY)
    node.server.db.runtimes.updateStatus(runtimeId, 'terminated', new Date().toISOString())
    expect(existsSync(lifecycleCredentialPath(node.fixture.runtimeRoot, runtimeId))).toBe(false)

    const result = await lifecycle(node, { action: 'restart', reason: 'replay' }, headers)
    expect(result.status).toBe(403)
    expect(refusalOf(result)).toBe('credential_unknown')
    expect(node.grants).toEqual([])
  })

  it('§8.12/FM10 a runtime made non-live by raw SQL is refused at request time (liveness re-read)', async () => {
    const node = await startNode('hrc-t09861-rawsql-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const headers = seatHeaders(node, runtimeId, MABLE_PRIMARY)
    node.server.db.sqlite.run(`UPDATE runtimes SET status = 'stale' WHERE runtime_id = ?`, [
      runtimeId,
    ])
    const result = await lifecycle(node, { action: 'restart', reason: 'raw sql' }, headers)
    expect(refusalOf(result)).toBe('credential_revoked')
    expect(node.grants).toEqual([])
  })

  it('FM9/FM6 boot backfills every live runtime with a fresh value and sweeps stale files', async () => {
    const first = await startNode('hrc-t09861-backfill-')
    const runtimeId = launchSeat(first, MABLE_PRIMARY, { survivesBoot: true })
    const before = credentialFor(first, runtimeId)
    const orphan = join(first.fixture.runtimeRoot, 'lifecycle', 'rt-gone.credential')
    writeFileSync(orphan, 'stale\n', { mode: 0o600 })
    await first.server.stop()
    started.splice(started.indexOf(first), 1)

    const grants: HrcServerLifecycleGrant[] = []
    const second = (await createHrcServer(
      first.fixture.serverOpts({ lifecycleExecutor: (grant) => grants.push(grant) })
    )) as Internal
    started.push({ fixture: first.fixture, server: second, grants })
    const after = credentialFor({ fixture: first.fixture, server: second, grants }, runtimeId)
    expect(after).not.toBe(before)
    expect(existsSync(orphan)).toBe(false)

    const replayed = await lifecycle(
      { fixture: first.fixture, server: second, grants },
      { action: 'restart', reason: 'predecessor credential' },
      {
        [HRC_LIFECYCLE_RUNTIME_HEADER]: runtimeId,
        [HRC_LIFECYCLE_CREDENTIAL_HEADER]: before,
        [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${MABLE_PRIMARY}/lane:main`,
      }
    )
    expect(refusalOf(replayed)).toBe('credential_unknown')
    expect(grants).toEqual([])
  })
})

describe('T-09861 §2 authority on the local endpoint', () => {
  it('§8.1 a verified mable primary is granted with the bound scope, never the env string', async () => {
    const node = await startNode('hrc-t09861-grant-', {
      federationConfig: federation({ nodeId: 'max3' }),
    })
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const result = await lifecycle(
      node,
      { action: 'restart', reason: 'T-09861 grant', wait: true },
      seatHeaders(node, runtimeId, MABLE_PRIMARY)
    )
    expect(result.status).toBe(200)
    await Bun.sleep(300)
    expect(node.grants).toHaveLength(1)
    expect(node.grants[0]).toMatchObject({
      requestedBy: MABLE_PRIMARY,
      callerKind: 'mable-primary',
      originNode: 'max3',
      reason: 'T-09861 grant',
      action: 'restart',
      flags: { wait: true, drain: false, force: false },
    })
    const status = (await (await node.fixture.fetchSocket('/v1/status')).json()) as {
      capabilities: { serverLifecycle?: boolean }
    }
    expect(status.capabilities.serverLifecycle).toBe(true)
  })

  it('FM34 an instance without an executor advertises no capability and refuses', async () => {
    const node = await startNode('hrc-t09861-noexec-', { withExecutor: false })
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const status = (await (await node.fixture.fetchSocket('/v1/status')).json()) as {
      capabilities: { serverLifecycle?: boolean }
    }
    expect(status.capabilities.serverLifecycle).toBe(false)
    const result = await lifecycle(
      node,
      { action: 'restart', reason: 'no executor' },
      seatHeaders(node, runtimeId, MABLE_PRIMARY)
    )
    expect(refusalOf(result)).toBe('executor_unavailable')
  })

  it('§8.14 a direct socket call with no credential is refused with the doctrine and break-glass text', async () => {
    const node = await startNode('hrc-t09861-nocred-', {
      federationConfig: federation({ nodeId: 'max3' }),
    })
    const result = await lifecycle(node, { action: 'stop', reason: 'direct', force: true })
    expect(result.status).toBe(403)
    expect(refusalOf(result)).toBe('credential_missing')
    expect(messageOf(result)).toContain(
      'only mable@<project>:primary or Lance may stop the HRC server on max3'
    )
    expect(messageOf(result)).toContain('launchctl kickstart -k gui/$UID/com.praesidium.hrc-server')
    expect(node.grants).toEqual([])
  })

  it('§8.10 a forged mable-primary session ref with a wrong credential value is refused', async () => {
    const node = await startNode('hrc-t09861-forged-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const result = await lifecycle(
      node,
      { action: 'restart', reason: 'forged' },
      {
        [HRC_LIFECYCLE_RUNTIME_HEADER]: runtimeId,
        [HRC_LIFECYCLE_CREDENTIAL_HEADER]: '0'.repeat(64),
        [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${MABLE_PRIMARY}/lane:main`,
      }
    )
    expect(refusalOf(result)).toBe('credential_unknown')
    expect(node.grants).toEqual([])
  })

  it('§8.11 a real mable credential presented with another seat session ref is a credential_mismatch', async () => {
    const node = await startNode('hrc-t09861-mismatch-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const result = await lifecycle(
      node,
      { action: 'restart', reason: 'copied credential' },
      {
        ...seatHeaders(node, runtimeId, MABLE_PRIMARY),
        [HRC_LIFECYCLE_SESSION_REF_HEADER]: `${CLOD_PRIMARY}/lane:main`,
      }
    )
    expect(refusalOf(result)).toBe('credential_mismatch')
    expect(node.grants).toEqual([])
  })

  it('FM16 an authorized caller without --reason is refused', async () => {
    const node = await startNode('hrc-t09861-reason-')
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const result = await lifecycle(
      node,
      { action: 'restart' },
      seatHeaders(node, runtimeId, MABLE_PRIMARY)
    )
    expect(refusalOf(result)).toBe('reason_required')
    expect(node.grants).toEqual([])
  })

  it('§8.13/FM15 --wait, --drain and --force from a non-mable seat are refused before any gate or drain', async () => {
    const node = await startNode('hrc-t09861-flags-')
    const clod = launchSeat(node, CLOD_PRIMARY)
    const busy = launchSeat(node, 'agent:cody:project:hrc-runtime:task:T-1')
    seedInFlightRun(node, busy, 'agent:cody:project:hrc-runtime:task:T-1')
    const headers = seatHeaders(node, clod, CLOD_PRIMARY)
    for (const flags of [
      { wait: true, waitTimeoutMs: 60_000 },
      { drain: true, drainTimeoutMs: 60_000 },
      { force: true },
    ]) {
      for (const action of ['restart', 'stop'] as const) {
        if (action === 'stop' && 'drain' in flags) continue
        const startedAt = Date.now()
        const result = await lifecycle(node, { action, reason: 'x', ...flags }, headers)
        expect(Date.now() - startedAt).toBeLessThan(5_000)
        expect(result.status).toBe(403)
        expect(refusalOf(result)).toBe('not_authorized')
      }
    }
    const admission = (await (
      await node.fixture.fetchSocket('/v1/server/turn-admission')
    ).json()) as { state: string }
    expect(admission.state).toBe('open')
    expect(node.grants).toEqual([])
  })

  it('FM25 an authorized request with work in flight and no --wait/--force is refused 409 and nothing runs', async () => {
    const node = await startNode('hrc-t09861-inflight-')
    const mable = launchSeat(node, MABLE_PRIMARY)
    const busy = launchSeat(node, 'agent:cody:project:hrc-runtime:task:T-2')
    seedInFlightRun(node, busy, 'agent:cody:project:hrc-runtime:task:T-2')
    const result = await lifecycle(
      node,
      { action: 'stop', reason: 'busy node' },
      seatHeaders(node, mable, MABLE_PRIMARY)
    )
    expect(result.status).toBe(409)
    expect((result.body['error'] as { code: string }).code).toBe('server_lifecycle_in_flight')
    await Bun.sleep(300)
    expect(node.grants).toEqual([])

    // The gate released the in-progress latch: --force now proceeds.
    const forced = await lifecycle(
      node,
      { action: 'stop', reason: 'busy node', force: true },
      seatHeaders(node, mable, MABLE_PRIMARY)
    )
    expect(forced.status).toBe(200)
  })

  it('FM17 a second lifecycle request while one is executing is refused', async () => {
    const node = await startNode('hrc-t09861-busy-')
    const mable = launchSeat(node, MABLE_PRIMARY)
    const first = await lifecycle(
      node,
      { action: 'restart', reason: 'first' },
      seatHeaders(node, mable, MABLE_PRIMARY)
    )
    expect(first.status).toBe(200)
    const second = await lifecycle(
      node,
      { action: 'restart', reason: 'second' },
      seatHeaders(node, mable, MABLE_PRIMARY)
    )
    expect(refusalOf(second)).toBe('lifecycle_in_progress')
  })

  it('§8.7/§8.9 another agent primary and a mable task seat are refused', async () => {
    const node = await startNode('hrc-t09861-others-', {
      federationConfig: federation({ nodeId: 'max3' }),
    })
    for (const scope of [CLOD_PRIMARY, 'agent:mable:project:hrc-runtime:task:T-09861']) {
      const runtimeId = launchSeat(node, scope)
      const result = await lifecycle(
        node,
        { action: 'restart', reason: 'x' },
        seatHeaders(node, runtimeId, scope)
      )
      expect(refusalOf(result)).toBe('not_authorized')
      expect(messageOf(result)).toContain('request it from mable@hrc-runtime:primary')
    }
    expect(node.grants).toEqual([])
  })

  it('§8.4/§8.6/§8.8/FM13 the Rule B allowlist is closed and bound to the declared node', async () => {
    const cases: Array<{ node: string; declared?: boolean; scope: string; allowed: boolean }> = [
      { node: 'svc', scope: MABLE_MINISVC, allowed: true },
      { node: 'svc', scope: 'agent:mable:project:agent-spaces:task:minisvc', allowed: true },
      { node: 'svc', declared: false, scope: MABLE_MINISVC, allowed: false },
      { node: 'max3', scope: MABLE_MINISVC, allowed: false },
      { node: 'svc', scope: 'agent:clod:project:hrc-runtime:task:minisvc', allowed: false },
      { node: 'hrcdev', scope: 'agent:mable:project:hrc-runtime:task:hrcdev', allowed: true },
      { node: 'hrcdev', scope: 'agent:mable:project:agent-spaces:task:hrcdev', allowed: false },
      { node: 'svc', scope: 'agent:mable:project:hrc-runtime:task:hrcdev', allowed: false },
    ]
    for (const entry of cases) {
      const node = await startNode('hrc-t09861-ruleb-', {
        federationConfig: federation({ nodeId: entry.node, declared: entry.declared ?? true }),
      })
      const runtimeId = launchSeat(node, entry.scope)
      const result = await lifecycle(
        node,
        { action: 'restart', reason: 'rule b' },
        seatHeaders(node, runtimeId, entry.scope)
      )
      expect({ ...entry, status: result.status }).toEqual({
        ...entry,
        status: entry.allowed ? 200 : 403,
      })
      if (!entry.allowed) {
        expect(refusalOf(result)).toBe('not_authorized')
      } else {
        await Bun.sleep(250)
        expect(node.grants[0]?.callerKind).toBe('mable-node-local')
      }
    }
  }, 60_000)

  it('§2 refusal text names the target node Mable seat', async () => {
    const node = await startNode('hrc-t09861-text-', {
      federationConfig: federation({ nodeId: 'svc' }),
    })
    const result = await lifecycle(node, { action: 'restart', reason: 'x' })
    expect(messageOf(result)).toContain(
      "only mable@<project>:primary, this node's Mable seat (mable@<project>:minisvc) or Lance may restart the HRC server on svc"
    )
  })

  it('FM22 a mable primary naming a node that is not a peer is refused and nothing is sent', async () => {
    const node = await startNode('hrc-t09861-unknown-', {
      federationConfig: federation({ nodeId: 'max3' }),
    })
    const runtimeId = launchSeat(node, MABLE_PRIMARY)
    const result = await lifecycle(
      node,
      { action: 'restart', reason: 'x', targetNode: 'nowhere' },
      seatHeaders(node, runtimeId, MABLE_PRIMARY)
    )
    expect(refusalOf(result)).toBe('unknown_node')
    expect(node.grants).toEqual([])
  })
})

describe('T-09861 §5 cross-node (Rule A only)', () => {
  async function pair(originNode = 'max3'): Promise<{ origin: Node; target: Node }> {
    const originPort = freePort()
    const targetPort = freePort()
    const pairSecret = 'fixture-pair'
    const target = await startNode('hrc-t09861-target-', {
      federationConfig: federation({
        nodeId: 'svc',
        listenPort: targetPort,
        peers: { [originNode]: { port: originPort, token: pairSecret } },
      }),
    })
    const origin = await startNode('hrc-t09861-origin-', {
      federationConfig: federation({
        nodeId: originNode,
        listenPort: originPort,
        peers: { svc: { port: targetPort, token: pairSecret } },
      }),
    })
    return { origin, target }
  }

  it('§8.3 a verified mable primary reaches the target; the target grant shows originNode and callerKind', async () => {
    const { origin, target } = await pair()
    const runtimeId = launchSeat(origin, MABLE_PRIMARY)
    const result = await lifecycle(
      origin,
      { action: 'restart', reason: 'deploy svc', targetNode: 'svc', proofTimeoutMs: 600 },
      seatHeaders(origin, runtimeId, MABLE_PRIMARY)
    )
    expect(result.status).toBe(200)
    expect(result.body['targetNode']).toBe('svc')
    // The fake executor never restarts, so the origin reports an unproven restart.
    expect((result.body['remote'] as { proven: boolean }).proven).toBe(false)
    await Bun.sleep(300)
    expect(origin.grants).toEqual([])
    expect(target.grants).toHaveLength(1)
    expect(target.grants[0]).toMatchObject({
      requestedBy: MABLE_PRIMARY,
      callerKind: 'mable-primary',
      originNode: 'max3',
      reason: 'deploy svc',
      action: 'restart',
    })
  })

  it('§8.5/FM14 a node-local seat is never attested cross-node', async () => {
    const port = freePort()
    const svcOrigin = await startNode('hrc-t09861-svcorigin-', {
      federationConfig: federation({
        nodeId: 'svc',
        peers: { hrcdev: { port, token: 'tok-x' } },
      }),
    })
    const runtimeId = launchSeat(svcOrigin, MABLE_MINISVC)
    const result = await lifecycle(
      svcOrigin,
      { action: 'restart', reason: 'cross', targetNode: 'hrcdev' },
      seatHeaders(svcOrigin, runtimeId, MABLE_MINISVC)
    )
    expect(refusalOf(result)).toBe('node_local_cross_node')
    expect(svcOrigin.grants).toEqual([])
  })

  it('§8.7 another agent primary with --node is refused at the origin', async () => {
    const { origin, target } = await pair()
    const runtimeId = launchSeat(origin, CLOD_PRIMARY)
    const result = await lifecycle(
      origin,
      { action: 'restart', reason: 'x', targetNode: 'svc' },
      seatHeaders(origin, runtimeId, CLOD_PRIMARY)
    )
    expect(refusalOf(result)).toBe('not_authorized')
    await Bun.sleep(200)
    expect(target.grants).toEqual([])
  })

  it('§8.14/FM18-FM21 the target refuses non-peers, forged tokens and every non-mable-primary attestation', async () => {
    const targetPort = freePort()
    const target = await startNode('hrc-t09861-peerdoor-', {
      federationConfig: federation({
        nodeId: 'svc',
        listenPort: targetPort,
        peers: { max3: { port: freePort(), token: 'tok-good' } },
      }),
    })
    const url = `http://127.0.0.1:${targetPort}/v1/federation/server-lifecycle`
    const attestation = {
      requestId: 'lifecycle-x',
      originNode: 'max3',
      requestedBy: MABLE_PRIMARY,
      callerKind: 'mable-primary',
      reason: 'x',
      action: 'restart',
      flags: { wait: false, drain: false, force: false },
    }
    const post = async (body: unknown, token?: string) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    expect((await post(attestation)).status).toBe(401)
    expect((await post(attestation, 'tok-bad')).status).toBe(401)
    for (const forged of [
      { callerKind: 'mable-node-local', requestedBy: MABLE_MINISVC },
      { callerKind: 'operator' },
      { requestedBy: CLOD_PRIMARY },
      { requestedBy: 'agent:mable:project:hrc-runtime:task:T-09861' },
      { originNode: 'hrcdev' },
    ]) {
      const result = await post({ ...attestation, ...forged }, 'tok-good')
      expect({ forged, status: result.status }).toEqual({ forged, status: 403 })
      expect(refusalOf(result)).toBe('attestation_refused')
    }
    const noReason = await post({ ...attestation, reason: ' ' }, 'tok-good')
    expect(refusalOf(noReason)).toBe('reason_required')
    await Bun.sleep(200)
    expect(target.grants).toEqual([])

    // The genuine attestation from the authenticated peer is accepted.
    expect((await post(attestation, 'tok-good')).status).toBe(200)
    await Bun.sleep(250)
    expect(target.grants[0]?.originNode).toBe('max3')
  })

  it('§8.18 a target that predates the contract is reported as such, not signalled', async () => {
    const targetPort = freePort()
    const legacy = Bun.serve({
      hostname: '127.0.0.1',
      port: targetPort,
      fetch: createPeerProtocolRequestHandler({
        localNodeId: 'svc',
        peers: new Map([
          [
            'max3',
            {
              nodeId: 'max3' as NodeId,
              endpoint: `http://${PEER_HOST}:1/`,
              token: new PeerToken('tok-legacy'),
            },
          ],
        ]),
        locate: async () => ({}),
        health: () => ({
          startedAt: NOW,
          capabilities: { locate: true, health: true },
        }),
      }),
    })
    extraServers.push(legacy)
    const origin = await startNode('hrc-t09861-legacy-origin-', {
      federationConfig: federation({
        nodeId: 'max3',
        peers: { svc: { port: targetPort, token: 'tok-legacy' } },
      }),
    })
    const runtimeId = launchSeat(origin, MABLE_PRIMARY)
    const result = await lifecycle(
      origin,
      { action: 'restart', reason: 'activation', targetNode: 'svc' },
      seatHeaders(origin, runtimeId, MABLE_PRIMARY)
    )
    expect(result.status).toBe(403)
    expect(messageOf(result)).toContain('svc: the running daemon predates the lifecycle contract')
  })
})
