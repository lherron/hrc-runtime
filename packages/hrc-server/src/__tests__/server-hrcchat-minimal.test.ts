import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { HrcTargetView, ListMessagesResponse, SemanticDmResponse } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { TmuxManager } from '../tmux'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-hrcchat-minimal-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('hrcchat minimal server routes', () => {
  async function installFakeCodex(dirName: string): Promise<{ binDir: string; logPath: string }> {
    const binDir = join(fixture.tmpDir, dirName)
    const logPath = join(binDir, 'codex.log')
    const scriptPath = join(binDir, 'codex')

    await mkdir(binDir, { recursive: true })
    await writeFile(
      scriptPath,
      `#!/bin/sh
set -eu
log_path=${JSON.stringify(logPath)}
cmd="\${1:-}"
if [ "$cmd" = "exec" ]; then
  printf 'exec:%s\\n' "$*" >> "$log_path"
  printf '{"type":"thread.started","thread_id":"thread-dm"}\\n'
  exit 0
fi
printf 'interactive:%s\\n' "$*" >> "$log_path"
exit 0
`,
      'utf-8'
    )
    await chmod(scriptPath, 0o755)

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
    expect(dm.execution?.runtimeId).toBeString()
    expect(dm.execution?.continuationUpdated).toBe(true)

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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        execLog = await readFile(fakeCodex.logPath, 'utf-8')
      } catch {
        execLog = ''
      }
      if (execLog.includes('exec:')) {
        break
      }
      await Bun.sleep(100)
    }

    expect(execLog).toContain('exec:')
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
