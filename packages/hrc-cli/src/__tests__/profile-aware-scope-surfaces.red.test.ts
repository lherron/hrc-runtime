/**
 * T-08597: profile-aware managed scope resolution over the daemon-backed SDK.
 *
 * Role/harness/placement facts arrive from the daemon (fake socket server
 * here); the CLI asserts end-to-end scope shaping across run/start/attach
 * --dry-run. The fake stands in for aspd-backed observation with the same
 * fixture semantics the old local parser read: the project-local agents root
 * wins, and its profile role becomes the scope default.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../cli.js'
import { type FakeDaemon, startFakeDaemon } from './fake-daemon.js'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

let tempRoot: string
let projectRoot: string
let canonicalAgentsRoot: string
let localAgentRoot: string
let daemon: FakeDaemon | undefined

function profile(defaultScopeRole: string): string {
  return [
    'version = 3',
    '',
    '[identity]',
    'display = "Scope Fixture"',
    `role = "${defaultScopeRole}"`,
    '',
    '[provisioning]',
    'harness = "codex"',
    '',
  ].join('\n')
}

async function runCli(args: string[], tty = false): Promise<CliResult> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalExitCode = process.exitCode
  const originalStdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const originalStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const env = {
    ASP_AGENTS_ROOT: canonicalAgentsRoot,
    ASP_PROJECT: 'proj',
    ASP_PROJECT_ROOT_OVERRIDE: projectRoot,
    HRC_RUNTIME_DIR: daemon!.runtimeDir,
  }
  const originalEnv = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    originalEnv.set(key, process.env[key])
    process.env[key] = value
  }

  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: tty })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty })
  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  let exitCode = 0
  try {
    await main(args)
  } catch (error) {
    if (error instanceof CliExit) {
      exitCode = error.code
    } else {
      throw error
    }
  } finally {
    if (typeof process.exitCode === 'number' && exitCode === 0) {
      exitCode = process.exitCode
    }
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    process.exitCode = originalExitCode
    if (originalStdinTty) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinTty)
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
    if (originalStdoutTty) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutTty)
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY')
    }
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  }
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'hrc-profile-scope-'))
  projectRoot = join(tempRoot, 'project')
  canonicalAgentsRoot = join(tempRoot, 'canonical-agents')
  localAgentRoot = join(projectRoot, 'agents', 'clod')
  const canonicalAgentRoot = join(canonicalAgentsRoot, 'clod')

  await mkdir(localAgentRoot, { recursive: true })
  await mkdir(canonicalAgentRoot, { recursive: true })
  await writeFile(join(projectRoot, 'asp-targets.toml'), 'schema = 1\nagents-root = "agents"\n')
  await writeFile(join(localAgentRoot, 'agent-profile.toml'), profile('tester'))
  await writeFile(join(canonicalAgentRoot, 'agent-profile.toml'), profile('coordinator'))

  // Project-local agents root wins (the fixture's asp-targets.toml declares
  // agents-root = "agents"); its profile role becomes the scope default.
  daemon = startFakeDaemon({
    placement: () => ({
      agentId: 'clod',
      projectId: 'proj',
      agentRoot: localAgentRoot,
      projectRoot,
      cwd: projectRoot,
      bundle: { kind: 'agent-project', agentName: 'clod', projectRoot },
      bundleIdentity: 'test-identity',
      harness: { provider: 'openai', frontend: 'codex-cli', effectiveHarness: 'codex' },
      provision: { scalars: {} },
      policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
      identity: { role: 'tester', operator: false },
      agentSources: { agentsRoot: join(projectRoot, 'agents'), provenance: 'project-marker' },
      searchedAgentRoots: [localAgentRoot],
      source: {
        agentProfile: 'valid',
        projectTargets: 'valid',
        selectedTarget: 'absent',
        priming: 'valid',
      },
      resolution: { source: 'explicit-override', reason: 'test' },
      warnings: [],
      release: { releaseId: 'r', sourceCommit: 'c' },
    }),
    declaration: () => ({
      intent: {
        placement: {
          agentRoot: localAgentRoot,
          projectRoot,
          cwd: projectRoot,
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'clod', projectRoot },
          dryRun: false,
        },
        harness: { provider: 'openai', interactive: true, id: 'codex-cli' },
        execution: { preferredMode: 'headless' },
      },
      declaration: {
        release: { releaseId: 'r', sourceCommit: 'c' },
        agentSources: { provenance: 'daemon-default' },
        source: {
          agentProfile: 'valid',
          projectTargets: 'valid',
          selectedTarget: 'absent',
          priming: 'valid',
        },
        warnings: [],
      },
    }),
  })
})

afterEach(async () => {
  daemon?.stop()
  daemon = undefined
  await rm(tempRoot, { recursive: true, force: true })
})

describe('profile-aware managed HRC scope resolution', () => {
  test('run, start, and attach use the project-local configured role for one explicit task', async () => {
    const handle = 'clod@proj:T-12345'
    const expectedSessionRef = 'agent:clod:project:proj:task:T-12345:role:tester/lane:main'
    const invocations = [
      { args: ['run', handle, '--dry-run'], tty: true },
      { args: ['start', handle, '--dry-run'], tty: false },
      { args: ['attach', handle, '--dry-run'], tty: false },
    ]

    for (const invocation of invocations) {
      const result = await runCli(invocation.args, invocation.tty)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(expectedSessionRef)
      expect(result.stdout).not.toContain(':role:coordinator')
    }
  })

  test('an invalid configured role fails visibly instead of falling back to an un-roled scope', async () => {
    await writeFile(join(localAgentRoot, 'agent-profile.toml'), profile('not/a/role'))
    daemon?.stop()
    daemon = startFakeDaemon({
      placement: () => ({
        agentId: 'clod',
        projectId: 'proj',
        agentRoot: localAgentRoot,
        projectRoot,
        cwd: projectRoot,
        bundle: { kind: 'agent-project', agentName: 'clod', projectRoot },
        harness: { provider: 'openai', frontend: 'codex-cli', effectiveHarness: 'codex' },
        provision: { scalars: {} },
        policy: { claimsTask: false, placement: { pins: {}, homes: {} } },
        identity: { role: 'not/a/role', operator: false },
        agentSources: { provenance: 'daemon-default' },
        searchedAgentRoots: [localAgentRoot],
        source: {
          agentProfile: 'valid',
          projectTargets: 'valid',
          selectedTarget: 'absent',
          priming: 'valid',
        },
        resolution: { source: 'explicit-override', reason: 'test' },
        warnings: [],
        release: { releaseId: 'r', sourceCommit: 'c' },
      }),
      declaration: () => ({}),
    })

    const result = await runCli(['start', 'clod@proj:T-12345', '--dry-run'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toBe('')
    expect(result.stdout).not.toContain('agent:clod:project:proj:task:T-12345/lane:main')
  })
})
