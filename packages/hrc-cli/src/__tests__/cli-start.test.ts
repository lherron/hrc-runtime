/**
 * RED/GREEN tests for hrc-cli (T-00957)
 *
 * These tests validate the CLI arg parsing, command dispatch, and output
 * formatting for the `hrc` operator CLI. The CLI is a thin wrapper over
 * hrc-sdk; these tests verify the wrapper layer specifically.
 *
 * Pass conditions for Curly (T-00957):
 *   1. `hrc` with no args prints help text to stderr and exits 2
 *   2. `hrc unknowncmd` prints error to stderr and exits 2
 *   3. `hrc session rotate` validates args and dispatches through
 *      hrc-sdk; `hrc turn` is a passthrough alias for `hrcchat turn`
 *      to stderr and exit 2
 *   4. `hrc server` starts the daemon (tested via createHrcServer delegation)
 *   5. `hrc session resolve --scope <scopeRef>` outputs JSON to stdout
 *   6. `hrc session list` outputs JSON array to stdout
 *   7. `hrc session get <hostSessionId>` outputs JSON to stdout
 *   8. monitor commands expose snapshots and event streams
 *   9. All structured output is valid JSON on stdout; all errors on stderr
 *  10. Exit code 0 on success, 1 on error
 *
 * Reference: T-00946 (parent), T-00957 (CLI implementation task)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  agentsRoot,
  cliEnv,
  createTmuxAttachShim,
  dbPath,
  installFakeCodex,
  projectsRoot,
  runCli,
  seedRunRoots,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  waitForContinuation,
  writeCodexAgentProfile,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('hrc start', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
    await seedRunRoots('rex', 'agent-spaces')
  })

  it('prints a local plan preview for detached startup without mutating server state', async () => {
    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_DEFAULT_TASK: 'primary',
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain('hrc start rex@agent-spaces --dry-run')
    expect(result.stdout).toContain(
      'sessionRef:   agent:rex:project:agent-spaces:task:primary/lane:main'
    )
    expect(result.stdout).toContain('restartStyle: reuse_pty')

    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const sessions = db.sessions.listByScopeRef('agent:rex:project:agent-spaces:task:primary')
      expect(sessions.length).toBe(0)
    } finally {
      db.close()
    }
  })

  it('previews an explicit execution cwd while preserving the resolved project root', async () => {
    const projectRoot = join(projectsRoot, 'agent-spaces')
    const executionCwd = join(projectsRoot, 'target-checkout')
    await mkdir(executionCwd, { recursive: true })

    const result = await runCli(
      ['start', 'rex@agent-spaces', '--cwd', executionCwd, '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_DEFAULT_TASK: 'primary',
        ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`projectRoot:  ${projectRoot}`)
    expect(result.stdout).toContain(`cwd:          ${executionCwd}`)
  })

  it('threads --cwd through continuation-resume preview without changing project root', async () => {
    const projectRoot = join(projectsRoot, 'agent-spaces')
    const executionCwd = join(projectsRoot, 'resume-checkout')
    await mkdir(executionCwd, { recursive: true })

    const result = await runCli(
      ['resume', 'rex@agent-spaces', '--no-attach', '--cwd', executionCwd, '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_DEFAULT_TASK: 'primary',
        ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`projectRoot:  ${projectRoot}`)
    expect(result.stdout).toContain(`cwd:          ${executionCwd}`)
  })

  it('rejects relative and missing execution cwd paths', async () => {
    const env = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
    })
    const relative = await runCli(
      ['start', 'rex@agent-spaces', '--cwd', 'relative/path', '--dry-run'],
      env
    )
    const missingPath = join(projectsRoot, 'does-not-exist')
    const missing = await runCli(
      ['resume', 'rex@agent-spaces', '--cwd', missingPath, '--dry-run'],
      env
    )

    expect(relative.exitCode).not.toBe(0)
    expect(relative.stderr).toContain('--cwd must be an absolute path')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stderr).toContain('--cwd does not exist or is not a directory')
  })

  /**
   * T-07302 — `--on-conflict` is registered in THREE places (Commander choices,
   * the unknown-option guard's value list, and the handler's own validation).
   * A value accepted by only two of them fails at a different layer each time,
   * so this drives the whole chain rather than any one registry.
   */
  it('accepts --on-conflict reject through every flag registry', async () => {
    const result = await runCli(
      ['start', 'rex@agent-spaces', '--on-conflict', 'reject', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_DEFAULT_TASK: 'primary',
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain(
      'sessionRef:   agent:rex:project:agent-spaces:task:primary/lane:main'
    )
    // The reject policy value is consumed as a flag value, never as a prompt.
    expect(result.stdout).not.toContain('prompt:       reject')
  })

  it('refuses an --on-conflict policy that is neither suffix nor reject', async () => {
    const result = await runCli(
      ['start', 'rex@agent-spaces', '--on-conflict', 'clobber', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_DEFAULT_TASK: 'primary',
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stderr}${result.stdout}`).toMatch(/suffix|reject/)
  })

  it('resolves project-local agent roots before the canonical agents root', async () => {
    const projectRoot = join(projectsRoot, 'agent-spaces')
    const localAgentsRoot = join(projectRoot, 'agents')
    const localAgentRoot = join(localAgentsRoot, 'rex')
    await mkdir(localAgentRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )
    await writeFile(join(localAgentRoot, 'agent-profile.toml'), 'version = 3\n', 'utf8')

    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`agentRoot:    ${localAgentRoot}`)
    expect(result.stdout).not.toContain(`agentRoot:    ${join(agentsRoot, 'rex')}`)
  })

  it('reports every searched project-local and canonical agent root when an agent is missing', async () => {
    const projectRoot = join(projectsRoot, 'agent-spaces')
    const localAgentsRoot = join(projectRoot, 'agents')
    await mkdir(localAgentsRoot, { recursive: true })
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "agents"\n',
      'utf8'
    )

    const result = await runCli(
      ['start', 'missing@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
      })
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(
      `agent "missing" not found; searched: ${join(localAgentsRoot, 'missing')}, ${join(agentsRoot, 'missing')}`
    )
  })

  it('prints resolver warnings for declared project-local roots that are missing', async () => {
    const projectRoot = join(projectsRoot, 'agent-spaces')
    const missingLocalAgentsRoot = join(projectRoot, 'missing-agents')
    await writeFile(
      join(projectRoot, 'asp-targets.toml'),
      'schema = 1\nagents-root = "missing-agents"\n',
      'utf8'
    )

    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(
      `[hrc] warning: Declared project agents root does not exist: ${missingLocalAgentsRoot}`
    )
    expect(result.stdout).toContain(`agentRoot:    ${join(agentsRoot, 'rex')}`)
  })

  // SKIP: exercises the headless CLI start path, which hrc-server deliberately
  // retired in the broker cutover. The server now hard-fails this route with
  // "headless CLI start path retired for broker cutover ... provision via the
  // first broker dispatch turn instead" (the startRuntimeForSession guard). Making this
  // green requires resurrecting retired hrc-server behavior; out of scope for
  // an hrc-cli-only change. Env/cross-package coupled, skipped per fully-green
  // directive.
  it.skip('creates a session and runtime without attaching', async () => {
    const tmuxShimDir = await createTmuxAttachShim()
    const result = await runCli(
      ['start', 'rex@agent-spaces:T-00123'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
        PATH: `${tmuxShimDir}:${process.env.PATH ?? ''}`,
      })
    )

    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout.trim())
    expect(body.sessionRef).toBe('agent:rex:project:agent-spaces:task:T-00123/lane:main')
    expect(body.hostSessionId).toBeDefined()
    expect(body.created).toBe(true)
    expect(body.runtime.runtimeId).toBeDefined()
    // Anthropic start with preferredMode=headless now creates a headless SDK runtime
    expect(body.runtime.transport).toBe('headless')
    expect(existsSync(join(tmuxShimDir, 'tmux-attach.json'))).toBe(false)
  })

  it('uses detached codex app-server for start previews when the agent harness is codex', async () => {
    await writeCodexAgentProfile('rex')

    const result = await runCli(
      ['start', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('provider:     openai')
    expect(result.stdout).toContain('── command ──')
    expect(result.stdout).toContain('--enable goals app-server')
    expect(result.stdout).not.toContain('--json')
  })

  // SKIP: same retired headless CLI start path as above (startRuntimeForSession
  // hard-fails it post broker cutover). Requires hrc-server changes to revive the
  // retired route; not fixable from hrc-cli. Cross-package coupled, skipped per
  // fully-green directive.
  it.skip('rotates to a fresh headless session when start uses --new-session', async () => {
    await writeCodexAgentProfile('rex')

    const firstCodex = await installFakeCodex('fake-codex-start-new-session-1', {
      execThreadId: 'thread-111',
    })
    process.env.PATH = `${firstCodex.binDir}:${process.env.PATH ?? ''}`
    const firstEnv = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      PATH: `${firstCodex.binDir}:${process.env.PATH ?? ''}`,
    })
    const firstStart = await runCli(
      ['start', 'rex@agent-spaces', '-p', 'seed first session'],
      firstEnv
    )
    expect(firstStart.exitCode).toBe(0)
    const firstBody = JSON.parse(firstStart.stdout.trim()) as {
      hostSessionId: string
      created: boolean
      runtime: { runtimeId: string; transport: string }
    }
    expect(firstBody.created).toBe(true)
    expect(firstBody.runtime.transport).toBe('headless')
    await waitForContinuation(firstBody.hostSessionId, firstBody.runtime.runtimeId, firstEnv)

    const secondCodex = await installFakeCodex('fake-codex-start-new-session-2', {
      execThreadId: 'thread-222',
    })
    process.env.PATH = `${secondCodex.binDir}:${process.env.PATH ?? ''}`
    const secondEnv = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      PATH: `${secondCodex.binDir}:${process.env.PATH ?? ''}`,
    })
    const secondStart = await runCli(
      ['start', 'rex@agent-spaces', '--new-session', '-p', 'seed second session'],
      secondEnv
    )
    expect(secondStart.exitCode).toBe(0)
    const secondBody = JSON.parse(secondStart.stdout.trim()) as {
      hostSessionId: string
      created: boolean
      runtime: { runtimeId: string; transport: string }
    }
    expect(secondBody.created).toBe(true)
    expect(secondBody.hostSessionId).not.toBe(firstBody.hostSessionId)
    expect(secondBody.runtime.transport).toBe('headless')
    await waitForContinuation(secondBody.hostSessionId, secondBody.runtime.runtimeId, secondEnv)

    const db = openHrcDatabase(dbPath)
    try {
      const firstSession = db.sessions.getByHostSessionId(firstBody.hostSessionId)
      const secondSession = db.sessions.getByHostSessionId(secondBody.hostSessionId)
      expect(firstSession?.status).toBe('archived')
      expect(firstSession?.continuation).toEqual({
        provider: 'openai',
        key: 'thread-111',
      })
      expect(secondSession?.status).toBe('active')
      expect(secondSession?.continuation).toEqual({
        provider: 'openai',
        key: 'thread-222',
      })
    } finally {
      db.close()
    }
  }, 10000)
})
