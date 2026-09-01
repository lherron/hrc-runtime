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
 * Reference: wrkq T-00946 (agent-spaces/hrc/implementation-plan, archived).
 * The plan document itself no longer exists; docs/hrc-server-architecture.md
 * describes the shipped architecture.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createSocketScratch } from './fixtures/socket-scratch'

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
let originalAspHeadlessDurableBroker: string | undefined

const INTEGRATION_TIMEOUT_MS = 60_000

// This file boots real server instances and compiles real harness plans. Keep a
// bounded integration timeout, but leave enough headroom for loaded-box runs:
// eight concurrent copies have pushed the real compile RPC to roughly 30s.
setDefaultTimeout(INTEGRATION_TIMEOUT_MS)

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((signalResolve) => {
    resolve = signalResolve
  })
  return { promise, resolve }
}

async function fetchSocket(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...init,
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
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
    create: true,
  })
  const data = (await res.json()) as any
  return data.hostSessionId
}

/** Build a non-interactive (SDK) runtime intent.
 * Uses an explicit SDK harness id so Anthropic's default interactive routing does
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
    interactive?: boolean
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
      interactive: options.interactive ?? true,
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

void createSignal
void interactiveCliIntent

beforeEach(async () => {
  originalPath = process.env['PATH']
  originalAspClaudePath = process.env['ASP_CLAUDE_PATH']
  originalAspCodexPath = process.env['ASP_CODEX_PATH']
  originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  originalAspHeadlessDurableBroker = process.env['ASP_HEADLESS_DURABLE_BROKER']

  // T-01866 — HRC now admits ONLY harness-broker/0.2 broker profiles. The
  // currently-installed ASP emits the v0.2 headless codex profile only when this
  // operator flag is set (Ph4b); clod's co-transactional agent-spaces half makes
  // v0.2 UNCONDITIONAL, after which this flag is a harmless no-op. Set it so the
  // real compile in these integration tests yields the v0.2 profile HRC requires.
  process.env['ASP_HEADLESS_DURABLE_BROKER'] = '1'

  tmpDir = (await createSocketScratch('hrc-sdk-attach-')).root
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
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (=undefined leaks string "undefined")
    delete process.env['PATH']
  } else {
    process.env['PATH'] = originalPath
  }
  if (originalAspCodexPath === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_PATH']
  } else {
    process.env['ASP_CODEX_PATH'] = originalAspCodexPath
  }
  if (originalAspClaudePath === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CLAUDE_PATH']
  } else {
    process.env['ASP_CLAUDE_PATH'] = originalAspClaudePath
  }
  if (originalAspCodexSkipCommonPaths === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  } else {
    process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalAspCodexSkipCommonPaths
  }
  if (originalAspHeadlessDurableBroker === undefined) {
    // EXCEPTION(T-07533): copied by test-suite extraction; original behavior is unchanged.
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env['ASP_HEADLESS_DURABLE_BROKER']
  } else {
    process.env['ASP_HEADLESS_DURABLE_BROKER'] = originalAspHeadlessDurableBroker
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
