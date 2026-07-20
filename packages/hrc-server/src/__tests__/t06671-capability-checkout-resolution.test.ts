/**
 * T-06671 — reproduce the svc launchd habitat in an isolated daemon: the
 * daemon cwd is the checkout collection root while the summoned project is a
 * sibling checkout below it.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { createSummonCapabilityObserver } from '../federation/summon-capability.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SCOPE_REF = 'agent:probe:project:agent-control-plane:task:jobruns-md'
const UNRESOLVABLE_SCOPE = 'agent:probe:project:unresolvable-project:task:T-06671'
const PINNED_SCOPE = 'agent:cody:project:archagent:task:ae-verify-only'

describe('capability checkout resolution in a launchd-style isolated daemon', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined
  let agentsRoot: string

  beforeEach(async () => {
    fixture = await createHrcTestFixture('h71-')
    agentsRoot = join(fixture.tmpDir, 'var', 'agents')
    const agentRoot = join(agentsRoot, 'probe')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'SOUL.md'), '# Probe\n')
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      [
        'schemaVersion = 2',
        '',
        '[identity]',
        'harness = "codex"',
        '',
        '[spaces]',
        'base = []',
        '',
      ].join('\n')
    )
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'svc-test', gate: { mode: 'advisory' } }),
      { mode: 0o600 }
    )
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  async function startCapabilityDaemon(
    env: Record<string, string | undefined> = {}
  ): Promise<void> {
    server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      capabilityFor: createSummonCapabilityObserver({
        cwd: fixture.tmpDir,
        env: {
          ASP_AGENTS_ROOT: agentsRoot,
          OPENAI_API_KEY: 'present-but-never-logged',
          ...env,
        },
        userHome: join(fixture.tmpDir, 'home'),
        detectHarness: async () => ({ available: true }),
      }),
    })
  }

  function seedLocalAuthority(scopeRef: string): void {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      createPlacementLedgerRepository(db.sqlite).installActive({
        scopeRef,
        homeNodeId: 'svc-test',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'default_home_node' },
        establishmentProvenance: 'default_home_node',
        updatedAt: '2026-07-20T00:00:00.000Z',
      })
    } finally {
      db.close()
    }
  }

  async function resolveWithCapturedLogs(scopeRef: string): Promise<{
    status: number
    refusalLines: string[]
  }>
  async function resolveWithCapturedLogs(
    scopeRef: string,
    requestExtras: Record<string, unknown>
  ): Promise<{
    status: number
    refusalLines: string[]
  }>
  async function resolveWithCapturedLogs(
    scopeRef: string,
    requestExtras: Record<string, unknown> = {}
  ): Promise<{
    status: number
    refusalLines: string[]
  }> {
    const captured: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk))
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: `${scopeRef}/lane:main`,
        create: true,
        ...requestExtras,
      })
      return {
        status: response.status,
        refusalLines: captured.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT)),
      }
    } finally {
      process.stderr.write = original
    }
  }

  test('an existing sibling checkout produces no false capability refusal', async () => {
    const projectRoot = join(fixture.tmpDir, 'agent-control-plane')
    await mkdir(join(projectRoot, '.git'), { recursive: true })

    await startCapabilityDaemon()
    seedLocalAuthority(SCOPE_REF)

    const result = await resolveWithCapturedLogs(SCOPE_REF)

    expect(result.status).toBe(200)
    expect(result.refusalLines).toEqual([])
  })

  test('resolve-session forwards registered placement before the capability gate', async () => {
    const projectRoot = join(fixture.tmpDir, 'checkouts', 'agent-control-plane')
    await mkdir(join(projectRoot, '.git'), { recursive: true })

    await startCapabilityDaemon()
    seedLocalAuthority(SCOPE_REF)

    const result = await resolveWithCapturedLogs(SCOPE_REF, {
      summonIntent: 'explicit_local',
      runtimeIntent: {
        placement: {
          agentRoot: join(agentsRoot, 'probe'),
          projectRoot,
          cwd: projectRoot,
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'probe', projectRoot },
        },
        harness: { provider: 'openai', interactive: true, id: 'codex-cli' },
        execution: { preferredMode: 'interactive' },
      },
    })

    expect(result.status).toBe(200)
    expect(result.refusalLines).toEqual([])
  })

  test('an explicit but uncloned checkout refuses with its real path', async () => {
    const missingProjectRoot = join(fixture.tmpDir, 'missing-project')

    await startCapabilityDaemon({ ASP_PROJECT_ROOT_OVERRIDE: missingProjectRoot })
    seedLocalAuthority(SCOPE_REF)

    const result = await resolveWithCapturedLogs(SCOPE_REF)

    expect(result.status).toBe(200)
    expect(result.refusalLines).toHaveLength(1)
    expect(result.refusalLines[0]).toContain('"reason":"capability-project-checkout-missing"')
    expect(result.refusalLines[0]).toContain(`project checkout absent at ${missingProjectRoot}`)
  })

  test('an unresolved root emits its distinct reason instead of checkout-missing', async () => {
    await startCapabilityDaemon()
    seedLocalAuthority(UNRESOLVABLE_SCOPE)

    const result = await resolveWithCapturedLogs(UNRESOLVABLE_SCOPE)

    expect(result.status).toBe(200)
    expect(result.refusalLines).toHaveLength(1)
    expect(result.refusalLines[0]).toContain('"reason":"capability-project-root-unresolvable"')
    expect(result.refusalLines[0]).toContain(join(fixture.tmpDir, 'unresolvable-project'))
    expect(result.refusalLines[0]).not.toContain('checkout absent')
  })

  test('the live pin-mismatch control still refuses before capability observation', async () => {
    let capabilityCalls = 0
    server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: {
        consult: async () => ({ outcome: 'unbound' as const }),
        establish: async () => {
          throw new Error('not used')
        },
      },
      policyFor: async () => ({
        placement: { pins: { 'archagent:ae-verify-only': 'lab' } },
        claimsTask: false,
      }),
      capabilityFor: async () => {
        capabilityCalls += 1
        return { outcome: 'capable' as const }
      },
    })

    const result = await resolveWithCapturedLogs(PINNED_SCOPE)

    expect(result.status).toBe(200)
    expect(result.refusalLines).toHaveLength(1)
    expect(result.refusalLines[0]).toContain('"reason":"pin-mismatch"')
    expect(result.refusalLines[0]).toContain('"homeNodeId":"lab"')
    expect(capabilityCalls).toBe(0)
  })
})
