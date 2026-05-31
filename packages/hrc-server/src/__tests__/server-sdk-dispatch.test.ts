/**
 * RED/GREEN tests for hrc-server Phase 2 — SDK dispatch path (T-00968 / T-00967)
 *
 * Tests the server's SDK transport support:
 *   - dispatchTurn with interactive=false uses SDK transport
 *   - SDK dispatch creates runtime with transport='sdk'
 *   - Raw ledger records agent-spaces events during SDK dispatch
 *   - runtime_buffers populated during SDK dispatch
 *   - Continuation persisted on session after SDK turn
 *   - Provider mismatch returns 422
 *   - Attach on SDK runtime returns error
 *
 * Pass conditions for Larry (T-00967):
 *   1. POST /v1/turns with { harness: { interactive: false } } returns transport='sdk' in response
 *   2. Runtime record created by SDK dispatch has transport='sdk', no tmux_json
 *   3. Events with source='agent-spaces' appear in the raw events ledger during SDK dispatch
 *   4. GET /v1/capture on SDK runtime is refused; operators should use events
 *   5. Continuation from SDK turn is persisted on session record
 *   6. POST /v1/turns with provider mismatch on existing runtime returns 422
 *   7. GET /v1/attach on SDK runtime returns error (attach not supported)
 *   8. Run record transitions: accepted → started → completed
 *   9. Runtime transitions: created → busy → ready after SDK dispatch
 *  10. harness_session_json persisted on runtime record after SDK turn
 *
 * Reference: T-00946, HRC_IMPLEMENTATION_PLAN.md Phase 2
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'

let tmpDir: string
let runtimeRoot: string
let stateRoot: string
let socketPath: string
let lockPath: string
let spoolDir: string
let dbPath: string
let tmuxSocketPath: string
let server: HrcServer | undefined
let projectRoot: string
let originalPath: string | undefined
let originalAspClaudePath: string | undefined
let originalAspCodexPath: string | undefined
let originalAspCodexSkipCommonPaths: string | undefined

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // @ts-expect-error -- Bun supports unix option on fetch
    unix: socketPath,
  })
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetchSocket(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Resolve a session and return the hostSessionId */
async function resolveSession(scope: string): Promise<string> {
  const canonical = scope.startsWith('agent:') ? scope : `agent:${scope}`
  const res = await postJson('/v1/sessions/resolve', {
    sessionRef: `${canonical}/lane:default`,
  })
  const data = (await res.json()) as any
  return data.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent.
 * Uses an explicit SDK harness id so Anthropic's default Ghostty routing does
 * not capture SDK-specific assertions. */
function sdkIntent(provider: 'anthropic' | 'openai' = 'anthropic'): object {
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
      interactive: false,
      id: provider === 'anthropic' ? 'agent-sdk' : 'pi-sdk',
    },
  }
}

function interactiveCliIntent(
  provider: 'anthropic' | 'openai',
  options: {
    preferredMode?: 'interactive' | 'headless' | 'nonInteractive'
    pathPrepend?: string[]
    initialPrompt?: string
  } = {}
): object {
  return {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot,
      cwd: projectRoot,
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: {
      provider,
      interactive: true,
    },
    execution: {
      preferredMode: options.preferredMode ?? 'interactive',
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

beforeEach(async () => {
  originalPath = process.env['PATH']
  originalAspClaudePath = process.env['ASP_CLAUDE_PATH']
  originalAspCodexPath = process.env['ASP_CODEX_PATH']
  originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-sdk-test-'))
  runtimeRoot = join(tmpDir, 'runtime')
  stateRoot = join(tmpDir, 'state')
  socketPath = join(runtimeRoot, 'hrc.sock')
  lockPath = join(runtimeRoot, 'server.lock')
  spoolDir = join(runtimeRoot, 'spool')
  dbPath = join(stateRoot, 'state.sqlite')
  tmuxSocketPath = join(runtimeRoot, 'tmux.sock')
  projectRoot = join(tmpDir, 'project')

  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  await mkdir(spoolDir, { recursive: true })
  await mkdir(projectRoot, { recursive: true })

  server = await createHrcServer({
    runtimeRoot,
    stateRoot,
    socketPath,
    lockPath,
    spoolDir,
    dbPath,
    tmuxSocketPath,
    headlessCodexBrokerEnabled: false,
    claudeCodeTmuxBrokerEnabled: false,
    codexCliTmuxBrokerEnabled: false,
  })
})

afterEach(async () => {
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
  if (originalAspClaudePath === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CLAUDE_PATH']
  } else {
    process.env['ASP_CLAUDE_PATH'] = originalAspClaudePath
  }
  if (originalAspCodexSkipCommonPaths === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  } else {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalAspCodexSkipCommonPaths
  }

  if (server) {
    await server.stop()
    server = undefined
  }
  try {
    const { exited } = Bun.spawn(['tmux', '-S', tmuxSocketPath, 'kill-server'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await exited
  } catch {
    // ok
  }
  await rm(tmpDir, { recursive: true, force: true })
})

describe('runtime lifecycle start/attach', () => {
  async function installFakeCodex(
    dirName: string,
    behavior: {
      execDelayMs?: number
      execThreadId?: string
      interactiveBanner?: string
      interactiveDelayMs?: number
      resumeDelayMs?: number
    } = {}
  ): Promise<{ binDir: string; logPath: string; resumePath: string }> {
    const binDir = join(tmpDir, dirName)
    const logPath = join(binDir, 'codex.log')
    const resumePath = join(binDir, 'resume.log')
    await mkdir(binDir, { recursive: true })
    const scriptPath = join(binDir, 'codex')
    await writeFile(
      scriptPath,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const logPath = ${JSON.stringify(logPath)}
const resumePath = ${JSON.stringify(resumePath)}
const execDelayMs = ${JSON.stringify(behavior.execDelayMs ?? 0)}
const execThreadId = ${JSON.stringify(behavior.execThreadId ?? 'thread-123')}
const interactiveBanner = ${JSON.stringify(behavior.interactiveBanner ?? 'INTERACTIVE_HARNESS_STARTED')}
const interactiveDelayMs = ${JSON.stringify(behavior.interactiveDelayMs ?? 1_500)}
const resumeDelayMs = ${JSON.stringify(behavior.resumeDelayMs ?? 0)}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  const turnId = 'turn-123'
  const item = { id: 'msg-123', type: 'agentMessage', text: 'ok' }
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
  console.log('codex 0.124.0')
  process.exit(0)
}

const commandArgs = stripRootFlags(args)
const cmd = commandArgs[0] ?? ''

if (cmd === 'app-server' && commandArgs[1] === '--help') {
  console.log('Usage: codex app-server')
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
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: execThreadId } } })
      return
    }
    if (message.method === 'thread/resume') {
      const threadId = message.params?.threadId ?? execThreadId
      appendFileSync(resumePath, 'resume:' + threadId + '\\n')
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: threadId } } })
      return
    }
    if (message.method === 'turn/start') {
      write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-123' } } })
      setTimeout(emitTurn, execDelayMs)
      return
    }
  })
  rl.on('close', () => process.exit(0))
  setTimeout(() => {}, 60_000)
} else if (cmd === 'resume') {
  const resumeArgs = stripRootFlags(commandArgs.slice(1))
  appendFileSync(resumePath, 'resume:' + (resumeArgs[0] ?? '') + '\\n')
  await sleep(resumeDelayMs)
} else {
  appendFileSync(logPath, 'interactive:' + args.join(' ') + '\\n')
  console.log(interactiveBanner)
  await sleep(interactiveDelayMs)
}
`,
      'utf-8'
    )
    await chmod(scriptPath, 0o755)
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`
    process.env['ASP_CODEX_PATH'] = scriptPath
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
    return { binDir, logPath, resumePath }
  }

  function seedSessionContinuation(hostSessionId: string, key: string): void {
    const db = openHrcDatabase(dbPath)
    try {
      db.sessions.updateContinuation(
        hostSessionId,
        { provider: 'anthropic', key },
        new Date().toISOString()
      )
    } finally {
      db.close()
    }
  }

  function seedTerminatedTmuxRuntime(input: {
    hostSessionId: string
    scopeRef: string
    runtimeId: string
  }): void {
    const db = openHrcDatabase(dbPath)
    const now = new Date().toISOString()
    try {
      db.runtimes.insert({
        runtimeId: input.runtimeId,
        hostSessionId: input.hostSessionId,
        scopeRef: input.scopeRef,
        laneRef: 'default',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'terminated',
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }
  }

  async function waitForRuntimeStatus(
    runtimeId: string,
    expectedStatuses: string[],
    timeoutMs = 5_000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const db = openHrcDatabase(dbPath)
      try {
        const runtime = db.runtimes.getByRuntimeId(runtimeId)
        if (runtime && expectedStatuses.includes(runtime.status)) {
          return runtime.status
        }
      } finally {
        db.close()
      }
      await Bun.sleep(100)
    }

    throw new Error(
      `runtime ${runtimeId} did not reach one of [${expectedStatuses.join(', ')}] within ${timeoutMs}ms`
    )
  }

  it('interactive ensure fails closed when no broker-admissible route exists', async () => {
    const hsid = await resolveSession('interactive-dispatch-no-stale-session-continuation')
    seedTerminatedTmuxRuntime({
      hostSessionId: hsid,
      scopeRef: 'agent:interactive-dispatch-no-stale-session-continuation',
      runtimeId: 'rt-prior-terminated-no-continuation',
    })
    seedSessionContinuation(hsid, 'stale-session-continuation')

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(503)
    const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('ensureRuntime supports only broker-admissible runtimes')
  })

  it('interactive ensure does not mint legacy tmux runtimes with runtime continuation present', async () => {
    const hsid = await resolveSession('interactive-dispatch-runtime-continuation')
    seedSessionContinuation(hsid, 'stale-session-continuation')

    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(503)
    const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('ensureRuntime supports only broker-admissible runtimes')
  })

  it('headless codex dispatch fails closed instead of using legacy exec', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-headless-session-continuation')
    const hsid = await resolveSession('headless-dispatch-session-continuation-fallback')
    const db = openHrcDatabase(dbPath)
    try {
      db.sessions.updateContinuation(
        hsid,
        { provider: 'openai', key: 'session-headless-continuation' },
        new Date().toISOString()
      )
    } finally {
      db.close()
    }

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Dispatch headless with session fallback',
      runtimeIntent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(turnRes.status).toBe(503)
    const body = (await turnRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('headless legacy execution is unavailable')

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  })

  it('POST /v1/runtimes/start is idempotent for headless codex startup and persists continuation', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-idempotent')
    const hsid = await resolveSession('lifecycle-start-idempotent')

    const startBody = {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed a detached session',
      }),
    }

    const firstRes = await postJson('/v1/runtimes/start', startBody)
    expect(firstRes.status).toBe(200)
    const firstData = (await firstRes.json()) as any

    const secondRes = await postJson('/v1/runtimes/start', startBody)
    expect(secondRes.status).toBe(200)
    const secondData = (await secondRes.json()) as any

    expect(secondData.runtimeId).toBe(firstData.runtimeId)

    const sessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    const sessionData = (await sessionRes.json()) as any
    expect(sessionData.continuation).toEqual({
      provider: 'openai',
      key: 'thread-123',
    })

    const launchesRes = await fetchSocket(
      `/v1/launches?runtimeId=${encodeURIComponent(firstData.runtimeId)}`
    )
    const launches = (await launchesRes.json()) as any[]
    expect(launches).toHaveLength(1)

    const execLog = await readFile(fakeCodex.logPath, 'utf-8')
    expect(execLog.trim().split('\n')).toEqual(['app-server:app-server'])
  })

  it('POST /v1/clear-context can rotate to a fresh session without inheriting continuation', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-clear-context-new-session', {
      execThreadId: 'thread-old',
    })
    const hsid = await resolveSession('lifecycle-clear-context-new-session')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed detached session',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as { runtimeId: string }
    await waitForRuntimeStatus(startData.runtimeId, ['ready'])

    const clearRes = await postJson('/v1/clear-context', {
      hostSessionId: hsid,
      dropContinuation: true,
    })
    expect(clearRes.status).toBe(200)
    const clearData = (await clearRes.json()) as {
      hostSessionId: string
      priorHostSessionId: string
      generation: number
    }
    expect(clearData.priorHostSessionId).toBe(hsid)
    expect(clearData.hostSessionId).not.toBe(hsid)
    expect(clearData.generation).toBe(2)

    const priorSessionRes = await fetchSocket(`/v1/sessions/by-host/${hsid}`)
    const priorSessionData = (await priorSessionRes.json()) as any
    expect(priorSessionData.status).toBe('archived')
    expect(priorSessionData.continuation).toEqual({
      provider: 'openai',
      key: 'thread-old',
    })

    const nextSessionRes = await fetchSocket(`/v1/sessions/by-host/${clearData.hostSessionId}`)
    const nextSessionData = (await nextSessionRes.json()) as any
    expect(nextSessionData.status).toBe('active')
    expect(nextSessionData.continuation).toBeUndefined()
  })

  it('POST /v1/runtimes/attach waits for in-flight start then fails closed without legacy resume', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach', {
      execDelayMs: 350,
      resumeDelayMs: 250,
    })
    const hsid = await resolveSession('lifecycle-attach-blocks')

    const startPromise = postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before attach',
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 75))

    let attachSettled = false
    const attachPromise = (async () => {
      const startRes = await startPromise
      const startData = (await startRes.json()) as any
      const attachRes = await postJson('/v1/runtimes/attach', {
        runtimeId: startData.runtimeId,
      })
      attachSettled = true
      return { startData, attachRes }
    })()

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(attachSettled).toBe(false)

    const { startData, attachRes } = await attachPromise
    expect(attachRes.status).toBe(503)
    const attachBody = (await attachRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(attachBody.error?.code).toBe('runtime_unavailable')
    expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')

    await new Promise((resolve) => setTimeout(resolve, 400))

    const secondAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(secondAttachRes.status).toBe(503)

    const resumeLog = await readFile(fakeCodex.resumePath, 'utf-8').catch(() => '')
    expect(resumeLog).toBe('')
  }, 10_000)

  it('POST /v1/runtimes/attach does not rematerialize legacy tmux from headless codex', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach-no-reprime')
    const hsid = await resolveSession('lifecycle-attach-no-reprime')
    const primingPrompt = 'Seed before attach'

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: primingPrompt,
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const attachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(attachRes.status).toBe(503)
    const attachBody = (await attachRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(attachBody.error?.code).toBe('runtime_unavailable')
    expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')

    const launchesRes = await fetchSocket(
      `/v1/launches?runtimeId=${encodeURIComponent(startData.runtimeId)}`
    )
    const launches = (await launchesRes.json()) as Array<{ lifecycleAction?: string }>
    expect(launches.some((launch) => launch.lifecycleAction === 'attach')).toBe(false)

    const resumeLog = await readFile(fakeCodex.resumePath, 'utf-8').catch(() => '')
    expect(resumeLog).toBe('')
    expect(primingPrompt).toBeString()
  }, 10_000)

  it('POST /v1/runtimes/attach rejects legacy attach descriptor recovery', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-stale-session-name')
    const hsid = await resolveSession('lifecycle-attach-stale-session-name')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before stale session attach',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(503)
    const attachBody = (await initialAttachRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(attachBody.error?.code).toBe('runtime_unavailable')
    expect(attachBody.error?.message).toContain('runtime intent is not broker-admissible')
  }, 10_000)

  it('POST /v1/runtimes/attach does not rematerialize tmux when the requested runtime is dead', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach-dead-runtime')
    const hsid = await resolveSession('lifecycle-attach-dead-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before dead attach recovery',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(503)

    const db = openHrcDatabase(dbPath)
    try {
      db.runtimes.update(startData.runtimeId, {
        status: 'dead',
        updatedAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(recoveredAttachRes.status).toBe(503)
    const resumeLog = await readFile(fakeCodex.resumePath, 'utf-8').catch(() => '')
    expect(resumeLog).toBe('')
  }, 10_000)

  it('POST /v1/runtimes/attach does not rematerialize tmux after prior runtime exits', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-attach-terminated-runtime', {
      resumeDelayMs: 250,
    })
    const hsid = await resolveSession('lifecycle-attach-terminated-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        preferredMode: 'headless',
        pathPrepend: [fakeCodex.binDir],
        initialPrompt: 'Seed before terminated attach recovery',
      }),
    })
    expect(startRes.status).toBe(200)
    const startData = (await startRes.json()) as any

    const initialAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(initialAttachRes.status).toBe(503)
    expect(await waitForRuntimeStatus(startData.runtimeId, ['ready', 'terminated'])).toBe('ready')

    const recoveredAttachRes = await postJson('/v1/runtimes/attach', {
      runtimeId: startData.runtimeId,
    })
    expect(recoveredAttachRes.status).toBe(503)

    const resumeLog = await readFile(fakeCodex.resumePath, 'utf-8').catch(() => '')
    expect(resumeLog).toBe('')
  }, 10_000)

  it('POST /v1/runtimes/attach does not attach directly to legacy codex tmux', async () => {
    const hsid = await resolveSession('lifecycle-attach-live-no-continuation')
    const ensureRes = await postJson('/v1/runtimes/ensure', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai'),
    })
    expect(ensureRes.status).toBe(503)
    const body = (await ensureRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('ensureRuntime supports only broker-admissible runtimes')
  })

  it('POST /v1/runtimes/start fails closed for non-broker interactive harness start', async () => {
    const fakeCodex = await installFakeCodex('fake-codex-dead-after-exit', {
      interactiveDelayMs: 10_000,
    })
    const hsid = await resolveSession('lifecycle-exited-dead-runtime')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(startRes.status).toBe(503)
    const body = (await startRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('interactive runtime is not broker-admissible')

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).toBe('')
  })

  it('POST /v1/runtimes/start does not launch legacy interactive harness before attach', async () => {
    const interactiveBanner = 'INTERACTIVE_START_LAUNCHED'
    const fakeCodex = await installFakeCodex('fake-codex-interactive-start', {
      interactiveBanner,
      interactiveDelayMs: 2_000,
    })
    const hsid = await resolveSession('lifecycle-interactive-start')

    const startRes = await postJson('/v1/runtimes/start', {
      hostSessionId: hsid,
      intent: interactiveCliIntent('openai', {
        pathPrepend: [fakeCodex.binDir],
      }),
    })
    expect(startRes.status).toBe(503)
    const body = (await startRes.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('runtime_unavailable')
    expect(body.error?.message).toContain('interactive runtime is not broker-admissible')

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 7. Attach on SDK runtime returns error
// ---------------------------------------------------------------------------
describe('attach on SDK runtime', () => {
  it('returns error for SDK runtime attach requests', async () => {
    const hsid = await resolveSession('sdk-test-7')

    const turnRes = await postJson('/v1/turns', {
      hostSessionId: hsid,
      prompt: 'Attach test',
      runtimeIntent: sdkIntent(),
    })
    const turnData = (await turnRes.json()) as any

    // Wait for SDK turn to complete
    await new Promise((r) => setTimeout(r, 1000))

    const attachRes = await fetchSocket(`/v1/attach?runtimeId=${turnData.runtimeId}`)
    // SDK runtimes should reject attach
    expect(attachRes.status).toBeGreaterThanOrEqual(400)
    const errorData = (await attachRes.json()) as any
    expect(errorData.error).toBeDefined()
  })
})
