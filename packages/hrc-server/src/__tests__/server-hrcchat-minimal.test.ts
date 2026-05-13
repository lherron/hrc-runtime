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

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
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

  it('uses headless transport for openai nonInteractive dm fallback', async () => {
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
          bundle: { kind: 'agent-default' },
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
    expect(dm.execution?.transport).toBe('headless')
    expect(dm.execution?.mode).toBe('headless')
    expect(dm.execution?.status).toBe('started')
    expect(dm.execution?.runtimeId).toBeString()
    expect(dm.execution?.continuationUpdated).toBe(false)

    const db = openHrcDatabase(fixture.dbPath)
    try {
      const runtime = db.runtimes.getByRuntimeId(String(dm.execution?.runtimeId))
      expect(runtime).not.toBeNull()
      expect(runtime?.transport).toBe('headless')
      expect(runtime?.provider).toBe('openai')
      expect(runtime?.tmuxJson).toBeUndefined()
    } finally {
      db.close()
    }

    let execLog = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        execLog = await readFile(fakeCodex.logPath, 'utf-8')
      } catch {
        execLog = ''
      }
      if (execLog.includes('app-server:')) {
        break
      }
      await Bun.sleep(100)
    }

    expect(execLog).toContain('app-server:')
  })

  it('semantic turn handoff creates request immediately, returns replay filters, and finalizes response', async () => {
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
          bundle: { kind: 'agent-default' },
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
    expect(handoffRes.status).toBe(200)

    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse
    expect(handoff.messageId).toStartWith('msg-')
    expect(handoff.sessionRef).toBe(sessionRef)
    expect(handoff.scopeRef).toBe('agent:handoff:project:agent-spaces')
    expect(handoff.laneRef).toBe('main')
    expect(handoff.hostSessionId).toBeString()
    expect(handoff.runtimeId).toBeString()
    expect(handoff.runId).toBeString()
    expect(handoff.generation).toBe(1)
    expect(handoff.fromSeq).toBeGreaterThan(0)

    const requestListRes = await fixture.postJson('/v1/messages/query', {
      thread: { rootMessageId: handoff.messageId },
      phases: ['request'],
    })
    expect(requestListRes.status).toBe(200)
    const requestList = (await requestListRes.json()) as ListMessagesResponse
    expect(requestList.messages).toHaveLength(1)
    expect(requestList.messages[0]?.messageId).toBe(handoff.messageId)
    expect(requestList.messages[0]?.execution.runId).toBe(handoff.runId)

    const acceptedRes = await fixture.fetchSocket(
      `/v1/events?fromSeq=${handoff.fromSeq}&runId=${encodeURIComponent(handoff.runId)}&eventKind=turn.accepted`
    )
    expect(acceptedRes.status).toBe(200)
    const acceptedText = await acceptedRes.text()
    const accepted = acceptedText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(accepted).toHaveLength(1)
    expect(handoff.fromSeq).toBeLessThanOrEqual(accepted[0].hrcSeq)

    let responseList: ListMessagesResponse = { messages: [] }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const responseListRes = await fixture.postJson('/v1/messages/query', {
        thread: { rootMessageId: handoff.messageId },
        phases: ['response'],
      })
      expect(responseListRes.status).toBe(200)
      responseList = (await responseListRes.json()) as ListMessagesResponse
      if (responseList.messages.length > 0) {
        break
      }
      await Bun.sleep(100)
    }

    expect(responseList.messages).toHaveLength(1)
    expect(responseList.messages[0]?.replyToMessageId).toBe(handoff.messageId)
    expect(responseList.messages[0]?.body).toBe('ok')
    expect(responseList.messages[0]?.execution.runId).toBe(handoff.runId)
    expect(responseList.messages[0]?.execution.state).toBe('completed')
  })

  it('semantic turn handoff dispatches instead of literal-delivering when a live tmux runtime exists', async () => {
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
      body: 'must not be sent literally',
      runtimeIntent: {
        placement: {
          agentRoot: '/tmp/agent',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
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
    expect(handoffRes.status).toBe(200)
    const handoff = (await handoffRes.json()) as SemanticTurnHandoffResponse
    expect(handoff.runId).toBeString()
    expect(handoff.runtimeId).not.toBe(runtimeId)

    await Bun.sleep(300)
    const captured = await tmux.capture(pane.paneId)
    expect(captured).not.toContain('must not be sent literally')

    const eventsRes = await fixture.fetchSocket(
      `/v1/events?fromSeq=${handoff.fromSeq}&runId=${encodeURIComponent(handoff.runId)}&eventKind=turn.accepted`
    )
    expect(eventsRes.status).toBe(200)
    expect((await eventsRes.text()).trim()).toContain('"turn.accepted"')
  })

  it('injects a heredoc-based reply hint for live tmux dm delivery', async () => {
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

    const dm = (await dmRes.json()) as SemanticDmResponse

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(captured).toContain('reply_cmd if reply requested:')
    expect(compactCapture).toContain(
      `hrcchat dm human --reply-to ${dm.request.messageId} - <<'__HRC_REPLY__'`
    )
    expect(captured).toContain('<your reply>')
    expect(captured).not.toContain('"<your reply>"')
  })

  it('includes non-main sender lanes in live tmux reply hints', async () => {
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

    const dm = (await dmRes.json()) as SemanticDmResponse

    let captured = ''
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await Bun.sleep(100)
      captured = await tmux.capture(pane.paneId)
      if (captured.includes('reply_cmd if reply requested:')) {
        break
      }
    }

    const compactCapture = captured.replaceAll('\n', '')

    expect(compactCapture).toContain(
      `hrcchat dm clod@agent-spaces:T-01128~repair --reply-to ${dm.request.messageId} - <<'__HRC_REPLY__'`
    )
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
})
