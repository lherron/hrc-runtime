import { describe, expect, test } from 'bun:test'

import { type RunState, SessionEventsManager, runStateToFrame } from '../session-events-manager.js'
import type { RenderFrame, SessionEventEnvelope } from '../types.js'

const TEST_SESSION = 'agent:larry:project:test-suite/lane:main'

function receive(
  manager: SessionEventsManager,
  envelope: Omit<SessionEventEnvelope, 'sessionRef'>
): void {
  manager.receive({
    sessionRef: TEST_SESSION,
    ...envelope,
  })
}

describe('SessionEventsManager — adapter + projection', () => {
  test('tool_call→tool_result pairing produces correct RenderFrame blocks', () => {
    let lastFrame: RenderFrame | undefined
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, frame) => {
      lastFrame = frame
    })

    manager.subscribe(TEST_SESSION, 'test-proj')

    // Start a run
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    // Tool call
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 2,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'bun test' },
      },
    })

    expect(lastFrame).toBeDefined()
    expect(lastFrame!.phase).toBe('progress')
    const toolBlocks = lastFrame!.blocks.filter((b) => b.t === 'tool')
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]).toMatchObject({
      t: 'tool',
      toolName: 'Bash',
      approved: undefined,
    })

    // Tool result
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 3,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        result: { content: [{ type: 'text', text: 'tests passed' }] },
      },
    })

    expect(lastFrame).toBeDefined()
    const completedTool = lastFrame!.blocks.filter((b) => b.t === 'tool')
    expect(completedTool).toHaveLength(1)
    expect(completedTool[0]).toMatchObject({
      t: 'tool',
      toolName: 'Bash',
      output: 'tests passed',
      approved: true,
    })
  })

  test('assistant message accumulation across message_start → message_update → message_end', () => {
    let lastFrame: RenderFrame | undefined
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, frame) => {
      lastFrame = frame
    })

    manager.subscribe(TEST_SESSION, 'test-proj')

    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    // message_start
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 2,
      event: {
        type: 'message_start',
        messageId: 'msg-1',
        message: { role: 'assistant', content: '' },
      },
    })

    // message_update with textDelta
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 3,
      event: { type: 'message_update', messageId: 'msg-1', textDelta: 'Hello ' },
    })

    expect(lastFrame).toBeDefined()
    const mdBlock1 = lastFrame!.blocks.find((b) => b.t === 'markdown')
    expect(mdBlock1).toMatchObject({ t: 'markdown', md: 'Hello ' })

    // Another textDelta
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 4,
      event: { type: 'message_update', messageId: 'msg-1', textDelta: 'World' },
    })

    const mdBlock2 = lastFrame!.blocks.find((b) => b.t === 'markdown')
    expect(mdBlock2).toMatchObject({ t: 'markdown', md: 'Hello World' })

    // message_end
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 5,
      event: {
        type: 'message_end',
        messageId: 'msg-1',
        message: { role: 'assistant', content: 'Hello World' },
      },
    })

    const mdBlock3 = lastFrame!.blocks.find((b) => b.t === 'markdown')
    expect(mdBlock3).toMatchObject({ t: 'markdown', md: 'Hello World' })
  })

  test('turn-completed terminal event sets phase to final', () => {
    let lastFrame: RenderFrame | undefined
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, frame) => {
      lastFrame = frame
    })

    manager.subscribe(TEST_SESSION, 'test-proj')

    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 2,
      event: {
        type: 'turn_end',
        payload: { finalOutput: 'All done!' },
      },
    })

    expect(lastFrame).toBeDefined()
    expect(lastFrame!.phase).toBe('final')
    expect(manager.getRunState(TEST_SESSION, 'run-1')?.status).toBe('completed')

    const mdBlock = lastFrame!.blocks.find((b) => b.t === 'markdown')
    expect(mdBlock).toMatchObject({ t: 'markdown', md: 'All done!' })
  })

  test('ignores explicitly internal events', () => {
    const renders: Array<{ runId: string }> = []
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, runId) => {
      renders.push({ runId })
    })

    manager.subscribe(TEST_SESSION, 'test-proj')
    receive(manager, {
      projectId: 'test-proj',
      seq: 1,
      runId: 'run-internal',
      run: { visibility: 'internal' },
      event: {
        type: 'run_queued',
        runId: 'run-internal',
        projectId: 'test-proj',
        queuedAt: 1,
        input: { content: 'hidden' },
      },
    })

    expect(manager.getRunState(TEST_SESSION, 'run-internal')).toBeUndefined()
    expect(renders).toHaveLength(0)
  })

  test('deduplicates events by seq', () => {
    const renders: Array<{ seq: number }> = []
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, _frame, run) => {
      renders.push({ seq: run.lastSeq })
    })

    manager.subscribe(TEST_SESSION, 'test-proj')
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    // Duplicate seq=1 should be ignored
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'message_update',
        textDelta: 'duplicate should not render',
      },
    })

    expect(renders).toHaveLength(1)
  })

  test('setSinkMetadata stores opaque metadata on run state', () => {
    const manager = new SessionEventsManager('test', () => {})
    manager.subscribe(TEST_SESSION, 'test-proj')

    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    manager.setSinkMetadata(TEST_SESSION, 'run-1', {
      discordMessageId: 'msg-123',
      discordChannelId: 'ch-456',
    })

    const run = manager.getRunState(TEST_SESSION, 'run-1')
    expect(run?.sinkMetadata).toEqual({
      discordMessageId: 'msg-123',
      discordChannelId: 'ch-456',
    })
  })

  test('interleaves assistant segments between tool and notice blocks by arrival seq', () => {
    let lastFrame: RenderFrame | undefined
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, frame) => {
      lastFrame = frame
    })

    manager.subscribe(TEST_SESSION, 'test-proj')
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-mix',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    // text segment A
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 2,
      event: {
        type: 'message_start',
        messageId: 'msg-A',
        message: { role: 'assistant', content: '' },
      },
    })
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 3,
      event: { type: 'message_update', messageId: 'msg-A', textDelta: 'before-tool' },
    })

    // tool 1
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 4,
      event: {
        type: 'tool_execution_start',
        toolUseId: 'tu1',
        toolName: 'Read',
        input: { file_path: '/x' },
      },
    })
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 5,
      event: {
        type: 'tool_execution_end',
        toolUseId: 'tu1',
        toolName: 'Read',
        result: { content: [{ type: 'text', text: 'ok' }] },
      },
    })

    // notice
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 6,
      event: { type: 'notice', level: 'warn', message: 'heads up' },
    })

    // text segment B
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-mix',
      seq: 7,
      event: { type: 'message_update', messageId: 'msg-B', textDelta: 'after-tool' },
    })

    expect(lastFrame).toBeDefined()
    const order = lastFrame!.blocks.map((b) =>
      b.t === 'markdown'
        ? `text:${b.md}`
        : b.t === 'tool'
          ? `tool:${(b as { toolName: string }).toolName}`
          : b.t === 'notice'
            ? `notice:${(b as { message: string }).message}`
            : b.t
    )
    expect(order).toEqual(['text:before-tool', 'tool:Read', 'notice:heads up', 'text:after-tool'])
  })

  test('runStateToFrame produces valid frame from RunState', () => {
    const run: RunState = {
      runId: 'run-1',
      projectId: 'test-proj',
      lastSeq: 5,
      status: 'completed',
      inputContent: 'do something',
      assistantSegments: [{ id: 'seg-1', seq: 3, text: 'I did it' }],
      toolExecutions: [
        {
          toolUseId: 'tu1',
          toolName: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
          seq: 2,
          output: 'file.txt',
        },
      ],
      noticeEntries: [],
    }

    const frame = runStateToFrame(run)
    expect(frame.runId).toBe('run-1')
    expect(frame.projectId).toBe('test-proj')
    expect(frame.phase).toBe('final')
    expect(frame.blocks).toHaveLength(2)
    expect(frame.blocks[0]).toMatchObject({ t: 'tool', toolName: 'Bash' })
    expect(frame.blocks[1]).toMatchObject({ t: 'markdown', md: 'I did it' })
  })

  test('permission request sets phase to permission and includes actions', () => {
    let lastFrame: RenderFrame | undefined
    const manager = new SessionEventsManager('test', (_sessionRef, _pid, _rid, frame) => {
      lastFrame = frame
    })

    manager.subscribe(TEST_SESSION, 'test-proj')
    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 1,
      event: {
        type: 'run_started',
        runId: 'run-1',
        projectId: 'test-proj',
        startedAt: 1,
      },
    })

    receive(manager, {
      projectId: 'test-proj',
      runId: 'run-1',
      seq: 2,
      event: {
        type: 'permission_request',
        requestId: 'req-1',
        runId: 'run-1',
        projectId: 'test-proj',
        toolUseId: 'tu1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        actions: [
          { id: 'approve', kind: 'approve', label: 'Allow' },
          { id: 'deny', kind: 'deny', label: 'Deny', style: 'danger' },
        ],
        requestedAt: 1,
      },
    })

    expect(lastFrame).toBeDefined()
    expect(lastFrame!.phase).toBe('permission')
    expect(lastFrame!.actions).toHaveLength(2)
    expect(lastFrame!.actions![0]).toMatchObject({ kind: 'approve', label: 'Allow' })

    // Code block with the command should be present
    const codeBlock = lastFrame!.blocks.find((b) => b.t === 'code')
    expect(codeBlock).toMatchObject({ t: 'code', lang: 'bash', code: 'rm -rf /' })
  })
})
