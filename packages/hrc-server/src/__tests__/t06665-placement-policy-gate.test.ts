/**
 * T-06665 — the live summon gate must consume the same real-profile placement
 * resolver as `hrc target locate`. These are daemon-level regression guards:
 * injecting a correctly typed stub still has to fail them.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

function registryUnbound(): BindingRegistryClient {
  return {
    async consult() {
      return { outcome: 'unbound' }
    },
    async establish(request) {
      return {
        outcome: 'created',
        binding: {
          ...request,
          placementEpoch: 1,
          updatedAt: request.now,
        },
      }
    },
  }
}

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

describe('T-06665 real placement policy in the live summon gate', () => {
  let fixture: HrcServerTestFixture
  let agentsRoot: string

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06665-policy-gate-')
    agentsRoot = join(fixture.tmpDir, 'agents')
    await mkdir(agentsRoot, { recursive: true })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function writeProfile(agentId: string, profile: string): Promise<void> {
    const root = join(agentsRoot, agentId)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'agent-profile.toml'), profile, 'utf8')
  }

  async function startAdvisoryServer() {
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'max3-test', gate: { mode: 'advisory' } }),
      { mode: 0o600 }
    )
    const server = await createHrcServer(fixture.serverOpts())
    Object.assign(server, {
      registryClient: registryUnbound(),
      placementPolicyOptions: { env: { ASP_AGENTS_ROOT: agentsRoot } },
      capabilityFor: async () => ({ outcome: 'capable' as const }),
    })
    return server
  }

  async function summon(agentId: string, taskId: string): Promise<Response> {
    return fixture.postJson('/v1/sessions/resolve', {
      sessionRef: `agent:${agentId}:project:hrc-runtime:task:${taskId}/lane:main`,
      create: true,
    })
  }

  test('a declared default_home_node is read by the injected production resolver', async () => {
    await writeProfile(
      'declared',
      ['schemaVersion = 1', '', '[placement]', 'default_home_node = "max3-test"'].join('\n')
    )
    const captured = captureServerLog()
    const server = await startAdvisoryServer()
    try {
      const response = await summon('declared', 'T-DECLARED')
      expect(response.status).toBe(200)
      const gateLines = captured.lines.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
      expect(gateLines).toEqual([])
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('a matching scope pin is resolved and takes precedence over the default', async () => {
    await writeProfile(
      'pinned',
      [
        'schemaVersion = 1',
        '',
        '[placement]',
        'default_home_node = "max3-test"',
        '"hrc-runtime:T-PINNED" = "mini-test"',
      ].join('\n')
    )
    const captured = captureServerLog()
    const server = await startAdvisoryServer()
    try {
      const response = await summon('pinned', 'T-PINNED')
      expect(response.status).toBe(200)
      const event = captured.lines.find((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT)) ?? ''
      expect(event).toContain('"reason":"pin-mismatch"')
      expect(event).toContain('"homeNodeId":"mini-test"')
      expect(event).not.toContain('undeclared-placement')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('a real profile with no placement stanza remains visibly undeclared', async () => {
    await writeProfile('legacy', 'schemaVersion = 1\n')
    const captured = captureServerLog()
    const server = await startAdvisoryServer()
    try {
      const response = await summon('legacy', 'T-UNDECLARED')
      expect(response.status).toBe(200)
      const event = captured.lines.find((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT)) ?? ''
      expect(event).toContain('"reason":"undeclared-placement"')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('an unreadable profile is policy-unavailable, never undeclared', async () => {
    await writeProfile('broken', 'this is not = = valid toml [[[\n')
    const captured = captureServerLog()
    const server = await startAdvisoryServer()
    try {
      const response = await summon('broken', 'T-UNREADABLE')
      expect(response.status).toBe(200)
      const event = captured.lines.find((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT)) ?? ''
      expect(event).toContain('"reason":"policy-unavailable"')
      expect(event).toContain('agent-profile.toml')
      expect(event).not.toContain('undeclared-placement')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('missing agent-profile materialization is policy-unavailable, never undeclared', async () => {
    const captured = captureServerLog()
    const server = await startAdvisoryServer()
    try {
      const response = await summon('missing', 'T-MISSING')
      expect(response.status).toBe(200)
      const event = captured.lines.find((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT)) ?? ''
      expect(event).toContain('"reason":"policy-unavailable"')
      expect(event).toContain('No agent root found')
      expect(event).not.toContain('undeclared-placement')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('an unconfigured daemon does no placement resolution work', async () => {
    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    let policyReads = 0
    Object.assign(server, {
      policyFor: async () => {
        policyReads += 1
        throw new Error('dark daemon must not read placement')
      },
    })
    try {
      const response = await summon('dark', 'T-DARK')
      expect(response.status).toBe(200)
      expect(policyReads).toBe(0)
      expect(captured.lines.join('')).not.toContain(SUMMON_GATE_REFUSAL_EVENT)
    } finally {
      await server.stop()
      captured.restore()
    }
  })
})
