/**
 * T-06608 — isolated-daemon proof that the summon gate is wired into real
 * session creation, that advisory mode changes NO behavior, and that an
 * unconfigured daemon stays fully dark.
 *
 * Uses the isolated-daemon fixture (never the shared dev daemon): these tests
 * start and stop real servers against a temp state root.
 */

import { writeFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SESSION_REF = 'agent:gatetest:project:hrc-runtime:task:T-06608/lane:main'
const SCOPE_REF = 'agent:gatetest:project:hrc-runtime:task:T-06608'

/** Captures daemon stderr so the structured advisory events can be asserted. */
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

async function writeFederationConfig(
  fixture: HrcServerTestFixture,
  document: Record<string, unknown>
): Promise<void> {
  await writeFile(`${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`, JSON.stringify(document), {
    mode: 0o600,
  })
}

describe('summon gate on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06608-gate-')
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('no federation config: session creation is completely dark', async () => {
    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { created: boolean; hostSessionId: string | null }
      expect(body.created).toBe(true)
      expect(body.hostSessionId).not.toBeNull()

      // Dark means dark: not one gate event on an unconfigured daemon.
      expect(captured.lines.join('').includes(SUMMON_GATE_REFUSAL_EVENT)).toBe(false)
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('advisory mode: logs the would-be refusal and creates the session anyway', async () => {
    await writeFederationConfig(fixture, {
      nodeId: 'max3-test',
      gate: { mode: 'advisory' },
    })

    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })

      // BEHAVIOR IS UNCHANGED. This is the whole point of the advisory soak.
      expect(response.status).toBe(200)
      const body = (await response.json()) as { created: boolean; hostSessionId: string | null }
      expect(body.created).toBe(true)
      expect(body.hostSessionId).not.toBeNull()

      const gateLines = captured.lines.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
      expect(gateLines.length).toBeGreaterThan(0)

      const payload = gateLines[0]!
      // The soak data T-06615 collects: path, scope, reason, would-be decision.
      expect(payload).toContain('"path":"resolve-session"')
      expect(payload).toContain(`"scopeRef":"${SCOPE_REF}"`)
      expect(payload).toContain('"wouldBeDecision":"refuse"')
      expect(payload).toContain('"enforced":false')
      expect(payload).toContain('"mode":"advisory"')
      // T-06609: intent is now the caller's typed field, not a derived guess.
      // This request omitted `summonIntent`, so it reads as implicit.
      expect(payload).toContain('"intent":"implicit"')
      expect(payload).toContain('"intentSource":"typed"')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('gate mode off with federation configured stays dark', async () => {
    await writeFederationConfig(fixture, { nodeId: 'max3-test' })

    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })
      expect(response.status).toBe(200)
      expect(captured.lines.join('').includes(SUMMON_GATE_REFUSAL_EVENT)).toBe(false)
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('the gate survives a daemon restart and re-evaluates on the successor path', async () => {
    await writeFederationConfig(fixture, {
      nodeId: 'max3-test',
      gate: { mode: 'advisory' },
    })

    const first = await createHrcServer(fixture.serverOpts())
    await fixture.postJson('/v1/sessions/resolve', { sessionRef: SESSION_REF, create: true })
    await first.stop()

    const captured = captureServerLog()
    const second = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })
      expect(response.status).toBe(200)
      // Existing session: resolve returns it without re-summoning, so no new
      // gate refusal is emitted for an already-created session.
      const body = (await response.json()) as { created: boolean }
      expect(body.created).toBe(false)
    } finally {
      await second.stop()
      captured.restore()
    }
  })

  test('enforce mode refuses the same creation the advisory run allowed', async () => {
    await writeFederationConfig(fixture, {
      nodeId: 'max3-test',
      gate: { mode: 'enforce' },
    })

    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })

      // Same decision as advisory; only the enforcement differs.
      expect(response.status).toBeGreaterThanOrEqual(400)
      const body = (await response.json()) as { error?: { message?: string } }
      const message = body.error?.message ?? ''

      // Until the consult transport lands (T-06663) the registry is unreachable
      // on this node, so a virgin scope fails CLOSED here — before placement
      // policy is ever consulted. That ordering is the point: the gate refuses
      // rather than establishing a binding against a registry it cannot reach.
      // The stanza-naming undeclared-placement refusal is proven in the unit
      // matrix, where the registry is stubbed as reachable-and-unbound.
      expect(message).toContain('Cannot reach the binding registry')
      expect(message).toContain('second authority')
      expect(message.toLowerCase()).toContain('retry')
    } finally {
      await server.stop()
    }
  })
})
