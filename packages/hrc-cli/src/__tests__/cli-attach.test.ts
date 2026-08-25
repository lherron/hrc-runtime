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
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'
// RED GATE: cli.ts must exist as the bin entry point
// This import will fail until Curly implements the CLI module
import { createHrcServer } from 'hrc-server'
import { attachWithRetry, selectLatestUsableRuntime } from '../cli'

import {
  agentsRoot,
  cliEnv,
  createTmuxAttachShim,
  dbPath,
  installFakeClaude,
  installFakeCodex,
  projectsRoot,
  runCli,
  runtimeRoot,
  seedRunRoots,
  serverOpts,
  setServer,
  setupCliFixture,
  teardownCliFixture,
  writeCodexAgentProfile,
} from './fixtures/cli.fixture'

beforeEach(setupCliFixture)
afterEach(teardownCliFixture)

describe('hrc attach <scope>', () => {
  beforeEach(async () => {
    setServer(await createHrcServer(serverOpts()))
    await seedRunRoots('rex', 'agent-spaces')
  })

  async function waitForContinuation(
    hostSessionId: string,
    runtimeId: string,
    env: Record<string, string>
  ) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listResult = await runCli(['runtime', 'list', '--host-session-id', hostSessionId], env)
      expect(listResult.exitCode).toBe(0)
      const runtimes = JSON.parse(listResult.stdout.trim()) as Array<{
        runtimeId: string
        continuation?: { key?: string | undefined } | null
      }>
      const runtime = runtimes.find((candidate) => candidate.runtimeId === runtimeId)
      if (runtime?.continuation?.key) {
        return
      }
      await Bun.sleep(100)
    }

    throw new Error(`runtime ${runtimeId} did not persist a continuation in time`)
  }

  it('prints a local runtime lookup plan without mutating server state', async () => {
    const result = await runCli(
      ['attach', 'rex@agent-spaces', '--dry-run'],
      cliEnv({
        ASP_AGENTS_ROOT: agentsRoot,
        ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('local plan preview')
    expect(result.stdout).toContain('runtimeLookup: latest non-unavailable runtime')
    expect(result.stdout).toContain(
      'recovery:      detached OpenAI sessions materialize a fresh tmux runtime on attach'
    )
    expect(result.stdout).toContain('POST /v1/runtimes/attach')

    const db = (await import('hrc-store-sqlite')).openHrcDatabase(dbPath)
    try {
      const sessions = db.sessions.listByScopeRef('agent:rex:project:agent-spaces:task:primary')
      expect(sessions.length).toBe(0)
    } finally {
      db.close()
    }
  })

  // SKIP: drives `hrc start` (headless) first, which hrc-server retired in the
  // broker cutover (startRuntimeForSession hard-fails it). The start step exits 1
  // before attach can be exercised. Requires hrc-server changes; cross-package
  // coupled, skipped per fully-green directive.
  it.skip('headless anthropic start creates resumable runtime that attach can rematerialize', async () => {
    const fakeClaude = await installFakeClaude('fake-claude-cli-attach', {
      interactiveDelayMs: 200,
    })
    process.env.ASP_CLAUDE_PATH = join(fakeClaude.binDir, 'claude')
    const tmuxShimDir = await createTmuxAttachShim()
    const env = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      PATH: `${tmuxShimDir}:${fakeClaude.binDir}:${process.env.PATH ?? ''}`,
    })

    const startResult = await runCli(['start', 'rex@agent-spaces:T-00123'], env)
    expect(startResult.exitCode).toBe(0)
    const startBody = JSON.parse(startResult.stdout.trim())
    expect(startBody.runtime.transport).toBe('headless')

    // Anthropic headless start creates a resumable runtime with continuation;
    // attach should find it and rematerialize to tmux
    const attachResult = await runCli(['attach', 'rex@agent-spaces:T-00123'], env)
    expect(attachResult.exitCode).toBe(0)
  })

  // SKIP: drives `hrc start` (headless) first, which hrc-server retired in the
  // broker cutover (startRuntimeForSession hard-fails it). The start step exits 1
  // before the codex attach/resume can be exercised. Requires hrc-server
  // changes; cross-package coupled, skipped per fully-green directive.
  it.skip('materializes tmux and resumes codex when only a detached session exists', async () => {
    await writeCodexAgentProfile('rex')
    const fakeCodex = await installFakeCodex('fake-codex-cli-attach-recovery')
    process.env.PATH = `${fakeCodex.binDir}:${process.env.PATH ?? ''}`

    const tmuxShimDir = await createTmuxAttachShim()
    const env = cliEnv({
      ASP_AGENTS_ROOT: agentsRoot,
      ASP_PROJECT_ROOT_OVERRIDE: join(projectsRoot, 'agent-spaces'),
      PATH: `${tmuxShimDir}:${process.env.PATH ?? ''}`,
    })

    const startResult = await runCli(['start', 'rex@agent-spaces:T-00123'], env)
    expect(startResult.exitCode).toBe(0)

    const started = JSON.parse(startResult.stdout.trim()) as {
      hostSessionId: string
      runtime: { runtimeId: string; transport: string }
    }
    expect(started.runtime.transport).toBe('headless')
    await waitForContinuation(started.hostSessionId, started.runtime.runtimeId, env)

    const attachResult = await runCli(['attach', 'rex@agent-spaces:T-00123'], env)
    expect(attachResult.exitCode).toBe(0)
    expect(attachResult.stdout.trim()).toBe('')
    expect(attachResult.stderr.trim()).toBe('')

    let attachArtifact:
      | {
          argv?: string[]
          lifecycleAction?: string
        }
      | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const launchFiles = await readdir(join(runtimeRoot, 'launches'))
        for (const file of launchFiles) {
          const parsed = JSON.parse(await Bun.file(join(runtimeRoot, 'launches', file)).text()) as {
            argv?: string[]
            lifecycleAction?: string
          }
          if (parsed.lifecycleAction === 'attach') {
            attachArtifact = parsed
            break
          }
        }
      } catch {
        attachArtifact = undefined
      }
      if (attachArtifact?.lifecycleAction === 'attach') {
        break
      }
      await Bun.sleep(100)
    }
    expect(attachArtifact?.lifecycleAction).toBe('attach')
    expect(attachArtifact?.argv?.[0]?.split('/').pop()).toBe('codex')
    expect(attachArtifact?.argv).toContain('resume')
    expect(attachArtifact?.argv).toContain('thread-123')

    const loggedArgs = await Bun.file(join(tmuxShimDir, 'tmux-attach.json')).text()
    expect(loggedArgs).toContain('attach-session')
  }, 15_000)

  it('prefers a detached headless runtime over a newer idle tmux runtime', () => {
    const hostSessionId = 'hsid-test-attach-priority'
    const runtimes: HrcRuntimeSnapshot[] = [
      {
        runtimeId: 'rt-headless',
        hostSessionId,
        scopeRef: 'agent:rex:project:agent-spaces:task:T-00999',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        continuation: {
          provider: 'openai',
          key: 'thread-123',
        },
        supportsInflightInput: false,
        adopted: false,
        createdAt: '2026-04-15T21:25:32.416Z',
        updatedAt: '2026-04-15T21:25:32.416Z',
      },
      {
        runtimeId: 'rt-idle-tmux',
        hostSessionId,
        scopeRef: 'agent:rex:project:agent-spaces:task:T-00999',
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        tmuxJson: {
          sessionId: '$12',
          windowId: '@12',
          paneId: '%12',
        },
        supportsInflightInput: false,
        adopted: false,
        createdAt: '2026-04-15T21:27:16.883Z',
        updatedAt: '2026-04-15T21:27:16.883Z',
      },
    ]

    expect(selectLatestUsableRuntime(runtimes)?.runtimeId).toBe('rt-headless')
  })

  it('retries attach with a refreshed headless runtime when the initial tmux runtime is stale', async () => {
    const initialRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-dead-tmux',
      hostSessionId: 'hsid-test-attach-retry',
      scopeRef: 'agent:rex:project:agent-spaces:task:T-01000',
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      tmuxJson: {
        sessionId: '$14',
        windowId: '@14',
        paneId: '%14',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
    }
    const fallbackRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-headless-fallback',
      hostSessionId: initialRuntime.hostSessionId,
      scopeRef: initialRuntime.scopeRef,
      laneRef: initialRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      continuation: {
        provider: 'openai',
        key: 'thread-123',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:00:01.000Z',
      updatedAt: '2026-04-16T00:00:01.000Z',
    }

    let listCalls = 0
    const client = {
      async attachRuntime({ runtimeId }: { runtimeId: string }) {
        if (runtimeId === initialRuntime.runtimeId) {
          throw new HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE, 'runtime is dead')
        }
        expect(runtimeId).toBe(fallbackRuntime.runtimeId)
        return {
          kind: 'exec',
          argv: ['tmux', 'attach-session', '-t', '$15'],
          bindingFence: {
            hostSessionId: initialRuntime.hostSessionId,
            runtimeId,
            generation: 1,
          },
        }
      },
      async listRuntimes() {
        listCalls += 1
        return [initialRuntime, fallbackRuntime]
      },
    } as unknown as import('hrc-sdk').HrcClient

    const descriptor = await attachWithRetry(client, initialRuntime.hostSessionId, initialRuntime)

    expect(descriptor.argv).toContain('attach-session')
    expect(descriptor.bindingFence.runtimeId).toBe(fallbackRuntime.runtimeId)
    expect(listCalls).toBe(1)
  })

  it('retries attach when runtime_unavailable is shaped like a domain error but fails instanceof', async () => {
    const initialRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-dead-tmux-structural',
      hostSessionId: 'hsid-test-attach-structural',
      scopeRef: 'agent:rex:project:agent-spaces:task:T-01001',
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      tmuxJson: {
        sessionId: '$16',
        windowId: '@16',
        paneId: '%16',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:10:00.000Z',
      updatedAt: '2026-04-16T00:10:00.000Z',
    }
    const fallbackRuntime: HrcRuntimeSnapshot = {
      runtimeId: 'rt-headless-structural-fallback',
      hostSessionId: initialRuntime.hostSessionId,
      scopeRef: initialRuntime.scopeRef,
      laneRef: initialRuntime.laneRef,
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      status: 'ready',
      continuation: {
        provider: 'openai',
        key: 'thread-456',
      },
      supportsInflightInput: false,
      adopted: false,
      createdAt: '2026-04-16T00:10:01.000Z',
      updatedAt: '2026-04-16T00:10:01.000Z',
    }

    let listCalls = 0
    const client = {
      async attachRuntime({ runtimeId }: { runtimeId: string }) {
        if (runtimeId === initialRuntime.runtimeId) {
          throw {
            code: HrcErrorCode.RUNTIME_UNAVAILABLE,
            message: 'runtime is dead',
            detail: { runtimeId },
          }
        }
        expect(runtimeId).toBe(fallbackRuntime.runtimeId)
        return {
          kind: 'exec',
          argv: ['tmux', 'attach-session', '-t', '$17'],
          bindingFence: {
            hostSessionId: initialRuntime.hostSessionId,
            runtimeId,
            generation: 1,
          },
        }
      },
      async listRuntimes() {
        listCalls += 1
        return [initialRuntime, fallbackRuntime]
      },
    } as unknown as import('hrc-sdk').HrcClient

    const descriptor = await attachWithRetry(client, initialRuntime.hostSessionId, initialRuntime)

    expect(descriptor.argv).toContain('attach-session')
    expect(descriptor.bindingFence.runtimeId).toBe(fallbackRuntime.runtimeId)
    expect(listCalls).toBe(1)
  })
})
