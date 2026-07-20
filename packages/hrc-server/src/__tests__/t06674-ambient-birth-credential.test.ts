import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type PlacementBinding, createPlacementLedgerRepository } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const HRC_MAIN = join(import.meta.dir, '..', '..', '..', 'hrc-cli', 'src', 'cli.ts')
const HRCCHAT_MAIN = join(import.meta.dir, '..', '..', '..', 'hrcchat-cli', 'src', 'main.ts')
const PARENT_SCOPE = 'agent:cody:project:hrc-runtime:task:primary'
const HRC_TASK = 'T-06674-hrc-operator'
const CHAT_TASK = 'T-06674-chat-operator'
const DIRECT_TASK = 'T-06674-direct-child'
const HRC_SCOPE = `agent:clod:project:hrc-runtime:task:${HRC_TASK}`
const CHAT_SCOPE = `agent:clod:project:hrc-runtime:task:${CHAT_TASK}`
const DIRECT_SCOPE = `agent:clod:project:hrc-runtime:task:${DIRECT_TASK}`
const RUNTIME_ID = 'rt-t06674-live-parent'
const RUN_ID = 'run-t06674-live-parent'

function registryStub(): BindingRegistryClient {
  const rows = new Map<string, PlacementBinding>()
  return {
    async consult(scopeRef: string): Promise<RegistryConsultResult> {
      const binding = rows.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      const existing = rows.get(request.scopeRef)
      if (existing !== undefined) return { outcome: 'existing', binding: existing }
      const binding: PlacementBinding = {
        scopeRef: request.scopeRef,
        homeNodeId: request.homeNodeId,
        placementEpoch: request.placementEpoch,
        birthClass: request.birthClass,
        authorityProvenance: request.authorityProvenance,
        establishmentProvenance: request.establishmentProvenance,
        createdAt: request.now,
        updatedAt: request.now,
      }
      rows.set(binding.scopeRef, binding)
      return { outcome: 'created', binding }
    },
  }
}

async function runCli(
  main: string,
  args: string[],
  env: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', main, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe('T-06674 ambient birth credential reach', () => {
  let fixture: HrcServerTestFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  test('operator CLIs follow placement while an explicit direct child remains mechanism-born', async () => {
    fixture = await createHrcTestFixture('hrc-t06674-ambient-')
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: 'svc-test', gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    const agentsRoot = join(fixture.tmpDir, 'agents')
    await mkdir(join(agentsRoot, 'clod'), { recursive: true })
    await writeFile(join(agentsRoot, 'clod', 'agent-profile.toml'), 'schemaVersion = 2\n')

    const server = await createHrcServer(fixture.serverOpts())
    try {
      const now = fixture.now()
      server.db.sessions.insert({
        hostSessionId: 'hsid-t06674-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      server.db.runtimes.insert({
        runtimeId: RUNTIME_ID,
        runtimeKind: 'harness',
        hostSessionId: 'hsid-t06674-parent',
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex',
        provider: 'openai',
        status: 'busy',
        supportsInflightInput: true,
        adopted: false,
        activeRunId: RUN_ID,
        createdAt: now,
        updatedAt: now,
      })
      server.db.runs.insert({
        runId: RUN_ID,
        hostSessionId: 'hsid-t06674-parent',
        runtimeId: RUNTIME_ID,
        scopeRef: PARENT_SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        status: 'running',
        acceptedAt: now,
        startedAt: now,
        updatedAt: now,
      })

      Object.assign(server, {
        registryClient: registryStub(),
        policyFor: async () => ({
          placement: {
            pins: {
              [`hrc-runtime:${HRC_TASK}`]: 'lab-test',
              [`hrc-runtime:${CHAT_TASK}`]: 'lab-test',
              [`hrc-runtime:${DIRECT_TASK}`]: 'lab-test',
            },
          },
          claimsTask: false,
        }),
        capabilityFor: async () => ({ outcome: 'capable' as const }),
      })

      const env = {
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT: 'hrc-runtime',
        HRC_RUNTIME_DIR: fixture.runtimeRoot,
        HRC_STATE_DIR: fixture.stateRoot,
        HRC_BIRTH_CREDENTIAL: RUNTIME_ID,
      }
      const [hrcResult, chatResult] = await Promise.all([
        runCli(
          HRC_MAIN,
          ['session', 'resolve', '--scope', HRC_SCOPE, '--lane', 'main', '--create'],
          env
        ),
        runCli(HRCCHAT_MAIN, ['summon', '--json', `clod@hrc-runtime:${CHAT_TASK}`], env),
      ])

      expect(hrcResult.exitCode).not.toBe(0)
      expect(hrcResult.stderr).toContain('pinned to lab-test')
      expect(chatResult.exitCode).not.toBe(0)
      expect(chatResult.stderr).toContain('pinned to lab-test')

      const ledger = createPlacementLedgerRepository(server.db.sqlite)
      expect(ledger.get(HRC_SCOPE)).toBeUndefined()
      expect(ledger.get(CHAT_SCOPE)).toBeUndefined()

      const direct = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${DIRECT_SCOPE}/lane:main`,
        create: true,
        birthCredential: RUNTIME_ID,
      })
      expect(direct.status).toBe(200)
      expect(ledger.activeAuthority(DIRECT_SCOPE)).toMatchObject({
        homeNodeId: 'svc-test',
        birthClass: 'mechanism-born',
        authorityProvenance: {
          kind: 'child-birth',
          parentScopeRef: PARENT_SCOPE,
          parentRuntimeId: RUNTIME_ID,
          parentRunId: RUN_ID,
        },
      })
    } finally {
      await server.stop()
    }
  })
})
