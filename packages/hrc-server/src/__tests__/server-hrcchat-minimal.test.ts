import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  HrcTargetView,
  ListMessagesResponse,
  SemanticDmResponse,
  SemanticTurnHandoffResponse,
} from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from '../hrc-event-helper'
import { createHrcServer } from '../index'
import type { HrcServer, HrcServerOptions } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer
let originalPath: string | undefined
let originalAspCodexPath: string | undefined
let originalAspCodexSkipCommonPaths: string | undefined

beforeEach(async () => {
  originalPath = process.env['PATH']
  originalAspCodexPath = process.env['ASP_CODEX_PATH']
  originalAspCodexSkipCommonPaths = process.env['ASP_CODEX_SKIP_COMMON_PATHS']
  fixture = await createHrcTestFixture('hrc-hrcchat-minimal-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
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
})

describe('hrcchat minimal server routes', () => {
  async function restartServer(overrides: Partial<HrcServerOptions>): Promise<void> {
    await server.stop()
    server = await createHrcServer(fixture.serverOpts(overrides))
  }

  async function installFakeCodex(dirName: string): Promise<{ binDir: string; logPath: string }> {
    const binDir = join(fixture.tmpDir, dirName)
    const logPath = join(binDir, 'codex.log')
    const scriptPath = join(binDir, 'codex')

    await mkdir(binDir, { recursive: true })
    await writeFile(
      scriptPath,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = ${JSON.stringify(logPath)}
const args = process.argv.slice(2)

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

function emitTurn(threadId) {
  const turnId = 'turn-dm'
  const item = { id: 'msg-dm', type: 'agentMessage', text: 'ok' }
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
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-dm' } } })
      return
    }
    if (message.method === 'thread/resume') {
      write({ jsonrpc: '2.0', id: message.id, result: { thread: { id: message.params?.threadId ?? 'thread-dm' } } })
      return
    }
    if (message.method === 'turn/start') {
      const threadId = message.params?.threadId ?? 'thread-dm'
      write({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-dm' } } })
      emitTurn(threadId)
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

  it('lists targets and normalizes legacy default lanes to main', async () => {
    await fixture.resolveSession('agent:cody:project:agent-spaces')

    const res = await fixture.fetchSocket('/v1/targets')
    expect(res.status).toBe(200)

    const targets = (await res.json()) as HrcTargetView[]
    expect(targets).toHaveLength(1)
    expect(targets[0]?.sessionRef).toBe('agent:cody:project:agent-spaces/lane:main')
    expect(targets[0]?.laneRef).toBe('main')
    expect(targets[0]?.state).toBe('summoned')
  })

  it('looks up a single target by sessionRef with main/default aliasing', async () => {
    await fixture.resolveSession('agent:clod:project:agent-spaces')

    const res = await fixture.fetchSocket(
      '/v1/targets/by-session-ref?sessionRef=agent%3Aclod%3Aproject%3Aagent-spaces%2Flane%3Amain'
    )
    expect(res.status).toBe(200)

    const target = (await res.json()) as HrcTargetView
    expect(target.sessionRef).toBe('agent:clod:project:agent-spaces/lane:main')
    expect(target.scopeRef).toBe('agent:clod:project:agent-spaces')
  })

  it('appends durable dm records and returns them through messages/query', async () => {
    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'ping from cody',
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.request.kind).toBe('dm')
    expect(dm.request.phase).toBe('request')
    expect(dm.request.to).toEqual({
      kind: 'session',
      sessionRef: 'agent:clod:project:agent-spaces/lane:main',
    })

    const listRes = await fixture.postJson('/v1/messages/query', {
      participant: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
    })
    expect(listRes.status).toBe(200)

    const listed = (await listRes.json()) as ListMessagesResponse
    expect(listed.messages).toHaveLength(1)
    expect(listed.messages[0]?.messageId).toBe(dm.request.messageId)
    expect(listed.messages[0]?.body).toBe('ping from cody')
  })

  it('rejects responseFormat on non-session semantic DMs before message persistence', async () => {
    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'entity', entity: 'system' },
      body: 'this is not a turn-capable target',
      responseFormat: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    })

    expect(dmRes.status).toBe(400)
    const errorBody = (await dmRes.json()) as {
      error?: { code?: string; message?: string; detail?: Record<string, unknown> }
    }
    expect(errorBody.error?.code).toBe('malformed_request')
    expect(errorBody.error?.message).toContain('responseFormat requires a session turn target')
    expect(errorBody.error?.detail).toMatchObject({
      field: 'responseFormat',
      route: 'semantic-dm',
      reason: 'responseFormat requires a session turn target',
    })

    const listRes = await fixture.postJson('/v1/messages/query', {
      participant: { kind: 'entity', entity: 'system' },
    })
    expect(listRes.status).toBe(200)

    const listed = (await listRes.json()) as ListMessagesResponse
    expect(listed.messages).toHaveLength(0)
  })

  it('threads responseFormat on session-target semantic DMs to semantic turn dispatch', async () => {
    const scopeRef = 'agent:cody:project:agent-spaces:task:T-05142'
    const sessionRef = `${scopeRef}/lane:main`
    await fixture.resolveSession(scopeRef)

    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }
    let capturedResponseFormat: unknown
    const originalExecuteSemanticTurn = (server as any).executeSemanticTurn
    ;(server as any).executeSemanticTurn = async (_session: unknown, body: any) => {
      capturedResponseFormat = body.responseFormat
      return {}
    }

    try {
      const dmRes = await fixture.postJson('/v1/messages/dm', {
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef },
        body: 'dispatch this as a structured turn',
        responseFormat: { kind: 'json_schema', schema },
      })
      expect(dmRes.status).toBe(200)
    } finally {
      ;(server as any).executeSemanticTurn = originalExecuteSemanticTurn
    }

    expect(capturedResponseFormat).toEqual({ kind: 'json_schema', schema })
  })

  it('persists message-to-session correlation for dm records before any runtime exists', async () => {
    const scopeRef = 'agent:cody:project:agent-spaces:task:T-01293'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)

    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'correlate this message before summon',
      createIfMissing: false,
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    const messageId = dm.request.messageId

    // Re-open the store to model a later hrc monitor process resolving msg:<messageId>
    // after the originating hrcchat dm process has exited.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const persisted = db.messages.getById(messageId)
      expect(persisted).not.toBeUndefined()
      expect(persisted?.execution.sessionRef).toBe(sessionRef)
      expect(persisted?.execution.hostSessionId).toBe(hostSessionId)
      expect(persisted?.execution.generation).toBe(generation)
      expect(persisted?.execution.runtimeId).toBeUndefined()
      expect(persisted?.execution.runId).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('persists dm correlation against the latest generation when continuity still points at an older generation', async () => {
    const scopeRef = 'agent:clod:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const now = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.insert({
        hostSessionId: 'hsid-dm-correlation-gen-1',
        scopeRef,
        laneRef: 'default',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-dm-correlation-gen-4',
        scopeRef,
        laneRef: 'default',
        generation: 4,
        status: 'active',
        priorHostSessionId: 'hsid-dm-correlation-gen-1',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.continuities.upsert({
        scopeRef,
        laneRef: 'default',
        activeHostSessionId: 'hsid-dm-correlation-gen-1',
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'correlate against current generation',
      createIfMissing: false,
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const persisted = verifyDb.messages.getById(dm.request.messageId)
      expect(persisted).not.toBeUndefined()
      expect(persisted?.execution.sessionRef).toBe(sessionRef)
      expect(persisted?.execution.hostSessionId).toBe('hsid-dm-correlation-gen-4')
      expect(persisted?.execution.generation).toBe(4)
      expect(persisted?.execution.runtimeId).toBeUndefined()
      expect(persisted?.execution.runId).toBeUndefined()
    } finally {
      verifyDb.close()
    }
  })

  it('fails closed for openai nonInteractive dm when the broker is not admitted', async () => {
    await restartServer({ headlessCodexBrokerEnabled: false })
    const fakeCodex = await installFakeCodex('fake-codex-dm-fallback')

    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef: 'agent:clod:project:agent-spaces/lane:main' },
      body: 'fallback to headless transport',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'nonInteractive',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(dmRes.status).toBe(200)

    const dm = (await dmRes.json()) as SemanticDmResponse
    expect(dm.execution).toBeUndefined()
    expect(dm.request.execution.state).toBe('failed')
    expect(dm.request.execution.errorMessage).toContain('headless legacy execution is unavailable')

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.listByHostSessionId(String(dm.request.execution.hostSessionId))).toEqual(
        []
      )
    } finally {
      db.close()
    }

    const execLog = await readFile(fakeCodex.logPath, 'utf-8').catch(() => '')
    expect(execLog).not.toContain('app-server:')
  })

  it('semantic turn handoff fails closed when headless codex would use legacy exec', async () => {
    await restartServer({ headlessCodexBrokerEnabled: false })
    const fakeCodex = await installFakeCodex('fake-codex-turn-handoff')
    const sessionRef = 'agent:handoff:project:agent-spaces/lane:main'

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'handoff to detached turn',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(handoffRes.status).toBe(503)
    const errorBody = (await handoffRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(errorBody.error?.code).toBe('runtime_unavailable')
    expect(errorBody.error?.message).toContain('headless legacy execution is unavailable')

    const requestListRes = await fixture.postJson('/v1/messages/query', {
      phases: ['request'],
    })
    expect(requestListRes.status).toBe(200)
    const requestList = (await requestListRes.json()) as ListMessagesResponse
    const request = requestList.messages.find(
      (message) => message.body === 'handoff to detached turn'
    )
    expect(request?.execution.state).toBe('failed')
    expect(request?.execution.errorMessage).toContain('headless legacy execution is unavailable')
  })

  it('semantic turn handoff stales live non-broker tmux instead of literal delivery', async () => {
    await restartServer({ headlessCodexBrokerEnabled: false })
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()
    const fakeCodex = await installFakeCodex('fake-codex-turn-handoff-live-tmux')

    const scopeRef = 'agent:handoff-live-tmux:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-handoff-live-tmux-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        tmuxJson: pane,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'must be sent literally',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
        launch: {
          pathPrepend: [fakeCodex.binDir],
        },
      },
    })
    expect(handoffRes.status).toBe(503)
    const errorBody = (await handoffRes.json()) as {
      error?: { code?: string; message?: string }
    }
    expect(errorBody.error?.code).toBe('runtime_unavailable')
    expect(errorBody.error?.message).toContain('headless legacy execution is unavailable')

    const captured = await tmux.capture(pane.paneId)
    expect(captured).not.toContain('must be sent literally')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }

    const codexLog = await readFile(fakeCodex.logPath, 'utf8').catch(() => '')
    expect(codexLog).not.toContain('app-server:')
  })

  it('semantic turn handoff dispatches through live broker tmux runtimes', async () => {
    const scopeRef = 'agent:handoff-live-broker:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-live-broker-${Date.now()}`
    const operationId = `op-handoff-live-broker-${Date.now()}`
    const invocationId = `inv-handoff-live-broker-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-live-broker',
        startRequestHash: 'sha256:req-handoff-live-broker',
        selectedProfileHash: 'sha256:prof-handoff-live-broker',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dispatchedInputs: any[] = []
    ;(server as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: any) => {
        dispatchedInputs.push(request)
        return { ok: true, response: { accepted: true } }
      },
    })

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'must go through broker input',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse
    expect(handoff.runtimeId).toBe(runtimeId)
    expect(dispatchedInputs).toHaveLength(1)
    expect(dispatchedInputs[0]).toMatchObject({
      runtimeId,
      input: {
        kind: 'user',
        metadata: { runId: handoff.runId },
      },
    })
    expect(dispatchedInputs[0].input.inputId).toStartWith('input-')
    expect(dispatchedInputs[0].input.content[0].text).toContain('must go through broker input')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(handoff.runId)
      const invocation = verifyDb.brokerInvocations.getByInvocationId(invocationId)
      const request = verifyDb.messages.getById(handoff.messageId)
      expect(run?.runtimeId).toBe(runtimeId)
      expect(run?.invocationId).toBe(invocationId)
      expect(run?.dispatchedInputId).toBe(dispatchedInputs[0].input.inputId)
      expect(invocation?.runId).toBe(handoff.runId)
      expect(request?.execution).toMatchObject({
        state: 'started',
        mode: 'interactive',
        runtimeId,
        runId: handoff.runId,
        transport: 'tmux',
      })
    } finally {
      verifyDb.close()
    }
  })

  it('semantic turn handoff does not synthesize completion for broker tmux reply DMs', async () => {
    const scopeRef = 'agent:handoff-live-broker-reply:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-live-broker-reply-${Date.now()}`
    const operationId = `op-handoff-live-broker-reply-${Date.now()}`
    const invocationId = `inv-handoff-live-broker-reply-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-live-broker-reply',
        startRequestHash: 'sha256:req-handoff-live-broker-reply',
        selectedProfileHash: 'sha256:prof-handoff-live-broker-reply',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }
    ;(server as any).getHarnessBrokerController = () => ({
      dispatchInput: async () => ({ ok: true, response: { accepted: true } }),
    })

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'broker reply should wait for broker completion',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse

    const replyRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'session', sessionRef },
      to: { kind: 'entity', entity: 'human' },
      body: 'broker reply body',
      replyToMessageId: handoff.messageId,
    })
    expect(replyRes.status).toBe(200)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(handoff.runId)
      const completed = verifyDb.hrcEvents.listByRun(handoff.runId, {
        eventKind: 'turn.completed',
      })
      const responseList = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })

      expect(run?.status).toBe('accepted')
      expect(run?.completedAt).toBeUndefined()
      expect(completed).toHaveLength(0)
      expect(responseList).toHaveLength(1)
      expect(responseList[0]?.execution).toMatchObject({
        state: 'completed',
        mode: 'interactive',
        runtimeId,
        runId: handoff.runId,
        transport: 'tmux',
      })
    } finally {
      verifyDb.close()
    }
  })

  it('semantic turn handoff persists the response after a daemon restart (T-04025 durable finalizer recovery)', async () => {
    const scopeRef = 'agent:handoff-durable-recovery:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-durable-recovery-${Date.now()}`
    const operationId = `op-handoff-durable-recovery-${Date.now()}`
    const invocationId = `inv-handoff-durable-recovery-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'codex-cli-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-handoff-durable-recovery',
        startRequestHash: 'sha256:req-handoff-durable-recovery',
        selectedProfileHash: 'sha256:prof-handoff-durable-recovery',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }
    ;(server as any).getHarnessBrokerController = () => ({
      dispatchInput: async () => ({ ok: true, response: { accepted: true } }),
    })

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'response must survive a daemon restart',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          dryRun: true,
        },
        harness: {
          provider: 'openai',
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse

    // The daemon that dispatched the turn restarts mid-turn: the replacement
    // instance starts with an empty in-memory turnResponseFinalizers map.
    await restartServer({})

    // The durable broker finishes the turn after the restart: buffered output
    // plus a projected turn.completed lifecycle event through notifyEvent.
    const completionDb = openHrcDatabase(fixture.dbPath)
    let completedEvent: ReturnType<typeof appendHrcEvent>
    try {
      // The test fixture has no live broker socket, so startup reconciliation
      // fails the in-flight run. In production the durable broker is preserved
      // (controllerKind + socket presence) and the run stays running — restore
      // that state so the completion models the preserved-broker reality.
      completionDb.runs.update(handoff.runId, {
        status: 'running',
        updatedAt: fixture.now(),
      })
      completionDb.runtimeBuffers.append({
        runtimeId,
        runId: handoff.runId,
        chunkSeq: 0,
        text: 'durable response body',
        createdAt: fixture.now(),
      })
      completedEvent = appendHrcEvent(completionDb, 'turn.completed', {
        ts: fixture.now(),
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation,
        runId: handoff.runId,
        runtimeId,
        transport: 'tmux',
        payload: { success: true, transport: 'tmux', source: 'broker' },
      })
    } finally {
      completionDb.close()
    }
    ;(server as any).notifyEvent(completedEvent)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const responses = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })
      expect(responses).toHaveLength(1)
      expect(responses[0]?.body).toBe('durable response body')
      expect(responses[0]?.execution).toMatchObject({
        state: 'completed',
        runId: handoff.runId,
        transport: 'tmux',
      })
      const request = verifyDb.messages.getById(handoff.messageId)
      expect(request?.execution.state).toBe('completed')

      // Replayed/duplicate completion events must not double-insert.
      ;(server as any).notifyEvent(completedEvent)
      const responsesAfterReplay = verifyDb.messages.query({
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })
      expect(responsesAfterReplay).toHaveLength(1)
    } finally {
      verifyDb.close()
    }
  })

  it('turn completion does not synthesize a response for non-handoff requests after restart', async () => {
    const scopeRef = 'agent:dm-no-recover:project:agent-spaces'
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runId = `run-dm-no-recover-${Date.now()}`

    const db = openHrcDatabase(fixture.dbPath)
    let requestMessageId: string
    try {
      // A DM-path request: same durable shape as a handoff request but without
      // the semanticTurnHandoff metadata marker.
      const record = db.messages.insert({
        messageId: `msg-dm-no-recover-${Date.now()}`,
        kind: 'dm',
        phase: 'request',
        from: { kind: 'entity', entity: 'human' },
        to: { kind: 'session', sessionRef: `${scopeRef}/lane:main` },
        body: 'dm request answered by an explicit reply DM',
        execution: { state: 'started', mode: 'interactive', runId },
      })
      requestMessageId = record.messageId
    } finally {
      db.close()
    }

    await restartServer({})

    const completionDb = openHrcDatabase(fixture.dbPath)
    let completedEvent: ReturnType<typeof appendHrcEvent>
    try {
      completedEvent = appendHrcEvent(completionDb, 'turn.completed', {
        ts: fixture.now(),
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation,
        runId,
        transport: 'tmux',
        payload: { success: true, transport: 'tmux', source: 'broker' },
      })
    } finally {
      completionDb.close()
    }
    ;(server as any).notifyEvent(completedEvent)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const responses = verifyDb.messages.query({
        thread: { rootMessageId: requestMessageId },
        phases: ['response'],
      })
      expect(responses).toHaveLength(0)
    } finally {
      verifyDb.close()
    }
  })

  it('semantic turn handoff stales live non-broker Ghostty instead of literal delivery', async () => {
    await restartServer({ claudeCodeTmuxBrokerEnabled: false })
    const scopeRef = 'agent:handoff-live-ghostty:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:default`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-handoff-live-ghostty-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'ghostty',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        surfaceJson: {
          kind: 'ghostty',
          surfaceId: 'surface-live-ghostty',
          title: 'claude-code: handoff-live-ghostty',
          createdBy: 'ghostmux',
        },
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const handoffRes = await fixture.postJson('/v1/messages/turn-handoff', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'must be sent to ghostty literally',
      runtimeIntent: {
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
          interactive: false,
        },
        execution: {
          preferredMode: 'headless',
        },
      },
    })
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse
    expect(handoff.runtimeId).not.toBe(runtimeId)

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }

    const requestListRes = await fixture.postJson('/v1/messages/query', {
      thread: { rootMessageId: handoff.messageId },
      phases: ['request'],
    })
    expect(requestListRes.status).toBe(200)
    const requestList = (await requestListRes.json()) as ListMessagesResponse
    const request = requestList.messages.find(
      (message) => message.body === 'must be sent to ghostty literally'
    )
    expect(request?.execution.runtimeId).not.toBe(runtimeId)
    expect(request?.execution.transport).not.toBe('ghostty')
  })

  it('stales live non-broker tmux dm targets instead of injecting reply hints', async () => {
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()

    const scopeRef = 'agent:clod:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-live-dm-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson: pane,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: { kind: 'entity', entity: 'human' },
      to: { kind: 'session', sessionRef },
      body: 'preserve markdown literally',
    })
    expect(dmRes.status).toBe(200)

    await dmRes.json()

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(captured).not.toContain('reply_cmd if reply requested:')
    expect(compactCapture).not.toContain('hrcchat dm human --reply-to')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }
  })

  it('stales live non-broker tmux lane targets instead of injecting reply hints', async () => {
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()

    const recipientScopeRef = 'agent:cody:project:agent-spaces:task:T-09999'
    const recipientSessionRef = `${recipientScopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(recipientScopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-live-dm-reply-lane-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef: recipientScopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        tmuxJson: pane,
        supportsInflightInput: false,
        adopted: false,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dmRes = await fixture.postJson('/v1/messages/dm', {
      from: {
        kind: 'session',
        sessionRef: 'agent:clod:project:agent-spaces:task:T-01128/lane:repair',
      },
      to: { kind: 'session', sessionRef: recipientSessionRef },
      body: 'preserve the sender lane',
    })
    expect(dmRes.status).toBe(200)

    await dmRes.json()

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(compactCapture).not.toContain('hrcchat dm clod@agent-spaces:T-01128~repair')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      expect(verifyDb.runtimes.getByRuntimeId(runtimeId)?.status).toBe('stale')
    } finally {
      verifyDb.close()
    }
  })

  it('appends semantic turn.user_prompt for Codex tmux literal sends', async () => {
    const tmux = new TmuxManager(fixture.tmuxSocketPath)
    await tmux.initialize()

    const scopeRef = 'agent:larry:project:agent-spaces:task:T-01156-codex-literal'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const pane = await tmux.ensurePane(hostSessionId, 'fresh_pty')
    const runtimeId = `rt-codex-literal-${Date.now()}`
    const launchId = `launch-codex-literal-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        tmuxJson: pane,
        supportsInflightInput: false,
        adopted: false,
        launchId,
        lastActivityAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const res = await fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: 'What is 3+4?',
      enter: true,
    })
    expect(res.status).toBe(200)

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(50)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('What is 3+4?')) {
        break
      }
    }
    expect(captured).toContain('What is 3+4?')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const turnPrompts = verifyDb.hrcEvents.listByScope(scopeRef, {
        eventKind: 'turn.user_prompt',
      })
      expect(turnPrompts).toHaveLength(1)
      expect(turnPrompts[0]?.launchId).toBe(launchId)
      expect(turnPrompts[0]?.transport).toBe('tmux')
      expect(turnPrompts[0]?.payload).toEqual({
        type: 'message_end',
        message: {
          role: 'user',
          content: 'What is 3+4?',
        },
      })
    } finally {
      verifyDb.close()
    }
  })

  it('routes split literal sends for broker tmux runtimes through broker input', async () => {
    const scopeRef = 'agent:literal-live-broker:project:agent-spaces'
    const sessionRef = `${scopeRef}/lane:main`
    const { hostSessionId, generation } = await fixture.resolveSession(scopeRef)
    const runtimeId = `rt-literal-live-broker-${Date.now()}`
    const operationId = `op-literal-live-broker-${Date.now()}`
    const invocationId = `inv-literal-live-broker-${Date.now()}`
    const timestamp = fixture.now()

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'default',
        generation,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.1',
        brokerDriver: 'claude-code-tmux',
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: 'sha256:spec-literal-live-broker',
        startRequestHash: 'sha256:req-literal-live-broker',
        selectedProfileHash: 'sha256:prof-literal-live-broker',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } finally {
      db.close()
    }

    const dispatchedInputs: any[] = []
    ;(server as any).getHarnessBrokerController = () => ({
      dispatchInput: async (request: any) => {
        dispatchedInputs.push(request)
        return { ok: true, response: { accepted: true } }
      },
    })

    const pasteRes = await fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: 'What is 2+2?',
      enter: false,
    })
    expect(pasteRes.status).toBe(200)
    expect(dispatchedInputs).toHaveLength(0)

    const enterRes = await fixture.postJson('/v1/literal-input/by-selector', {
      selector: { sessionRef },
      text: '',
      enter: true,
    })
    expect(enterRes.status).toBe(200)
    const enterBody = await enterRes.json()
    expect(enterBody.runtimeId).toBe(runtimeId)
    expect(enterBody.runId).toStartWith('run-')
    expect(enterBody.status).toBe('started')

    expect(dispatchedInputs).toHaveLength(1)
    expect(dispatchedInputs[0]).toMatchObject({
      runtimeId,
      input: {
        kind: 'user',
        metadata: { runId: enterBody.runId },
      },
    })
    expect(dispatchedInputs[0].input.inputId).toStartWith('input-')
    expect(dispatchedInputs[0].input.content[0].text).toBe('What is 2+2?')

    const verifyDb = openHrcDatabase(fixture.dbPath)
    try {
      const run = verifyDb.runs.getByRunId(enterBody.runId)
      const invocation = verifyDb.brokerInvocations.getByInvocationId(invocationId)
      expect(run?.runtimeId).toBe(runtimeId)
      expect(run?.invocationId).toBe(invocationId)
      expect(run?.dispatchedInputId).toBe(dispatchedInputs[0].input.inputId)
      expect(invocation?.runId).toBe(enterBody.runId)

      const literalEvents = verifyDb.hrcEvents.listByScope(scopeRef, {
        eventKind: 'target.literal-input',
      })
      expect(literalEvents).toHaveLength(2)
      expect(literalEvents[0]?.runId).toBeUndefined()
      expect(literalEvents[0]?.payload).toMatchObject({
        delivery: 'broker-buffered-literal',
        enter: false,
      })
      expect(literalEvents[1]?.runId).toBe(enterBody.runId)
      expect(literalEvents[1]?.payload).toMatchObject({
        delivery: 'broker-dispatch-input',
        enter: true,
      })
    } finally {
      verifyDb.close()
    }
  })
})
