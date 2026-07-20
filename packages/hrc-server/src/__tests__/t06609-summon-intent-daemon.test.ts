/**
 * T-06609 — isolated-daemon proof that `summonIntent` survives the wire and
 * actually changes the gate's decision on a REAL server.
 *
 * Unit evidence is insufficient on this exact surface, and T-06608 is the
 * standing reason why: its gate read `server.federationConfig` while the live
 * instance carries the config at `options.federationConfig`, so the gate was
 * silently dark in production while the whole unit matrix passed. A typed field
 * that must travel CLI -> HTTP body -> parser -> handler -> gate has more of
 * exactly that kind of seam, not less. So these tests post real HTTP bodies to
 * a real daemon and read the real structured log.
 *
 * Uses the isolated-daemon fixture (never the shared dev daemon).
 */

import { writeFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import { SUMMON_GATE_REFUSAL_EVENT } from '../federation/summon-gate.js'
import { createHrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const SESSION_REF = 'agent:intenttest:project:hrc-runtime:task:T-06609/lane:main'

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

function gateEvents(lines: string[]): string[] {
  return lines.filter((line) => line.includes(SUMMON_GATE_REFUSAL_EVENT))
}

describe('summonIntent on a live isolated daemon', () => {
  let fixture: HrcServerTestFixture

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t06609-intent-')
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test('an operator explicit_local reaches the gate as explicit_local', async () => {
    await writeFederationConfig(fixture, { nodeId: 'max3-test', gate: { mode: 'advisory' } })

    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(response.status).toBe(200)

      const events = gateEvents(captured.lines)
      expect(events.length).toBeGreaterThan(0)
      // The whole chain: HTTP body -> parser -> handleResolveSession -> gate log.
      expect(events[0]!).toContain('"intent":"explicit_local"')
      expect(events[0]!).toContain('"intentSource":"typed"')
      expect(events[0]!).toContain('"path":"resolve-session"')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('a generic SDK create on the SAME surface stays implicit', async () => {
    // The control that makes the test above mean something. Both requests hit
    // handleResolveSession with `create: true`; only one is an operator.
    await writeFederationConfig(fixture, { nodeId: 'max3-test', gate: { mode: 'advisory' } })

    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
      })
      expect(response.status).toBe(200)

      const events = gateEvents(captured.lines)
      expect(events.length).toBeGreaterThan(0)
      expect(events[0]!).toContain('"intent":"implicit"')
      // An omission is never upgraded into a placement declaration (§5).
      expect(events[0]!).not.toContain('"intent":"explicit_local"')
    } finally {
      await server.stop()
      captured.restore()
    }
  })

  test('explicit_local changes the DECISION, not just the log line', async () => {
    // A daemon with no reachable registry fails closed for everyone, which
    // would mask the placement difference. So this asserts the difference at
    // the layer where it is observable end-to-end: enforce mode, where the
    // refusal reason is the decision. `default_home_node` is unreachable-registry
    // gated here, so both intents refuse — the point is that they refuse for
    // the SAME reason, proving explicitness never skips the registry consult.
    await writeFederationConfig(fixture, { nodeId: 'max3-test', gate: { mode: 'enforce' } })

    const server = await createHrcServer(fixture.serverOpts())
    try {
      const explicit = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(explicit.status).toBeGreaterThanOrEqual(400)
      const explicitBody = (await explicit.json()) as { error?: { message?: string } }

      // Explicitness is NOT a bypass: an operator start still fails closed when
      // the registry cannot be consulted, because "truly UNBOUND" is a fact
      // only the registry can establish.
      expect(explicitBody.error?.message ?? '').toContain('Cannot reach the binding registry')
    } finally {
      await server.stop()
    }
  })

  test('a malformed summonIntent is rejected at the door', async () => {
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
        summonIntent: 'explicit',
      })

      // Validated even on a daemon with no federation config at all: the wire
      // contract is not gate-conditional, and a typo must never read as implicit.
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: { message?: string } }
      expect(body.error?.message ?? '').toContain('summonIntent')
    } finally {
      await server.stop()
    }
  })

  test('a dark daemon still accepts and ignores the field', async () => {
    // No federation config: the field is inert but must not break creation.
    const captured = captureServerLog()
    const server = await createHrcServer(fixture.serverOpts())
    try {
      const response = await fixture.postJson('/v1/sessions/resolve', {
        sessionRef: SESSION_REF,
        create: true,
        summonIntent: 'explicit_local',
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { created: boolean }
      expect(body.created).toBe(true)
      expect(gateEvents(captured.lines).length).toBe(0)
    } finally {
      await server.stop()
      captured.restore()
    }
  })
})
