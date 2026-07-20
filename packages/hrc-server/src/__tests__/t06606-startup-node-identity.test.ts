/**
 * T-06606 — node identity through a real daemon boot.
 *
 * Pins the startup contract end to end: identity resolves from the node-local
 * config file, surfaces on the status endpoint (which every operator diagnostic
 * reads), and a malformed file refuses the boot with a named diagnostic instead
 * of coming up not knowing which node it is.
 *
 * No listener is started by any of this — F0 is identity + config only.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FEDERATION_CONFIG_BASENAME, createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

type Fixture = Awaited<ReturnType<typeof createHrcTestFixture>>

const running: { server?: HrcServer; fixture?: Fixture }[] = []

async function boot(
  configContent: unknown | string | undefined
): Promise<{ fixture: Fixture; server: HrcServer }> {
  const fixture = await createHrcTestFixture('hrc-t06606-')
  if (configContent !== undefined) {
    const raw =
      typeof configContent === 'string' ? configContent : JSON.stringify(configContent, null, 2)
    await writeFile(join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME), raw, { mode: 0o600 })
  }
  const server = await createHrcServer(fixture.serverOpts())
  const entry = { server, fixture }
  running.push(entry)
  return entry
}

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop()
    await entry?.server?.stop()
    await entry?.fixture?.cleanup()
  }
})

async function readNodeStatus(fixture: Fixture) {
  const response = await fixture.fetchSocket('/v1/status')
  expect(response.status).toBe(200)
  return (await response.json()).node
}

describe('daemon startup with no federation config', () => {
  test('boots in single-node mode with a derived nodeId on the status surface', async () => {
    const { fixture } = await boot(undefined)
    const node = await readNodeStatus(fixture)

    expect(node.mode).toBe('single-node')
    expect(node.nodeIdProvenance).toBe('derived')
    expect(node.peerCount).toBe(0)
    expect(node.peers).toEqual([])
    expect(node.configExists).toBe(false)
    expect(node.configPath).toBe(join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME))
    expect(node.nodeId).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  })
})

describe('daemon startup with a declared federation config', () => {
  test('surfaces the declared nodeId and peers, never the tokens', async () => {
    const secret = 'startup-secret-token-value'
    const { fixture } = await boot({
      nodeId: 'lab',
      peers: { svc: { endpoint: 'https://svc.example.ts.net:8443', token: secret } },
    })

    const node = await readNodeStatus(fixture)
    expect(node.nodeId).toBe('lab')
    expect(node.nodeIdProvenance).toBe('declared')
    expect(node.mode).toBe('federated')
    expect(node.configExists).toBe(true)
    expect(node.peerCount).toBe(1)
    expect(node.peers).toEqual([{ nodeId: 'svc', endpoint: 'https://svc.example.ts.net:8443/' }])

    // The whole status payload, not just the node block, is token-free.
    const full = await (await fixture.fetchSocket('/v1/status')).text()
    expect(full).not.toContain(secret)
  })

  test('the summary status surface carries the same identity', async () => {
    const { fixture } = await boot({ nodeId: 'lab' })
    const response = await fixture.fetchSocket('/v1/status?includeSessions=false')
    const body = await response.json()
    expect(body.node.nodeId).toBe('lab')
    expect(body.node.mode).toBe('single-node')
  })
})

describe('daemon startup with a malformed federation config', () => {
  test('refuses to boot and the diagnostic names the file and the problem', async () => {
    const fixture = await createHrcTestFixture('hrc-t06606-bad-')
    const configPath = join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME)
    await writeFile(configPath, '{ not json at all', { mode: 0o600 })

    let message = ''
    try {
      await createHrcServer(fixture.serverOpts())
      throw new Error('expected startup to refuse')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain(configPath)
    expect(message).toContain('is not valid JSON')

    await fixture.cleanup()
  })

  test('peers without a declared nodeId refuse the boot and name the fix', async () => {
    const fixture = await createHrcTestFixture('hrc-t06606-nofix-')
    const configPath = join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME)
    await writeFile(
      configPath,
      JSON.stringify({ peers: { svc: { endpoint: 'https://svc.example.ts.net', token: 't' } } }),
      { mode: 0o600 }
    )

    let message = ''
    try {
      await createHrcServer(fixture.serverOpts())
      throw new Error('expected startup to refuse')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('but no "nodeId"')
    expect(message).toContain('Fix: add a "nodeId" field to')

    await fixture.cleanup()
  })

  test('a refused boot leaves no socket behind for the next start', async () => {
    const fixture = await createHrcTestFixture('hrc-t06606-clean-')
    await writeFile(join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME), '{ bad', { mode: 0o600 })
    await expect(createHrcServer(fixture.serverOpts())).rejects.toThrow()

    // Fixing the config must let the daemon start; the failed attempt must not
    // have left a lock or socket that blocks recovery.
    await writeFile(
      join(fixture.stateRoot, FEDERATION_CONFIG_BASENAME),
      JSON.stringify({ nodeId: 'lab' }),
      { mode: 0o600 }
    )
    const server = await createHrcServer(fixture.serverOpts())
    const node = await readNodeStatus(fixture)
    expect(node.nodeId).toBe('lab')

    await server.stop()
    await fixture.cleanup()
  })
})
