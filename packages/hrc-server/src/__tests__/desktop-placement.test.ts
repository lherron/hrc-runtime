import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import { desktopHomeFamily, ensureDesktopPlacement } from '../desktop/placement.js'
import { registerDesktopThread } from '../desktop/registration.js'
import { allocateDesktopSlot } from '../desktop/scope-reservation.js'
import type { FederationConfig } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { createLocalBindingRegistryClient } from '../federation/registry-client.js'
import type { SummonGateServerContext } from '../federation/summon-gate-server.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'

let root: string
let db: ReturnType<typeof openHrcDatabase>
let registry: ReturnType<typeof openBindingRegistry>
let server: SummonGateServerContext
const scope = 'agent:stella:project:arris:task:minisvc-nova'
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-placement-'))
  db = openHrcDatabase(join(root, 'state.sqlite'))
  registry = openBindingRegistry(join(root, 'registry.sqlite'))
  server = {
    db,
    federationConfig: {
      nodeId: parseNodeId('svc'),
      sourceExists: true,
      peers: new Map(),
      gate: { mode: 'enforce', registryHost: parseNodeId('svc') },
    } as FederationConfig,
    registryClient: createLocalBindingRegistryClient(registry, 'svc'),
    policyFor: async () => ({
      placement: { pins: {}, homes: { primary: 'max3', minisvc: 'svc', minilab: 'lab' } },
    }),
  }
})
afterEach(async () => {
  db.close()
  registry.close()
  await rm(root, { recursive: true, force: true })
})

test('mini uses its declared minisvc family and persists routing authority', async () => {
  const family = await desktopHomeFamily(server, scope)
  expect(family).toEqual({ baseTask: 'minisvc' })
  const slot = allocateDesktopSlot(db, 'stella', 'arris', 'minisvc')
  expect(slot.scopeRef).toBe(scope)
  expect(await ensureDesktopPlacement(server, scope, 'thread')).toBeUndefined()
  expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(scope)?.homeNodeId).toBe('svc')
  expect(await server.registryClient!.consult(scope)).toMatchObject({
    outcome: 'bound',
    binding: { homeNodeId: 'svc' },
  })
  expect(await ensureDesktopPlacement(server, scope, 'thread')).toBeUndefined()
})
test('foreign binding refuses successful registration without local authority', async () => {
  registry.establish({ scopeRef: scope, homeNodeId: 'max3', now: new Date().toISOString() })
  expect(await ensureDesktopPlacement(server, scope, 'thread')).toMatchObject({
    status: 'pending',
    reason: 'binding_conflict',
  })
  expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(scope)).toBeUndefined()
})
test('old primary scope cannot silently establish on mini against policy', async () => {
  expect(
    await ensureDesktopPlacement(server, scope.replace('minisvc', 'primary'), 'thread')
  ).toMatchObject({ status: 'pending', reason: 'placement_refused' })
})
test('registry failure stays pending', async () => {
  server = {
    ...server,
    registryClient: {
      ...server.registryClient!,
      consult: async () => {
        throw new Error('offline')
      },
    },
  }
  expect(await ensureDesktopPlacement(server, scope, 'thread')).toMatchObject({ status: 'pending' })
  expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(scope)).toBeUndefined()
})
test('multiple declared local home families require an explicit choice', async () => {
  server = {
    ...server,
    policyFor: async () => ({ placement: { pins: {}, homes: { minisvc: 'svc', other: 'svc' } } }),
  }
  expect(await desktopHomeFamily(server, scope)).toMatchObject({
    status: 'pending',
    reason: 'desktop_home_ambiguous',
  })
})

test('real registration publishes a minisvc address only after binding and replays it', async () => {
  const workspace = join(root, 'arris')
  await mkdir(join(workspace, '.git'), { recursive: true })
  const nativeThreadId = '01a093e4-6652-7260-9d87-adfc65c033ab'
  const rolloutPath = join(root, 'rollout.jsonl')
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        id: nativeThreadId,
        cwd: workspace,
        source: 'vscode',
        originator: 'Codex Desktop',
        thread_source: 'user',
      },
    })}\n`
  )
  const instance = {
    ...server,
    options: { federationConfig: server.federationConfig },
    appendEvent: () => {
      expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(scope)?.homeNodeId).toBe(
        'svc'
      )
      return {}
    },
    notifyEvent: () => {},
    attachDesktopObserver: async () => ({
      attached: false,
      reason: 'test_stub',
      detail: 'no desktop process in fixture',
    }),
  } as unknown as HrcServerInstanceForHandlers
  const request = { nativeThreadId, codexHome: root, rolloutPath }
  const options = { registryProjects: [{ slug: 'arris', root: workspace }] }
  const unavailable = {
    ...instance,
    registryClient: {
      ...server.registryClient,
      consult: async () => {
        throw new Error('offline')
      },
    },
  } as unknown as HrcServerInstanceForHandlers
  expect(await registerDesktopThread.call(unavailable, request, options)).toMatchObject({
    status: 'pending',
  })
  expect(db.desktopThreadRegistrations.getByScopeRef(scope)).toBeNull()
  const result = await registerDesktopThread.call(instance, request, options)
  expect(result.status === 'registered' && result.cache.scopeRef).toBe(scope)
  const replay = await registerDesktopThread.call(instance, request, options)
  expect(replay.status === 'registered' && replay.cache.scopeRef).toBe(scope)
  await new Promise((resolve) => setTimeout(resolve, 10))
})
