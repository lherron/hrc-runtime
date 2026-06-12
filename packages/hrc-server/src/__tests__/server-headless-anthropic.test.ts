import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'bun:test'

import type { SemanticDmResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture | undefined
let server: HrcServer | undefined
let originalPath: string | undefined
let originalAspCodexPath: string | undefined
let originalAspCodexSkipCommonPaths: string | undefined
let originalHrcClaudeGhostty: string | undefined

function saveCodexEnv(): void {
  originalPath = process.env['PATH']
  originalAspCodexPath = process.env['ASP_CODEX_PATH']
  originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  originalHrcClaudeGhostty = process.env['HRC_CLAUDE_GHOSTTY']
}

function restoreCodexEnv(): void {
  if (originalPath === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (=undefined leaks string "undefined")
    delete process.env['PATH']
  } else {
    process.env['PATH'] = originalPath
  }
  if (originalAspCodexPath === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_PATH']
  } else {
    process.env['ASP_CODEX_PATH'] = originalAspCodexPath
  }
  if (originalAspCodexSkipCommonPaths === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  } else {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalAspCodexSkipCommonPaths
  }
  if (originalHrcClaudeGhostty === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['HRC_CLAUDE_GHOSTTY']
  } else {
    process.env['HRC_CLAUDE_GHOSTTY'] = originalHrcClaudeGhostty
  }
}

function headlessIntent(
  provider: 'anthropic' | 'openai',
  options: {
    preferredMode?: 'headless' | 'nonInteractive'
    pathPrepend?: string[]
    initialPrompt?: string
  } = {}
): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: true,
    },
    execution: {
      preferredMode: options.preferredMode ?? 'headless',
    },
    ...(options.pathPrepend
      ? {
          launch: {
            pathPrepend: options.pathPrepend,
          },
        }
      : {}),
    ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
  }
}

function interactiveAnthropicIntent(): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider: 'anthropic',
      interactive: true,
      id: 'claude-code',
    },
    execution: {
      preferredMode: 'interactive',
    },
  }
}

async function createTestServer(
  options: { claudeGhostty?: boolean; claudeCodeTmuxBrokerEnabled?: boolean } = {}
): Promise<void> {
  saveCodexEnv()
  if (options.claudeGhostty === true) {
    process.env['HRC_CLAUDE_GHOSTTY'] = '1'
  } else {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['HRC_CLAUDE_GHOSTTY']
  }
  fixture = await createHrcTestFixture('hrc-headless-anthropic-')
  server = await createHrcServer(
    fixture.serverOpts({
      ...(options.claudeCodeTmuxBrokerEnabled !== undefined
        ? { claudeCodeTmuxBrokerEnabled: options.claudeCodeTmuxBrokerEnabled }
        : {}),
    })
  )
}

async function resolveSession(
  scopeRef: string
): Promise<{ hostSessionId: string; generation: number }> {
  if (!fixture) throw new Error('fixture not initialized')
  return await fixture.resolveSession(scopeRef)
}

async function getSession(hostSessionId: string): Promise<any> {
  if (!fixture) throw new Error('fixture not initialized')
  const res = await fixture.fetchSocket(`/v1/sessions/by-host/${hostSessionId}`)
  expect(res.status).toBe(200)
  return await res.json()
}

function seedHeadlessRuntime(
  hostSessionId: string,
  scopeRef: string,
  generation: number,
  options: {
    continuation?: { provider: 'anthropic'; key: string } | undefined
    lastAppliedIntentJson?: object | undefined
  } = {}
): string {
  if (!fixture) throw new Error('fixture not initialized')
  const runtimeId = `rt-headless-${randomUUID()}`
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()

  try {
    if (options.lastAppliedIntentJson) {
      db.sessions.updateIntent(hostSessionId, options.lastAppliedIntentJson as any, now)
    }
    if (options.continuation) {
      db.sessions.updateContinuation(hostSessionId, options.continuation as any, now)
    }

    db.runtimes.insert({
      runtimeId,
      hostSessionId,
      scopeRef: scopeRef.startsWith('agent:') ? scopeRef : `agent:${scopeRef}`,
      laneRef: 'default',
      generation,
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status: 'ready',
      supportsInflightInput: false,
      adopted: false,
      ...(options.continuation ? { continuation: options.continuation } : {}),
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }

  return runtimeId
}

async function installFakeClaude(
  dirName: string,
  options: { interactiveDelayMs?: number } = {}
): Promise<{ binDir: string; logPath: string }> {
  if (!fixture) throw new Error('fixture not initialized')
  const binDir = join(fixture.tmpDir, dirName)
  const logPath = join(binDir, 'claude.log')
  const scriptPath = join(binDir, 'claude')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
log_path=${JSON.stringify(logPath)}
printf 'claude:%s\\n' "$*" >> "$log_path"
printf 'CLAUDE_ATTACH_STARTED\\n'
/bin/sleep ${((options.interactiveDelayMs ?? 1_500) / 1000).toFixed(3)}
exit 0
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)

  return { binDir, logPath }
}

async function installFakeCodex(
  dirName: string,
  options: { execDelayMs?: number } = {}
): Promise<{ binDir: string; logPath: string }> {
  if (!fixture) throw new Error('fixture not initialized')
  const binDir = join(fixture.tmpDir, dirName)
  const logPath = join(binDir, 'codex.log')
  const scriptPath = join(binDir, 'codex')

  await mkdir(binDir, { recursive: true })
  await writeFile(
    scriptPath,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const logPath = ${JSON.stringify(logPath)}
const execDelayMs = ${JSON.stringify(options.execDelayMs ?? 0)}

function stripRootFlags(input) {
  const args = [...input]
  while (args.length > 0) {
    const flag = args[0]
    if (flag === '--enable' || flag === '--disable' || flag === '--model' || flag === '-m' || flag === '-c') {
      args.splice(0, 2)
      continue
    }
    break
  }
  return args
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

function emitTurn() {
  const turnId = 'turn-openai-headless'
  const item = { id: 'item_0', type: 'agentMessage', text: 'ok' }
  write({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: turnId } } })
  write({ jsonrpc: '2.0', method: 'item/completed', params: { turnId, item } })
  write({
    jsonrpc: '2.0',
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { input_tokens: 1, output_tokens: 1 } },
  })
  write({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: { turn: { id: turnId, status: 'completed', items: [item] } },
  })
}

if (args[0] === '--version') {
  console.log('codex 99.0.0')
  process.exit(0)
}

const commandArgs = stripRootFlags(args)
const cmd = commandArgs[0] ?? ''

if (cmd === 'app-server' && commandArgs[1] === '--help') {
  console.log('codex app-server help')
  process.exit(0)
}

if (cmd === 'app-server') {
  appendFileSync(logPath, 'app-server:' + commandArgs.join(' ') + '\\n')
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const message = JSON.parse(line)
    if (!('id' in message)) return
    if (message.method === 'initialize') {
      write({ jsonrpc: '2.0', id: message.id, result: {} })
      return
    }
    if (message.method === 'thread/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-openai-headless' } } })
      return
    }
    if (message.method === 'thread/resume') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: { thread: { id: message.params?.threadId ?? 'thread-openai-headless' } },
      })
      return
    }
    if (message.method === 'turn/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-openai-headless' } } })
      setTimeout(emitTurn, execDelayMs)
      return
    }
  })
  rl.on('close', () => process.exit(0))
  setTimeout(() => {}, 60_000)
} else {
  appendFileSync(logPath, 'interactive:' + args.join(' ') + '\\n')
}
`,
    'utf-8'
  )
  await chmod(scriptPath, 0o755)
  process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
  process.env['ASP_CODEX_PATH'] = scriptPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'

  return { binDir, logPath }
}

afterEach(async () => {
  if (server) {
    await server.stop()
    server = undefined
  }
  if (fixture) {
    await fixture.cleanup()
    fixture = undefined
  }
  restoreCodexEnv()
})

describe('C. Attach from headless Anthropic runtime', () => {
  it('returns an error when a headless Anthropic runtime has no continuation', async () => {
    await createTestServer({ claudeCodeTmuxBrokerEnabled: false })

    const scopeRef = 'agent:anthropic-headless-no-continuation'
    const { hostSessionId, generation } = await resolveSession(scopeRef)
    const runtimeId = seedHeadlessRuntime(hostSessionId, scopeRef, generation, {
      lastAppliedIntentJson: headlessIntent('anthropic'),
    })

    const attachRes = await fixture!.postJson('/v1/runtimes/attach', {
      runtimeId,
    })

    expect(attachRes.status).toBeGreaterThanOrEqual(400)
    const data = (await attachRes.json()) as any
    expect(data.error).toBeDefined()
    expect(data.error.code).toBe('runtime_unavailable')
  })
})

describe('C2. Ghostty availability', () => {
  it('does not start legacy tmux for interactive Claude when Ghostty is not enabled', async () => {
    await createTestServer()

    const fakeClaude = await installFakeClaude('fake-claude-default-tmux')
    const { hostSessionId } = await resolveSession('anthropic-default-tmux')
    const res = await fixture!.postJson('/v1/runtimes/start', {
      hostSessionId,
      intent: {
        ...interactiveAnthropicIntent(),
        launch: {
          pathPrepend: [fakeClaude.binDir],
        },
      },
    })

    expect(res.status).toBe(503)
    const data = (await res.json()) as any
    expect(data.error?.code).toBe('runtime_unavailable')
    const execLog = await readFile(fakeClaude.logPath, 'utf-8').catch(() => '')
    expect(execLog).toBe('')
  }, 10_000)

  it('returns runtime_unavailable instead of internal_error when ghostmux cannot reach Ghostty', async () => {
    saveCodexEnv()
    process.env['HRC_CLAUDE_GHOSTTY'] = '1'
    fixture = await createHrcTestFixture('hrc-headless-anthropic-')
    server = await createHrcServer(
      fixture.serverOpts({
        ghostmuxOptions: {
          runner: async () => {
            throw new Error(
              'cannot connect to Ghostty UDS at /Users/test/Library/Application Support/Ghostty/api.sock'
            )
          },
        },
      })
    )

    const { hostSessionId } = await resolveSession('anthropic-ghostty-unavailable')
    const res = await fixture.postJson('/v1/runtimes/start', {
      hostSessionId,
      intent: interactiveAnthropicIntent(),
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    const data = (await res.json()) as any
    expect(data.error?.code).toBe('runtime_unavailable')
    expect(String(data.error?.message ?? '')).not.toContain('internal server error')
  })
})

describe('D. DM fallback', () => {
  it('fails closed for Anthropic headless DM fallback when no broker route exists', async () => {
    // The premise is "no broker route exists" — the broker route is ON by
    // default, and leaving it on makes this dispatch start a REAL interactive
    // claude (per-runtime tmux server + harness-broker + launch runner) as a
    // side effect of the DM.
    await createTestServer({ claudeCodeTmuxBrokerEnabled: false })

    const dmRes = await fixture!.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'fallback to anthropic headless transport',
      runtimeIntent: headlessIntent('anthropic'),
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('failed')
  })

  it('does not use legacy headless exec for non-wait Codex DM fallback', async () => {
    await createTestServer()

    const fakeCodex = await installFakeCodex('fake-codex-slow-dm', { execDelayMs: 5_000 })
    const startedAt = performance.now()
    const dmRes = await fixture!.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:slow-dm:project:agent-spaces/lane:main' },
      body: 'slow headless dm should not block',
      runtimeIntent: headlessIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    const elapsedMs = performance.now() - startedAt

    expect(dmRes.status).toBe(200)
    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(elapsedMs).toBeLessThan(5_500)
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('failed')
    expect(dm.reply).toBeUndefined()
    expect(dm.waited).toBeUndefined()

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  }, 10_000)

  it('does not use legacy headless exec for waited Codex DM fallback', async () => {
    await createTestServer()

    const fakeCodex = await installFakeCodex('fake-codex-wait-dm')
    const startedAt = performance.now()
    const dmRes = await fixture!.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:wait-dm:project:agent-spaces/lane:main' },
      body: 'wait for headless reply',
      runtimeIntent: headlessIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
      wait: { enabled: true, timeoutMs: 300 },
    })
    const elapsedMs = performance.now() - startedAt

    expect(dmRes.status).toBe(200)
    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(elapsedMs).toBeGreaterThanOrEqual(250)
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('failed')
    expect(dm.reply).toBeUndefined()
    expect(dm.waited).toEqual({ matched: false, reason: 'timeout' })
    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  }, 10_000)
})

describe('E. Regression', () => {
  it('does not route Codex headless dispatch through legacy headless exec', async () => {
    await createTestServer()

    const fakeCodex = await installFakeCodex('fake-codex-openai-headless')
    const { hostSessionId } = await resolveSession('openai-headless-regression')

    const res = await fixture!.postJson('/v1/turns', {
      hostSessionId,
      prompt: 'OpenAI headless regression turn',
      runtimeIntent: headlessIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })

    expect(res.status).toBe(503)
    const data = (await res.json()) as { error?: { code?: string } }
    expect(data.error?.code).toBe('runtime_unavailable')
    const session = await getSession(hostSessionId)
    expect(session.continuation).toBeUndefined()
    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  }, 10_000)
})
