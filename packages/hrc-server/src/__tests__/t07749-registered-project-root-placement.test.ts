/**
 * T-07749 — a project whose registered checkout root is NOT a sibling of the
 * daemon's cwd must still be placeable by the node-local resolver.
 *
 * The live failure: `daedalus@agents:T-07749`. `hrc summon` seated it, then
 * every kicker sweep logged `wrkq.kicker.placement_unresolvable` and the
 * envelope died `undeliverable` after five refused births — while `hrc start`
 * on the identical scope worked, because the CLI consults the wrkq registry and
 * the daemon did not.
 *
 * `agents` is the sharpest case rather than a special one: its checkout root IS
 * the agent-home root, a boundary the placement marker walk-up refuses to cross
 * by construction, so no cwd-relative search can ever reach it.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveNodeLocalPlacement } from '../federation/summon-capability.js'

describe('node-local placement honors the wrkq project registry', () => {
  let root: string
  let agentsRoot: string
  let env: Record<string, string | undefined>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't07749-'))
    agentsRoot = join(root, 'var', 'agents')
    const agentRoot = join(agentsRoot, 'probe')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(
      join(agentRoot, 'agent-profile.toml'),
      ['version = 3', '', '[identity]', '[provisioning]', 'harness = "codex"', ''].join('\n')
    )
    env = { HOME: root, ASP_AGENTS_ROOT: agentsRoot }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('a registered root the cwd walk-up cannot reach resolves to a placement', () => {
    const resolution = resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      registryProjects: [{ slug: 'agents', path: 'agents', root: agentsRoot }],
    })

    expect(resolution.unresolvableProjectPath).toBeUndefined()
    expect(resolution.placement?.projectRoot).toBe(agentsRoot)
    // A project-bearing scope launches AT the checkout root, never at the
    // discovery cwd — otherwise provider session storage splits from the
    // project-scoped lineage.
    expect(resolution.placement?.cwd).toBe(agentsRoot)
    expect(resolution.placement?.agentRoot).toBe(join(agentsRoot, 'probe'))
  })

  test('an empty registry still reports the unresolvable path, not a bogus root', () => {
    const resolution = resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      registryProjects: [],
    })

    expect(resolution.placement).toBeUndefined()
    expect(resolution.unresolvableProjectPath).toBe(join(root, 'agents'))
  })

  test('a root registered on another node is absent here, not launched into', () => {
    const resolution = resolveNodeLocalPlacement('agent:probe:project:agents:task:T-07749', {
      env,
      cwd: root,
      registryProjects: [{ slug: 'agents', root: join(root, 'no', 'such', 'checkout') }],
    })

    expect(resolution.placement).toBeUndefined()
    expect(resolution.unresolvableProjectPath).toBe(join(root, 'agents'))
  })

  test('a sibling checkout still resolves without the registry', async () => {
    const projectRoot = join(root, 'sibling-project')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\n')

    const resolution = resolveNodeLocalPlacement(
      'agent:probe:project:sibling-project:task:T-07749',
      { env, cwd: root, registryProjects: [] }
    )

    expect(resolution.placement?.projectRoot).toBe(projectRoot)
  })
})
