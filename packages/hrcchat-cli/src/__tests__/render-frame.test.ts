import { describe, expect, test } from 'bun:test'
import { type RenderFrame, type SessionEventEnvelope, SessionEventsManager } from 'hrc-frame-render'

import {
  renderFrameToNdjsonLine,
  renderFrameToTerminalText,
  resolveRenderFrameSinkFormat,
} from '../render-frame.js'

const SESSION_REF = 'agent:cody:project:agent-spaces/lane:main'
const PROJECT_ID = 'agent-spaces'
const RUN_ID = 'run-terminal-render'

function envelope(
  seq: number,
  event: SessionEventEnvelope['event'],
  runId: string | undefined = RUN_ID
): SessionEventEnvelope {
  return {
    sessionRef: SESSION_REF,
    projectId: PROJECT_ID,
    seq,
    runId,
    event,
  }
}

function collectFrames(events: SessionEventEnvelope[]): RenderFrame[] {
  const frames: RenderFrame[] = []
  const manager = new SessionEventsManager(
    'hrcchat-test',
    (_sessionRef, _projectId, _runId, frame) => {
      frames.push({ ...frame, updatedAt: 0 })
    }
  )
  const originalLog = console.log
  console.log = () => {}
  try {
    manager.subscribe(SESSION_REF, PROJECT_ID)
    for (const item of events) {
      manager.receive(item)
    }
  } finally {
    console.log = originalLog
  }
  return frames
}

function lastFrame(events: SessionEventEnvelope[]): RenderFrame {
  const frame = collectFrames(events).at(-1)
  if (!frame) {
    throw new Error('expected at least one frame')
  }
  return frame
}

describe('terminal RenderFrame sink output', () => {
  test('assistant message renders as final answer (protagonist), not as tree leaf', () => {
    const frame = lastFrame([
      envelope(1, {
        type: 'run_queued',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        queuedAt: 1,
        input: { content: 'Summarize status' },
      }),
      envelope(2, { type: 'run_started', runId: RUN_ID, projectId: PROJECT_ID, startedAt: 2 }),
      envelope(3, { type: 'message_update', textDelta: 'Hello ' } as SessionEventEnvelope['event']),
      envelope(4, { type: 'message_update', textDelta: 'world.' } as SessionEventEnvelope['event']),
    ])

    const out = renderFrameToTerminalText(frame, { color: false, width: 80 })
    expect(out).toContain('Summarize status')
    expect(out).toContain('Hello world.')
    // No tree prefix on the answer
    expect(out).not.toMatch(/└─\s*Hello world\./)
    expect(out).not.toMatch(/├─\s*Hello world\./)
  })

  test('tool call/result renders under the ┊ activity rail with tool emoji and output', () => {
    const frame = lastFrame([
      envelope(1, {
        type: 'run_queued',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        queuedAt: 1,
        input: { content: 'Use a tool' },
      }),
      envelope(2, { type: 'run_started', runId: RUN_ID, projectId: PROJECT_ID, startedAt: 2 }),
      envelope(3, {
        type: 'tool_execution_start',
        toolUseId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'echo hi' },
      } as SessionEventEnvelope['event']),
      envelope(4, {
        type: 'tool_execution_end',
        toolUseId: 'tool-1',
        result: { content: [{ type: 'text', text: 'hello' }] },
        isError: false,
      } as SessionEventEnvelope['event']),
    ])

    const out = renderFrameToTerminalText(frame, { color: false, width: 80 })
    expect(out).toContain('Use a tool')
    expect(out).toContain('┊')
    expect(out).toContain('💻 shell')
    expect(out).toContain('echo hi')
    expect(out).toContain('↳ hello')
  })

  test('turn-completed frame renders final answer as protagonist with footer status', () => {
    const frame = lastFrame([
      envelope(1, {
        type: 'run_queued',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        queuedAt: 1,
        input: { content: 'Finish turn' },
      }),
      envelope(2, { type: 'run_started', runId: RUN_ID, projectId: PROJECT_ID, startedAt: 2 }),
      envelope(3, {
        type: 'run_completed',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        completedAt: 3,
        finalOutput: 'done.',
      }),
    ])

    const out = renderFrameToTerminalText(frame, { color: false, width: 80 })
    expect(out).toContain('Finish turn')
    expect(out).toContain('done.')
    expect(out).toContain('done')
  })

  test('permission request renders approval header and action details without prompting', () => {
    const frame = lastFrame([
      envelope(1, {
        type: 'run_queued',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        queuedAt: 1,
        input: { content: 'Dangerous command' },
      }),
      envelope(2, { type: 'run_started', runId: RUN_ID, projectId: PROJECT_ID, startedAt: 2 }),
      envelope(3, {
        type: 'permission_request',
        requestId: 'perm-1',
        runId: RUN_ID,
        projectId: PROJECT_ID,
        toolUseId: 'tool-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/example' },
        actions: [
          { id: 'allow', kind: 'approve', label: 'Approve once' },
          { id: 'deny', kind: 'deny', label: 'Deny', style: 'danger' },
        ],
        requestedAt: 3,
      }),
    ])

    const out = renderFrameToTerminalText(frame, { color: false, width: 80 })
    expect(out).toContain('Dangerous command')
    expect(out).toContain('approval required')
    expect(out).toContain('Approve once')
    expect(out).toContain('Deny')
    expect(out).toContain('(allow)')
    expect(out).toContain('(deny)')
    expect(out).toContain('rm -rf /tmp/example')
  })

  test('scopeHandle is included in the editorial header label', () => {
    const frame: RenderFrame = {
      runId: 'run-abcdef1234567890',
      projectId: PROJECT_ID,
      phase: 'progress',
      blocks: [],
      updatedAt: 0,
    }
    const out = renderFrameToTerminalText(frame, {
      color: false,
      scopeHandle: 'cody@agent-spaces:T-01435',
    })
    expect(out).toContain('cody@agent-spaces:T-01435')
    expect(out).toMatch(/run abcdef12…7890/)
  })

  test('titleFallback is used when frame.title contains only the phase emoji', () => {
    const frame: RenderFrame = {
      runId: RUN_ID,
      projectId: PROJECT_ID,
      phase: 'progress',
      title: '⚙️ ',
      blocks: [],
      updatedAt: 0,
    }
    const out = renderFrameToTerminalText(frame, {
      color: false,
      titleFallback: 'list files in repo',
    })
    expect(out).toContain('list files in repo')
  })
})

describe('RenderFrame sink format selection', () => {
  test('defaults to terminal for TTY and ndjson for non-TTY', () => {
    expect(resolveRenderFrameSinkFormat({ isTTY: true })).toBe('terminal')
    expect(resolveRenderFrameSinkFormat({ isTTY: false })).toBe('ndjson')
  })

  test('explicit formats override TTY detection', () => {
    expect(resolveRenderFrameSinkFormat({ format: 'ndjson', isTTY: true })).toBe('ndjson')
    expect(resolveRenderFrameSinkFormat({ format: 'json', isTTY: true })).toBe('ndjson')
    expect(resolveRenderFrameSinkFormat({ format: 'tree', isTTY: false })).toBe('terminal')
    expect(resolveRenderFrameSinkFormat({ format: 'compact', isTTY: false })).toBe('terminal')
  })
})

test('ndjson sink emits one machine-readable event line per frame', () => {
  const line = renderFrameToNdjsonLine({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    phase: 'progress',
    title: '⚙️ Use a tool',
    statusLine: 'running',
    blocks: [
      { t: 'tool', toolName: 'Read', summary: '`README.md`', input: { file_path: 'README.md' } },
    ],
    updatedAt: 0,
  })

  expect(line.endsWith('\n')).toBe(true)
  expect(JSON.parse(line)).toEqual({
    type: 'render_frame',
    version: 1,
    runId: RUN_ID,
    projectId: PROJECT_ID,
    phase: 'progress',
    title: '⚙️ Use a tool',
    statusLine: 'running',
    updatedAt: 0,
    blocks: [
      { t: 'tool', toolName: 'Read', summary: '`README.md`', input: { file_path: 'README.md' } },
    ],
  })
})

test('terminal tool emoji and preview content render as expected', () => {
  const frame: RenderFrame = {
    runId: RUN_ID,
    projectId: PROJECT_ID,
    phase: 'progress',
    blocks: [
      {
        t: 'tool',
        toolName: 'Read',
        summary: '`packages/hrcchat-cli/src/render-frame.ts`',
        input: { file_path: 'packages/hrcchat-cli/src/render-frame.ts' },
      },
    ],
    updatedAt: 0,
  }

  const terminal = renderFrameToTerminalText(frame, { color: false, width: 100 })
  expect(terminal).toContain('📖 Read: packages/hrcchat-cli/src/render-frame.ts')
})
