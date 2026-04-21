import { describe, expect, it } from 'bun:test'
import type { HrcLifecycleEvent } from 'hrc-core'

import { createEventsRenderer } from '../events-render.js'

const SCOPE = 'agent:cody:project:agent-spaces:task:discord'
const RT = 'rt-ebaeb014-dd39-4916-8431-2d91112e0547'
const RUN = 'run-31b87e00-6727-42c1-a49f-ac25ac4938d6'
const LAUNCH = 'launch-46f89ab4-86dc-464e-8bf7-8913f328ea02'

function ev(
  hrcSeq: number,
  streamSeq: number,
  ts: string,
  category: HrcLifecycleEvent['category'],
  eventKind: string,
  opts: Partial<HrcLifecycleEvent> = {}
): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq,
    ts,
    hostSessionId: 'hs-x',
    scopeRef: SCOPE,
    laneRef: 'default',
    generation: 1,
    category,
    eventKind,
    replayed: false,
    payload: {},
    ...opts,
  }
}

function render(events: HrcLifecycleEvent[], options = {}): string {
  const r = createEventsRenderer('tree', options)
  let out = ''
  for (const e of events) out += r.push(e)
  out += r.flush()
  return out
}

describe('TreeRenderer', () => {
  it('emits a scope band rule with the friendly agent handle', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:41Z', 'session', 'session.resolved', {
        payload: { created: false },
      }),
    ])
    expect(out).toContain('cody@agent-spaces:discord')
    expect(out).toContain('g:1')
    expect(out).toContain('session resolved')
    expect(out).toContain('created=false')
  })

  it('suppresses the run rule when runtimeId/runId do not change', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:41Z', 'turn', 'turn.accepted', {
        runtimeId: RT,
        runId: RUN,
      }),
      ev(2, 2, '2026-04-21T11:29:41Z', 'turn', 'turn.started', {
        runtimeId: RT,
        runId: RUN,
      }),
    ])
    // Exactly one run rule even though both events share runtimeId/runId.
    const runRuleLines = out.split('\n').filter((l) => l.includes('rt-ebaeb01'))
    expect(runRuleLines.length).toBe(1)
  })

  it('folds tool_call + tool_result by toolUseId, parsing the shell envelope', () => {
    const envelope = JSON.stringify({
      output: 'hello world\n',
      metadata: { exit_code: 0, duration_seconds: 0.123 },
    })
    const out = render([
      ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.tool_call', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          type: 'tool_execution_start',
          toolUseId: 'call-1',
          toolName: 'shell',
          input: { command: ['bash', '-lc', "echo 'hello world'"] },
        },
      }),
      ev(2, 2, '2026-04-21T11:29:47Z', 'turn', 'turn.tool_result', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          type: 'tool_execution_end',
          toolUseId: 'call-1',
          toolName: 'shell',
          result: { content: [{ type: 'text', text: envelope }] },
          isError: false,
        },
      }),
    ])
    // Shell command rendered with $ prefix.
    expect(out).toContain("$ echo 'hello world'")
    // Shell envelope parsed — exit code + duration shown, output below.
    expect(out).toContain('exit 0')
    expect(out).toContain('0.12s')
    expect(out).toContain('hello world')
    // No raw JSON envelope in the output.
    expect(out).not.toContain('"metadata"')
    expect(out).not.toContain('exit_code')
  })

  it('marks a forwarded user prompt as a repeat when it matches the prior one in the same run', () => {
    const content = 'What is your scopeRef?'
    const out = render([
      ev(1, 1, '2026-04-21T11:29:41Z', 'turn', 'turn.user_prompt', {
        runtimeId: RT,
        runId: RUN,
        payload: { type: 'message_end', message: { role: 'user', content } },
      }),
      ev(2, 2, '2026-04-21T11:29:42Z', 'turn', 'turn.user_prompt', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: { type: 'message_end', message: { role: 'user', content } },
      }),
    ])
    // Content appears exactly once; the forwarded copy is a marker only.
    const contentOccurrences = out.split(content).length - 1
    expect(contentOccurrences).toBe(1)
    expect(out).toContain('forwarded to launch')
  })

  it('flushes an orphan tool_call if no matching result arrives', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.tool_call', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          toolUseId: 'call-orphan',
          toolName: 'shell',
          input: { command: 'whoami' },
        },
      }),
    ])
    expect(out).toContain('shell')
    expect(out).toContain('$ whoami')
    expect(out).toContain('(no result yet)')
  })

  it('renders an assistant message as prose (no KEY : value walker)', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.message', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'line one\nline two' },
        },
      }),
    ])
    expect(out).toContain('assistant')
    expect(out).toContain('line one')
    expect(out).toContain('line two')
    expect(out).not.toContain('| MESSAGE')
    expect(out).not.toContain('| content')
  })

  it('includes a per-row scoperef badge next to every timestamp', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:41Z', 'session', 'session.resolved', {
        payload: { created: false },
      }),
      ev(2, 2, '2026-04-21T11:29:41Z', 'turn', 'turn.accepted', {
        runtimeId: RT,
        runId: RUN,
      }),
    ])
    // Compact badge drops project when a task is present: "cody:discord".
    const badgeLines = out.split('\n').filter((l) => /^\s{2}\d{2}:\d{2}:\d{2}/.test(l))
    expect(badgeLines.length).toBeGreaterThan(0)
    for (const line of badgeLines) {
      expect(line).toContain('cody:discord')
    }
  })

  it('does not emit a timestamp on the tool_result continuation row', () => {
    const out = render([
      ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.tool_call', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          toolUseId: 'call-ts',
          toolName: 'shell',
          input: { command: ['bash', '-lc', 'echo hi'] },
        },
      }),
      ev(2, 2, '2026-04-21T11:29:47Z', 'turn', 'turn.tool_result', {
        runtimeId: RT,
        runId: RUN,
        launchId: LAUNCH,
        payload: {
          toolUseId: 'call-ts',
          toolName: 'shell',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  output: 'hi\n',
                  metadata: { exit_code: 0, duration_seconds: 0.01 },
                }),
              },
            ],
          },
        },
      }),
    ])
    // Exactly one 11:29:47 timestamp line — the tool_call header. The ↳ tail is a
    // continuation with no timestamp.
    const tsLines = out.split('\n').filter((l) => /^\s{2}11:29:47/.test(l))
    expect(tsLines.length).toBe(1)
    expect(out).toContain('exit 0')
    // The ↳ row should exist but not have a leading time.
    const tailLines = out.split('\n').filter((l) => l.includes('exit 0'))
    expect(tailLines.length).toBe(1)
    expect(tailLines[0]).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('truncates body blocks at --max-lines and shows a hint footer', () => {
    const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = render(
      [
        ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.message', {
          runtimeId: RT,
          runId: RUN,
          launchId: LAUNCH,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: body },
          },
        }),
      ],
      { maxLines: 5 }
    )
    expect(out).toContain('line 1')
    expect(out).toContain('line 5')
    expect(out).not.toContain('line 6')
    expect(out).toContain('+20 more lines')
    expect(out).toContain('--max-lines 0 to expand')
  })

  it('--max-lines=0 disables truncation', () => {
    const body = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = render(
      [
        ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.message', {
          runtimeId: RT,
          runId: RUN,
          launchId: LAUNCH,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: body },
          },
        }),
      ],
      { maxLines: 0 }
    )
    expect(out).toContain('line 1')
    expect(out).toContain('line 25')
    expect(out).not.toContain('more lines')
  })

  it('parses the codex exec_command result envelope', () => {
    const codexOutput = [
      'Chunk ID: abc123',
      'Wall time: 0.3813 seconds',
      'Process exited with code 0',
      'Original token count: 471',
      'Output:',
      'bun test passed',
      '17 pass / 0 fail',
    ].join('\n')
    const out = render(
      [
        ev(1, 1, '2026-04-21T12:06:35Z', 'turn', 'turn.tool_call', {
          runtimeId: RT,
          runId: RUN,
          launchId: LAUNCH,
          payload: {
            toolUseId: 'call-codex',
            toolName: 'exec_command',
            input: { cmd: 'bun test packages/foo' },
          },
        }),
        ev(2, 2, '2026-04-21T12:06:35Z', 'turn', 'turn.tool_result', {
          runtimeId: RT,
          runId: RUN,
          launchId: LAUNCH,
          payload: {
            toolUseId: 'call-codex',
            toolName: 'exec_command',
            result: { content: [{ type: 'text', text: codexOutput }] },
          },
        }),
      ],
      { maxLines: 0 }
    )
    // exit + duration parsed out of the envelope
    expect(out).toContain('exit 0')
    expect(out).toContain('0.38s')
    // Actual output kept, metadata preamble dropped
    expect(out).toContain('bun test passed')
    expect(out).toContain('17 pass / 0 fail')
    expect(out).not.toContain('Chunk ID')
    expect(out).not.toContain('Original token count')
    expect(out).not.toContain('Output:')
    // exec_command rendered as a shell command, not KEY/VALUE dump
    expect(out).toContain('$ bun test packages/foo')
  })
})

describe('CompactRenderer', () => {
  it('prints one line per event with a short id tail', () => {
    const r = createEventsRenderer('compact')
    const line = r.push(
      ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.message', {
        runtimeId: RT,
        runId: RUN,
        payload: {
          type: 'message_end',
          message: { role: 'assistant', content: 'done' },
        },
      })
    )
    expect(line.trim().split('\n').length).toBe(1)
    expect(line).toContain('11:29:47')
    expect(line).toContain('turn.message')
    expect(line).toContain('run-31b87e0')
  })
})

describe('JsonRenderer', () => {
  it('emits NDJSON with exactly the event shape passed in', () => {
    const event = ev(1, 1, '2026-04-21T11:29:47Z', 'turn', 'turn.started', {
      runtimeId: RT,
      runId: RUN,
    })
    const r = createEventsRenderer('ndjson')
    const out = r.push(event).trim()
    expect(JSON.parse(out)).toEqual(event)
  })
})
