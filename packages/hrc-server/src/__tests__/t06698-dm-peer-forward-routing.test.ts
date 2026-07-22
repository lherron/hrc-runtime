import { afterEach, describe, expect } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import {
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { PeerToken } from '../federation/peer-token.js'
import { isTailnetHost } from '../federation/registry-bind.js'
import { HttpBindingRegistryClient } from '../federation/registry-client.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { selectLiveTailnetTest } from './fixtures/live-tailnet-test.js'

const HRCCHAT_MAIN = join(import.meta.dir, '..', '..', '..', 'hrcchat-cli', 'src', 'main.ts')
const TOKEN = 't06698-two-daemon-token'
const TASK = 'codex-019efeb5-1234-7abc-8def-0123456789ab'
const SCOPE = `agent:clod:project:hrc-runtime:task:${TASK}`
const SESSION = `${SCOPE}/lane:main`
const EXTERNAL_TASK = 'codex-019f8aa4-405b-7e00-94d4-cb5294ed76f0'
const EXTERNAL_SCOPE = `agent:cody:project:hrc-runtime:task:${EXTERNAL_TASK}`
const LOCAL_BOUND_TASK = 'codex-019f8aa4-405b-7e00-94d4-cb5294ed76f1'
const LOCAL_BOUND_SCOPE = `agent:cody:project:hrc-runtime:task:${LOCAL_BOUND_TASK}`

function tailnetIpv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && isTailnetHost(entry.address)) return entry.address
    }
  }
  return undefined
}

function reservePorts(host: string): [number, number] {
  const first = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const second = Bun.serve({ hostname: host, port: 0, fetch: () => new Response('probe') })
  const result: [number, number] = [first.port, second.port]
  first.stop(true)
  second.stop(true)
  return result
}

async function eventually<T>(read: () => T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4_000
  let last: T
  do {
    last = read()
    if (accept(last)) return last
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  throw new Error(`condition not reached; last value: ${JSON.stringify(last)}`)
}

async function writeConfig(
  fixture: HrcServerTestFixture,
  document: Record<string, unknown>
): Promise<void> {
  await writeFile(`${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`, JSON.stringify(document), {
    mode: 0o600,
  })
}

async function runCredentialStrippedDm(
  fixture: HrcServerTestFixture,
  target = `clod@hrc-runtime:${TASK}`,
  body = 'T-06698 forwards through the DM entry point'
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  for (const agentId of ['clod', 'cody']) {
    const agentRoot = join(fixture.tmpDir, 'agents', agentId)
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'agent-profile.toml'), 'schemaVersion = 2\n')
  }

  const env = {
    ...process.env,
    ASP_AGENTS_ROOT: join(fixture.tmpDir, 'agents'),
    ASP_PROJECT: 'hrc-runtime',
    HRC_RUNTIME_DIR: fixture.runtimeRoot,
    HRC_STATE_DIR: fixture.stateRoot,
  }
  Reflect.deleteProperty(env, 'HRC_BIRTH_CREDENTIAL')
  const proc = Bun.spawn({
    cmd: ['bun', HRCCHAT_MAIN, 'dm', '--json', target, '-'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  })
  proc.stdin.write(body)
  proc.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('T-06698 hrcchat DM peer forwarding', () => {
  const fixtures: HrcServerTestFixture[] = []
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())))

  const host = tailnetIpv4()
  const liveTest = selectLiveTailnetTest(import.meta.path, host)

  liveTest('an outbound-only origin resolves the registry before local ensure-target', async () => {
    if (host === undefined) throw new Error('tailnet unavailable')
    const svc = await createHrcTestFixture('h98-s-')
    const lab = await createHrcTestFixture('h98-l-')
    fixtures.push(svc, lab)
    const [registryPort, labPeerPort] = reservePorts(host)
    const registryBind = `http://${host}:${registryPort}`
    const labPeerBind = `http://${host}:${labPeerPort}`

    // Model an outbound-only registry host: svc can originate to lab without
    // exposing an inbound F1 peerListener. The old factory omitted its origin
    // outbox in this valid topology and let hrcchat DM fall through to local
    // ensure-target/the summon gate. The live estate additionally needed the
    // target node's inbound listener configured before delivery was reachable.
    await writeConfig(svc, {
      nodeId: 'svc-test',
      peers: { 'lab-test': { endpoint: labPeerBind, token: TOKEN } },
      registry: { bind: registryBind },
      gate: { mode: 'enforce', registryHost: 'svc-test' },
    })
    await writeConfig(lab, {
      nodeId: 'lab-test',
      peers: { 'svc-test': { endpoint: registryBind, token: TOKEN } },
      peerListener: { bind: labPeerBind },
      gate: { mode: 'enforce', registryHost: 'svc-test' },
    })

    const svcServer = await createHrcServer(
      svc.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
    )
    let labServer: Awaited<ReturnType<typeof createHrcServer>> | undefined
    try {
      const registry = new HttpBindingRegistryClient(
        {
          nodeId: 'svc-test',
          endpoint: registryBind,
          token: new PeerToken(TOKEN),
        },
        { log: () => {} }
      )
      const established = await registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'lab-test',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'task_default' },
        establishmentProvenance: 'task_default',
        now: '2026-07-20T00:00:00.000Z',
      })
      expect(established.outcome).toBe('created')

      labServer = await createHrcServer(
        lab.serverOpts({ otelListenerEnabled: false, federationOutboxPollIntervalMs: 10 })
      )
      const localResolve = await lab.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(localResolve.status).toBe(200)

      // The origin previously hosted the same pre-federation scope and now
      // carries the node-local loser fence emitted by namespace reconciliation.
      // That fence must prevent local execution without masking the registry's
      // active remote binding: a DM from the loser still routes to the winner.
      const fenceDb = openHrcDatabase(svc.dbPath)
      try {
        createPlacementLedgerRepository(fenceDb.sqlite).installActive({
          scopeRef: SCOPE,
          homeNodeId: 'svc-test',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'task_default' },
          establishmentProvenance: 'task_default',
          updatedAt: '2026-07-19T23:59:00.000Z',
        })
        createScopeRetirementRepository(fenceDb.sqlite).retire({
          scopeRef: SCOPE,
          retiredNodeId: 'svc-test',
          retiredPlacementEpoch: 1,
          successorNodeId: 'lab-test',
          reason: 'namespace_reconciliation',
          retiredAt: '2026-07-20T00:00:00.000Z',
        })
      } finally {
        fenceDb.close()
      }

      const result = await runCredentialStrippedDm(svc)
      expect(result).toMatchObject({ exitCode: 0, stderr: '' })
      const sent = JSON.parse(result.stdout) as { messageId: string }

      await eventually(
        () => {
          const labDb = openHrcDatabase(lab.dbPath)
          const svcDb = openHrcDatabase(svc.dbPath)
          try {
            return {
              record: labDb.messages.getById(sent.messageId),
              delivery: svcDb.federationOutbox.list()[0],
            }
          } finally {
            labDb.close()
            svcDb.close()
          }
        },
        ({ record }) =>
          record?.body === 'T-06698 forwards through the DM entry point' &&
          record.metadataJson?.['federationIngress'] !== undefined
      )

      const labDb = openHrcDatabase(lab.dbPath)
      try {
        expect(labDb.messages.getById(sent.messageId)?.execution.state).toBe('not_applicable')
        expect(labDb.runtimes.listAll().filter((runtime) => runtime.scopeRef === SCOPE)).toEqual([])
      } finally {
        labDb.close()
      }

      const svcDb = openHrcDatabase(svc.dbPath)
      try {
        expect(svcDb.federationOutbox.list()).toEqual([
          expect.objectContaining({
            messageId: sent.messageId,
            peerNodeId: 'lab-test',
            state: 'delivered',
          }),
        ])
      } finally {
        svcDb.close()
      }

      // The routing fix must not weaken the gate. Calling the genuine local
      // ensure-target surface for the same remotely bound scope still refuses
      // with the established-on-peer invariant.
      const localEnsure = await svc.postJson('/v1/targets/ensure', {
        sessionRef: SESSION,
        runtimeIntent: {
          harness: { provider: 'anthropic', interactive: false, id: 'claude-code' },
        },
      })
      expect(localEnsure.status).toBe(409)
      const localEnsureBody = (await localEnsure.json()) as { error?: { message?: string } }
      expect(localEnsureBody.error?.message).toContain('retired on this node (svc-test)')
      expect(localEnsureBody.error?.message).toContain('successor is lab-test')

      // Registry-unbound, summon-capable delivery now reaches the shared
      // placement resolver. This fixture intentionally has no clod agent home,
      // so the resolver returns the exact typed capability refusal instead of
      // leaking a routing-layer internal error.
      const unbound = await runCredentialStrippedDm(
        svc,
        'clod@hrc-runtime:T-06698-unbound',
        'T-06698 unbound routing probe'
      )
      expect(unbound.exitCode).toBe(1)
      expect(unbound.stdout).toBe('')
      expect(unbound.stderr).toContain('[stale_context]')
      expect(unbound.stderr).toContain('agent home/skills')
      expect(unbound.stderr).not.toContain('[internal_error]')

      // Codex.app owns `task:codex-<uuid>` inboxes outside HRC. When no
      // federation binding exists, hrcchat must still persist the DM on the
      // accepting node for the desktop app to poll, then stop before any HRC
      // session/runtime delivery. Ordinary unbound scopes above still pass
      // through placement policy and fail closed when capability is absent.
      const external = await runCredentialStrippedDm(
        svc,
        `cody@hrc-runtime:${EXTERNAL_TASK}`,
        'T-06803 unbound Codex.app inbox probe'
      )
      expect(external).toMatchObject({ exitCode: 0, stderr: '' })
      const externalSent = JSON.parse(external.stdout) as { messageId: string }

      const externalDb = openHrcDatabase(svc.dbPath)
      try {
        expect(externalDb.messages.getById(externalSent.messageId)).toMatchObject({
          body: 'T-06803 unbound Codex.app inbox probe',
          execution: { state: 'not_applicable' },
        })
        expect(externalDb.continuities.getByKey(EXTERNAL_SCOPE, 'main')).toBeNull()
        expect(externalDb.sessions.listByScopeRef(EXTERNAL_SCOPE)).toEqual([])
        expect(
          externalDb.runtimes.listAll().filter((runtime) => runtime.scopeRef === EXTERNAL_SCOPE)
        ).toEqual([])
        expect(
          createPlacementLedgerRepository(externalDb.sqlite).get(EXTERNAL_SCOPE)
        ).toBeUndefined()
        expect(
          externalDb.federationOutbox
            .list()
            .filter((delivery) => delivery.messageId === externalSent.messageId)
        ).toEqual([])
      } finally {
        externalDb.close()
      }
      expect(await registry.consult(EXTERNAL_SCOPE)).toEqual({ outcome: 'unbound' })

      const localRegistry = openBindingRegistry(
        join(svc.tmpDir, 'federation', 'binding-registry.sqlite')
      )
      try {
        const localEstablished = localRegistry.establish({
          scopeRef: LOCAL_BOUND_SCOPE,
          homeNodeId: 'svc-test',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'explicit_local' },
          establishmentProvenance: 'explicit_local',
          now: '2026-07-20T00:00:01.000Z',
        })
        expect(localEstablished.outcome).toBe('created')
      } finally {
        localRegistry.close()
      }
      const localLedgerDb = openHrcDatabase(svc.dbPath)
      try {
        createPlacementLedgerRepository(localLedgerDb.sqlite).installActive({
          scopeRef: LOCAL_BOUND_SCOPE,
          homeNodeId: 'svc-test',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'explicit_local' },
          establishmentProvenance: 'explicit_local',
          updatedAt: '2026-07-20T00:00:01.000Z',
        })
      } finally {
        localLedgerDb.close()
      }

      const localBound = await runCredentialStrippedDm(
        svc,
        `cody@hrc-runtime:${LOCAL_BOUND_TASK}`,
        'T-06803 local-bound Codex.app inbox probe'
      )
      expect(localBound).toMatchObject({ exitCode: 0, stderr: '' })
      const localBoundSent = JSON.parse(localBound.stdout) as { messageId: string }
      const localBoundDb = openHrcDatabase(svc.dbPath)
      try {
        expect(localBoundDb.messages.getById(localBoundSent.messageId)).toMatchObject({
          execution: { state: 'not_applicable' },
        })
        expect(localBoundDb.sessions.listByScopeRef(LOCAL_BOUND_SCOPE)).toEqual([])
        expect(
          localBoundDb.runtimes
            .listAll()
            .filter((runtime) => runtime.scopeRef === LOCAL_BOUND_SCOPE)
        ).toEqual([])
        expect(
          localBoundDb.federationOutbox
            .list()
            .filter((delivery) => delivery.messageId === localBoundSent.messageId)
        ).toEqual([])
      } finally {
        localBoundDb.close()
      }
    } finally {
      await labServer?.stop()
      await svcServer.stop()
    }
  })
})
