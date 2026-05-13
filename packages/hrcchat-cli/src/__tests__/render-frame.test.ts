import { describe, expect, test } from 'bun:test'
import { type RenderFrame, type SessionEventEnvelope, SessionEventsManager } from 'hrc-frame-render'

import { renderFrameToDiscordContent } from '../../../gateway-discord/src/render.js'
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

describe('terminal RenderFrame sink snapshots', () => {
  test('assistant message accumulation renders terminal tree output', () => {
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

    expect(renderFrameToTerminalText(frame, { color: false, width: 80 })).toBe(
      ['⚙️ Summarize status', 'running', '└─ Hello world.', ''].join('\n')
    )
  })

  test('tool call and result render tool emoji, preview, and output snippet', () => {
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

    expect(renderFrameToTerminalText(frame, { color: false, width: 80 })).toBe(
      [
        '⚙️ Use a tool',
        'running',
        '├─ 💻 shell: echo hi',
        '│  ```',
        '│  hello',
        '│  ```',
        '└─ ...',
        '',
      ].join('\n')
    )
  })

  test('turn-completed frame renders final status line and assistant text', () => {
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

    expect(renderFrameToTerminalText(frame, { color: false, width: 80 })).toBe(
      ['✅ Finish turn', 'completed', '└─ done.', ''].join('\n')
    )
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

    expect(renderFrameToTerminalText(frame, { color: false, width: 80 })).toBe(
      [
        'APPROVAL REQUIRED',
        '🔐 Dangerous command',
        'awaiting_permission',
        '├─ ```bash',
        '│  rm -rf /tmp/example',
        '│  ```',
        '└─ Actions:',
        '   - approve: Approve once (allow)',
        '   - deny: Deny (deny)',
        '',
      ].join('\n')
    )
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

test('terminal tool emoji and preview content match gateway-discord for the same RenderFrame', () => {
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
  const discord = renderFrameToDiscordContent(frame, 2000)

  expect(terminal).toContain('📖 Read: packages/hrcchat-cli/src/render-frame.ts')
  expect(discord).toContain('📖 Read: packages/hrcchat-cli/src/render-frame.ts')
})
