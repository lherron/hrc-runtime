/**
 * Real isolated-daemon smoke for T-06612: an hrcchat summon carrying a missing
 * project checkout logs the named advisory refusal and still creates normally.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { type HrcServer, createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const HRCCHAT_MAIN = join(REPO_ROOT, 'packages', 'hrcchat-cli', 'src', 'main.ts')
const SCOPE_REF = 'agent:probe:project:fixture-project:task:T-06612'

function captureServerLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  return {
    lines,
    restore: () => {
      process.stderr.write = original
    },
  }
}

describe('materialization capability on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06612-capability-daemon-')
  })

  afterEach(async () => {
    await server?.stop()
    await fixture.cleanup()
  })

  test('hrcchat summon with missing checkout logs a named advisory refusal and still creates', async () => {
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'max3-test', gate: { mode: 'advisory' } }),
      { mode: 0o600 }
    )

    const agentsRoot = join(fixture.tmpDir, 'agents')
    const agentRoot = join(agentsRoot, 'probe')
    const missingProjectRoot = join(fixture.tmpDir, 'checkouts', 'fixture-project')
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
        '[placement]',
        'default_home_node = "local"',
        '',
      ].join('\n')
    )

    const captured = captureServerLog()
    try {
      server = await createHrcServer(fixture.serverOpts())

      // Established local authority puts the live request on the exact seam
      // under test: authority allows, then node capability observes the hint.
      const db = openHrcDatabase(fixture.dbPath)
      try {
        createPlacementLedgerRepository(db.sqlite).installActive({
          scopeRef: SCOPE_REF,
          homeNodeId: 'max3-test',
          placementEpoch: 1,
          birthClass: 'policy-born',
          authorityProvenance: { kind: 'policy', source: 'default_home_node' },
          establishmentProvenance: 'default_home_node',
          updatedAt: '2026-07-20T00:00:00.000Z',
        })
      } finally {
        db.close()
      }

      const proc = Bun.spawn({
        cmd: ['bun', HRCCHAT_MAIN, 'dm', '--json', 'probe@fixture-project:T-06612', '-'],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          ASP_AGENTS_ROOT: agentsRoot,
          ASP_PROJECT: 'fixture-project',
          ASP_PROJECT_ROOT_OVERRIDE: missingProjectRoot,
          HRC_RUNTIME_DIR: fixture.runtimeRoot,
          HRC_STATE_DIR: fixture.stateRoot,
        },
      })
      proc.stdin.write('advisory capability smoke\n')
      proc.stdin.end()
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      // The later runtime start may fail because the project is genuinely
      // absent (or because of an unrelated substrate baseline). Advisory's
      // contract is that the gate itself did not prevent session creation.
      expect(stderr).toBe('')
      expect([0, 4]).toContain(exitCode)
      expect(() => JSON.parse(stdout)).not.toThrow()

      // Advisory means behavior is unchanged: the target session exists.
      const state = openHrcDatabase(fixture.dbPath)
      try {
        expect(state.sessions.listByScopeRef(SCOPE_REF)).toHaveLength(1)
      } finally {
        state.close()
      }

      const line = captured.lines.find((entry) => entry.includes(SUMMON_GATE_REFUSAL_EVENT))
      expect(line).toBeDefined()
      expect(line).toContain('"reason":"capability-project-checkout-missing"')
      expect(line).toContain('"capability":"project-checkout"')
      expect(line).toContain('"capability_source":"presence-heuristic"')
      expect(line).toContain(`project checkout absent at ${missingProjectRoot}`)
      expect(line).toContain('"enforced":false')
    } finally {
      captured.restore()
    }
  })
})
