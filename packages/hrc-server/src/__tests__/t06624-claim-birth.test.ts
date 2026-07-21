import { afterEach, describe, expect, test } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'

import type { FederationConfig } from '../federation/federation-config.js'
import {
  persistSessionTaskClaimAuthority,
  withSummonAuthority,
} from '../federation/summon-gate-server.js'
import {
  type TaskClaimAuthority,
  createTaskClaimClient,
  taskClaimCommandEnvironment,
} from '../federation/task-claim-client.js'
import {
  cleanupRuntimeTaskClaimCredentialFile,
  injectRuntimeTaskClaimCredentialFile,
} from '../federation/task-claim-runtime.js'

const SCOPE = 'agent:room-coordinator:project:hrc-runtime:task:T-06624'
const AUTHORITY: TaskClaimAuthority = {
  taskId: 'T-06624',
  claimedBy: 'agent:room-coordinator',
  claimedScope: SCOPE,
  claimedNode: 'lab',
  claimedAt: '2026-07-21T04:00:00.000Z',
  claimGeneration: 3,
  claimToken: 'secret-claim-bearer',
}

describe('T-06624 claim-birth summon authority', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  async function harness(
    options: {
      claimsTask?: boolean
      claim?: () => Promise<TaskClaimAuthority>
      release?: (authority: TaskClaimAuthority) => Promise<void>
    } = {}
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-t06624-'))
    tempDirs.push(directory)
    const db = openHrcDatabase(join(directory, 'state.sqlite'))
    const registry = openBindingRegistry(join(directory, 'registry.sqlite'))
    const calls: string[] = []
    const server = {
      db,
      options: { runtimeRoot: directory },
      federationConfig: {
        nodeId: 'svc',
        nodeIdProvenance: 'declared',
        sourcePath: join(directory, 'federation.json'),
        sourceExists: true,
        peers: new Map(),
        gate: { mode: 'enforce' },
        warnings: [],
      } as FederationConfig,
      registryClient: {
        async consult(scopeRef: string) {
          const record = registry.getRecord(scopeRef)
          if (record === undefined) return { outcome: 'unbound' } as const
          return record.state === 'retired'
            ? ({ outcome: 'retired', retirement: record } as const)
            : ({ outcome: 'bound', binding: registry.get(scopeRef)! } as const)
        },
        async establish(request: Parameters<typeof registry.establish>[0]) {
          calls.push('registry')
          return registry.establish(request)
        },
      },
      policyFor: async () => ({
        placement: { pins: {}, defaultHomeNode: 'svc' },
        claimsTask: options.claimsTask ?? true,
      }),
      capabilityFor: async () => ({ outcome: 'capable' as const }),
      taskClaimClient: {
        async claim() {
          calls.push('claim')
          return options.claim?.() ?? AUTHORITY
        },
        async release(authority: TaskClaimAuthority) {
          calls.push('release')
          await options.release?.(authority)
        },
      },
    }
    return { calls, db, directory, registry, server }
  }

  test('claim linearizes before registry and session mint, then the secret stays off session JSON', async () => {
    const h = await harness()
    try {
      const session = await withSummonAuthority(
        h.server,
        { scopeRef: SCOPE, path: 'resolve-session', intent: 'explicit_local' },
        (claimAuthority) => {
          h.calls.push('mint')
          const now = '2026-07-21T04:00:01.000Z'
          const inserted = h.db.sessions.insert({
            hostSessionId: 'hsid-claim-born',
            scopeRef: SCOPE,
            laneRef: 'main',
            generation: 1,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            ancestorScopeRefs: [],
          })
          if (claimAuthority === undefined) throw new Error('claim authority missing')
          persistSessionTaskClaimAuthority(h.server, inserted.hostSessionId, claimAuthority, now)
          return inserted
        }
      )

      expect(h.calls).toEqual(['claim', 'registry', 'mint'])
      expect(h.registry.get(SCOPE)).toMatchObject({
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'claim-birth',
          taskId: 'T-06624',
          claimedNode: 'lab',
          claimGeneration: 3,
        },
      })
      expect(createPlacementLedgerRepository(h.db.sqlite).activeAuthority(SCOPE)).toMatchObject({
        birthClass: 'mechanism-born',
        authorityProvenance: { kind: 'claim-birth', claimGeneration: 3 },
      })
      expect(h.db.sessionTaskClaimAuthorities.getByHostSessionId(session.hostSessionId)).toEqual({
        hostSessionId: session.hostSessionId,
        ...AUTHORITY,
        createdAt: '2026-07-21T04:00:01.000Z',
      })
      expect(JSON.stringify(h.db.sessions.getByHostSessionId(session.hostSessionId))).not.toContain(
        AUTHORITY.claimToken
      )
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('already-claimed refusal provisions no registry, ledger, or session', async () => {
    const h = await harness({
      claim: async () => {
        throw new Error('already_claimed: held by agent:room-coordinator on max3 generation 9')
      },
    })
    try {
      let minted = false
      await expect(
        withSummonAuthority(
          h.server,
          { scopeRef: SCOPE, path: 'ensure-target', intent: 'implicit' },
          () => {
            minted = true
          }
        )
      ).rejects.toThrow('already_claimed')
      expect(minted).toBe(false)
      expect(h.calls).toEqual(['claim'])
      expect(h.registry.getRecord(SCOPE)).toBeUndefined()
      expect(createPlacementLedgerRepository(h.db.sqlite).get(SCOPE)).toBeUndefined()
      expect(h.db.sessions.count()).toBe(0)
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('concurrent double-dispatch produces one mint and one named already_claimed refusal', async () => {
    let held = false
    const h = await harness({
      claim: async () => {
        if (held) {
          throw new Error('already_claimed: held by agent:room-coordinator on lab generation 3')
        }
        held = true
        return AUTHORITY
      },
    })
    try {
      let mintCount = 0
      const dispatch = () =>
        withSummonAuthority(
          h.server,
          { scopeRef: SCOPE, path: 'ensure-target', intent: 'implicit' },
          () => {
            mintCount += 1
            return `mint-${mintCount}`
          }
        )
      const settled = await Promise.allSettled([dispatch(), dispatch()])
      expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
      const rejection = settled.find((entry) => entry.status === 'rejected')
      expect(rejection?.status === 'rejected' ? String(rejection.reason) : '').toContain(
        'already_claimed'
      )
      expect(rejection?.status === 'rejected' ? String(rejection.reason) : '').toContain('lab')
      expect(mintCount).toBe(1)
      expect(h.calls.filter((call) => call === 'claim')).toHaveLength(2)
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('a mint failure releases the fresh claim best-effort', async () => {
    const released: TaskClaimAuthority[] = []
    const h = await harness({ release: async (authority) => void released.push(authority) })
    try {
      await expect(
        withSummonAuthority(
          h.server,
          { scopeRef: SCOPE, path: 'command-run', intent: 'implicit' },
          () => {
            h.calls.push('mint')
            throw new Error('fixture mint failed')
          }
        )
      ).rejects.toThrow('fixture mint failed')
      expect(h.calls).toEqual(['claim', 'registry', 'mint', 'release'])
      expect(released).toEqual([AUTHORITY])
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('federated bare addressing cannot acquire an unknown claims_task scope', async () => {
    const h = await harness()
    try {
      await expect(
        withSummonAuthority(
          h.server,
          {
            scopeRef: SCOPE,
            path: 'ensure-target',
            intent: 'implicit',
            origin: 'federated-ingress',
          },
          () => undefined
        )
      ).rejects.toThrow('Federated bare addressing')
      expect(h.calls).toEqual([])
      expect(h.registry.getRecord(SCOPE)).toBeUndefined()
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('a registry-known claim birth without a local session still refuses bare recreation', async () => {
    const h = await harness()
    try {
      h.registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'claim-birth',
          taskId: AUTHORITY.taskId,
          claimedBy: AUTHORITY.claimedBy,
          claimedScope: AUTHORITY.claimedScope,
          claimedNode: AUTHORITY.claimedNode,
          claimGeneration: AUTHORITY.claimGeneration,
        },
        establishmentProvenance: 'explicit_local',
        now: AUTHORITY.claimedAt,
      })
      await expect(
        withSummonAuthority(
          h.server,
          { scopeRef: SCOPE, path: 'ensure-target', intent: 'implicit' },
          () => undefined
        )
      ).rejects.toThrow('no known session')
      expect(h.calls).toEqual([])
      expect(createPlacementLedgerRepository(h.db.sqlite).get(SCOPE)).toBeUndefined()
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('a rebound claim birth reacquires fresh local claim authority before minting', async () => {
    const reboundAuthority: TaskClaimAuthority = {
      ...AUTHORITY,
      claimedNode: 'svc',
      claimGeneration: AUTHORITY.claimGeneration + 1,
    }
    const h = await harness({ claim: async () => reboundAuthority })
    try {
      h.registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'max3',
        placementEpoch: 1,
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'claim-birth',
          taskId: AUTHORITY.taskId,
          claimedBy: AUTHORITY.claimedBy,
          claimedScope: AUTHORITY.claimedScope,
          claimedNode: 'max3',
          claimGeneration: AUTHORITY.claimGeneration,
        },
        establishmentProvenance: 'explicit_local',
        now: AUTHORITY.claimedAt,
      })
      const rebound = h.registry.compareAndSwap({
        scopeRef: SCOPE,
        expectedHomeNodeId: 'max3',
        expectedPlacementEpoch: 1,
        newHomeNodeId: 'svc',
        now: '2026-07-21T04:00:01.000Z',
      })
      expect(rebound.outcome).toBe('updated')
      if (rebound.binding === undefined) throw new Error('rebound binding missing')
      createPlacementLedgerRepository(h.db.sqlite).installActive(rebound.binding)

      await expect(
        withSummonAuthority(
          h.server,
          {
            scopeRef: SCOPE,
            path: 'ensure-target',
            intent: 'implicit',
            origin: 'federated-ingress',
          },
          () => undefined
        )
      ).rejects.toThrow('Federated bare addressing cannot reacquire')
      expect(h.calls).toEqual([])

      const hostSessionId = await withSummonAuthority(
        h.server,
        { scopeRef: SCOPE, path: 'resolve-session', intent: 'explicit_local' },
        (claimAuthority) => {
          h.calls.push('mint')
          expect(claimAuthority).toEqual(reboundAuthority)
          const now = '2026-07-21T04:00:02.000Z'
          const inserted = h.db.sessions.insert({
            hostSessionId: 'hsid-rebound-claim-born',
            scopeRef: SCOPE,
            laneRef: 'main',
            generation: 1,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            ancestorScopeRefs: [],
          })
          if (claimAuthority === undefined) throw new Error('rebound claim authority missing')
          persistSessionTaskClaimAuthority(h.server, inserted.hostSessionId, claimAuthority, now)
          return inserted.hostSessionId
        }
      )

      expect(h.calls).toEqual(['claim', 'mint'])
      expect(h.registry.get(SCOPE)).toMatchObject({
        homeNodeId: 'svc',
        placementEpoch: 2,
        establishmentProvenance: 'rebind',
        authorityProvenance: {
          kind: 'claim-birth',
          claimedNode: 'max3',
          claimGeneration: AUTHORITY.claimGeneration,
        },
      })
      expect(h.db.sessionTaskClaimAuthorities.getByHostSessionId(hostSessionId)).toMatchObject({
        hostSessionId,
        claimedNode: 'svc',
        claimGeneration: reboundAuthority.claimGeneration,
        claimToken: reboundAuthority.claimToken,
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('a non-claims_task agent remains policy-born and never calls wrkq claim', async () => {
    const h = await harness({ claimsTask: false })
    try {
      await withSummonAuthority(
        h.server,
        { scopeRef: SCOPE, path: 'resolve-session', intent: 'explicit_local' },
        (claimAuthority) => {
          expect(claimAuthority).toBeUndefined()
          h.calls.push('mint')
        }
      )
      expect(h.calls).toEqual(['registry', 'mint'])
      expect(h.registry.get(SCOPE)).toMatchObject({ birthClass: 'policy-born' })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('claim credential is materialized mode-0600 and only its path enters dispatch env', async () => {
    const h = await harness()
    try {
      const now = '2026-07-21T04:00:01.000Z'
      h.db.sessions.insert({
        hostSessionId: 'hsid-runtime-claim',
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      persistSessionTaskClaimAuthority(h.server, 'hsid-runtime-claim', AUTHORITY, now)
      const env = injectRuntimeTaskClaimCredentialFile(
        { KEEP: 'yes' },
        { db: h.db, runtimeRoot: h.directory, hostSessionId: 'hsid-runtime-claim' }
      )
      const path = env[HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV]
      expect(path).toBeString()
      expect(env).not.toHaveProperty('WRKQ_CLAIM_TOKEN')
      expect((await stat(path!)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({
        taskId: 'T-06624',
        claimedNode: 'lab',
        claimGeneration: 3,
        claimToken: AUTHORITY.claimToken,
      })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('runtime termination cleanup removes the bearer after the last live sibling', async () => {
    const h = await harness()
    try {
      const now = '2026-07-21T04:00:01.000Z'
      h.db.sessions.insert({
        hostSessionId: 'hsid-runtime-cleanup',
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      persistSessionTaskClaimAuthority(h.server, 'hsid-runtime-cleanup', AUTHORITY, now)
      const env = injectRuntimeTaskClaimCredentialFile(
        {},
        { db: h.db, runtimeRoot: h.directory, hostSessionId: 'hsid-runtime-cleanup' }
      )
      const path = env[HRC_TASK_CLAIM_CREDENTIAL_FILE_ENV]!
      h.db.runtimes.insert({
        runtimeId: 'rt-successor',
        hostSessionId: 'hsid-runtime-cleanup',
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 2,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })

      expect(
        cleanupRuntimeTaskClaimCredentialFile({
          db: h.db,
          runtimeRoot: h.directory,
          hostSessionId: 'hsid-runtime-cleanup',
          runtimeId: 'rt-predecessor',
        })
      ).toEqual({ outcome: 'retained', activeRuntimeIds: ['rt-successor'] })
      expect((await stat(path)).mode & 0o777).toBe(0o600)

      h.db.runtimes.updateStatus('rt-successor', 'terminated', now)
      expect(
        cleanupRuntimeTaskClaimCredentialFile({
          db: h.db,
          runtimeRoot: h.directory,
          hostSessionId: 'hsid-runtime-cleanup',
          runtimeId: 'rt-successor',
        })
      ).toEqual({ outcome: 'removed' })
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      h.registry.close()
      h.db.close()
    }
  })

  test('CLI bridge keeps the bearer out of argv and parses structured authority', async () => {
    const calls: Array<{
      argv: readonly string[]
      env: Record<string, string | undefined> | undefined
    }> = []
    const client = createTaskClaimClient({
      command: '/opt/praesidium/bin/wrkq',
      run: async (argv, env) => {
        calls.push({ argv, env })
        return argv.includes('claim')
          ? {
              stdout: JSON.stringify({ ...AUTHORITY, task: AUTHORITY.taskId }),
              stderr: '',
              exitCode: 0,
            }
          : { stdout: '{}', stderr: '', exitCode: 0 }
      },
    })

    const authority = await client.claim({
      taskId: AUTHORITY.taskId,
      principalRef: AUTHORITY.claimedBy,
      scopeRef: AUTHORITY.claimedScope,
      projectId: 'hrc-runtime',
    })
    await client.release(authority, 'hrc-runtime')

    expect(calls[0]?.argv).toEqual([
      '/opt/praesidium/bin/wrkq',
      '--project',
      'hrc-runtime',
      '--as',
      'agent:room-coordinator',
      'claim',
      'T-06624',
      '--scope',
      SCOPE,
      '--json',
    ])
    expect(calls[1]?.argv.join(' ')).not.toContain(AUTHORITY.claimToken)
    expect(calls[1]?.env).toMatchObject({
      WRKQ_CLAIM_TOKEN: AUTHORITY.claimToken,
      WRKQ_CLAIM_GENERATION: '3',
    })
  })

  test('an explicit daemon token file clears a stale inherited inline token', () => {
    expect(
      taskClaimCommandEnvironment({
        HRC_WRKQ_DB: 'rpc://canonical.example:7171',
        HRC_WRKQD_TOKEN_FILE: '/run/secrets/wrkq-node-token',
        WRKQD_TOKEN: 'stale-dev-token',
        WRKQ_DB_PATH: '/tmp/local.sqlite',
      })
    ).toEqual({
      WRKQ_DB: 'rpc://canonical.example:7171',
      WRKQ_DB_PATH: undefined,
      WRKQ_DB_PATH_FILE: undefined,
      WRKQD_TOKEN: '',
      WRKQD_TOKEN_FILE: '/run/secrets/wrkq-node-token',
    })
  })
})
