import { describe, expect, test } from 'bun:test'
import { lifecyclePayload } from '../../../hrc-server/src/broker/event-mapper/lifecycle-payload'

import { cmdMonitorWatch } from '../monitor-watch'
import {
  type MonitorFixtureState,
  type MonitorWatchArgs,
  SCOPE_REF,
  SELECTOR,
  TS,
  TURN_ID,
  apiDiagnosticEvent,
  createFixtureState,
  event,
  expectValidMonitorEvent,
  invokeWatch,
  invokeWatchText,
  parseJsonLines,
} from './fixtures/cli-test-fixture.js'

describe('hrc monitor watch CLI acceptance (T-01290 / F2b)', () => {
  test('non-follow replay defaults to the last 100 matching events and marks them replayed', async () => {
    const events = Array.from({ length: 150 }, (_, index) =>
      event(index + 1, 'runtime.idle', { result: 'idle' })
    )
    const result = await invokeWatch({ selector: SELECTOR }, createFixtureState({ events }))

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.events).toHaveLength(100)
    expect(result.events[0]).toMatchObject({ seq: 51, replayed: true })
    expect(result.events.at(-1)).toMatchObject({ seq: 150, replayed: true })
    for (const payload of result.events) {
      expectValidMonitorEvent(payload)
    }
  })

  test('--from-seq replays the full matching window with no default cap (T-01740 Fix B)', async () => {
    const events = Array.from({ length: 150 }, (_, index) =>
      event(index + 1, 'runtime.idle', { result: 'idle' })
    )
    const result = await invokeWatch(
      { selector: SELECTOR, fromSeq: 1 },
      createFixtureState({ events })
    )

    expect(result.exitCode).toBe(0)
    // Explicit window => no truncation, no default-cap note.
    expect(result.stderr).toBe('')
    expect(result.events).toHaveLength(150)
    expect(result.events[0]).toMatchObject({ seq: 1, replayed: true })
    expect(result.events.at(-1)).toMatchObject({ seq: 150, replayed: true })
  })

  test('--json carries the full event payload and correlation ids (T-01740 Fix A)', async () => {
    const result = await invokeWatch(
      { selector: SELECTOR },
      createFixtureState({
        events: [
          event(200, 'surface.reported', {
            runId: 'run-xyz',
            launchId: 'launch-xyz',
            payload: { kind: 'tmux-pane', surfaceId: '%0', paneId: '%0' },
          }),
        ],
      })
    )

    expect(result.exitCode).toBe(0)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      event: 'surface.reported',
      generation: 12,
      scopeRef: SCOPE_REF,
      runId: 'run-xyz',
      launchId: 'launch-xyz',
      payload: { kind: 'tmux-pane', surfaceId: '%0', paneId: '%0' },
    })
  })

  test('shows surfaced API diagnostics in default replay and --kind broker.diagnostic', async () => {
    const diagnostic = apiDiagnosticEvent()
    const state = createFixtureState({
      events: [event(204, 'turn.started', { turnId: TURN_ID }), diagnostic],
    })

    // T-05096: hrc monitor consumes projected hrc_events rows. A surfaced
    // broker.diagnostic must appear in the ordinary JSON stream without making
    // monitor-watch read raw broker provenance.
    const defaultReplay = await invokeWatch({ selector: SELECTOR }, state)
    expect(defaultReplay.exitCode).toBe(0)
    expect(defaultReplay.events).toContainEqual(
      expect.objectContaining({
        event: 'broker.diagnostic',
        category: 'runtime',
        runId: TURN_ID,
        payload: expect.objectContaining({
          message: 'API Error: overloaded upstream',
          data: expect.objectContaining({ code: 'api_error' }),
          invocationId: 'invocation-05096',
          turnId: 'turn-api-error',
          inputId: 'input-api-error',
          itemId: 'item-api-error',
          driver: { kind: 'claude-code-tmux', rawType: 'assistant' },
        }),
      })
    )

    const filtered = await invokeWatch(
      { selector: SELECTOR, kind: 'broker.diagnostic' },
      createFixtureState({
        events: [event(203, 'turn.started', { turnId: TURN_ID }), diagnostic],
      })
    )
    expect(filtered.exitCode).toBe(0)
    expect(filtered.events.map((payload) => payload.event)).toEqual(['broker.diagnostic'])
  })

  test('pretty monitor output renders API diagnostics as non-terminal rows', async () => {
    const cli = await invokeWatchText(
      { selector: SELECTOR, pretty: true },
      createFixtureState({ events: [apiDiagnosticEvent()] })
    )

    expect(cli.exitCode).toBe(0)
    expect(cli.stdout).toContain('diagnostic')
    expect(cli.stdout).toContain('API Error: overloaded upstream')
    expect(cli.stdout).not.toContain('turn failed')
    expect(cli.stdout).not.toContain('turn completed')
  })

  test('default pretty replay shows the provider diagnostic and failed terminal details', async () => {
    const failedPayload = lifecyclePayload(
      {
        invocationId: 'invocation-provider-error',
        seq: 52,
        time: TS,
        type: 'turn.failed',
        payload: {
          message: 'API Error: overloaded upstream',
          code: 'api_error',
        },
      } as Parameters<typeof lifecyclePayload>[0],
      'tmux'
    )
    const cli = await invokeWatchText(
      { selector: SELECTOR, pretty: true },
      createFixtureState({
        events: [
          event(204, 'turn.started', { turnId: TURN_ID }),
          apiDiagnosticEvent(205),
          event(206, 'turn.completed', {
            turnId: TURN_ID,
            runId: TURN_ID,
            transport: 'tmux',
            payload: failedPayload,
          }),
        ],
      })
    )

    expect(cli.exitCode).toBe(0)
    expect(cli.stdout).toContain('diagnostic')
    expect(cli.stdout).toContain('API Error: overloaded upstream')
    expect(cli.stdout).toContain('turn failed')
    expect(cli.stdout).not.toContain('turn completed')
    const terminalRow = cli.stdout.split('\n').find((line) => line.includes('turn failed'))
    expect(terminalRow).toContain('message=API Error: overloaded upstream')
    expect(terminalRow).toContain('code=api_error')
  })

  test('--last replays more than the default 100-event tail when requested', async () => {
    const events = Array.from({ length: 200 }, (_, index) =>
      event(index + 1, index % 2 === 0 ? 'runtime.idle' : 'runtime.busy', {
        result: index % 2 === 0 ? 'idle' : 'busy',
      })
    )
    const result = await invokeWatch(
      { selector: SELECTOR, last: 150 },
      createFixtureState({ events })
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.events).toHaveLength(150)
    expect(result.events[0]).toMatchObject({ seq: 51, replayed: true })
    expect(result.events.at(-1)).toMatchObject({ seq: 200, replayed: true })
    expect(result.events.every((payload) => payload.replayed === true)).toBe(true)
  })

  test('non-follow replay exits 0 when zero events match', async () => {
    const state = createFixtureState({
      events: [event(101, 'runtime.idle', { runtimeId: 'other-runtime' })],
    })
    const result = await invokeWatch({ selector: 'runtime:missing-runtime' }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('')
    expect(result.events).toEqual([])
  })

  test('--from-seq replays matching events from that sequence number', async () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event(index + 1, 'runtime.busy', { result: 'busy' })
    )
    const result = await invokeWatch(
      { selector: SELECTOR, fromSeq: 8 },
      createFixtureState({ events })
    )

    expect(result.exitCode).toBe(0)
    expect(result.events.map((payload) => payload.seq)).toEqual([8, 9, 10, 11, 12])
    expect(result.events.every((payload) => payload.replayed === true)).toBe(true)
  })

  test('--last and --from-seq are mutually exclusive', async () => {
    const result = await invokeWatch(
      { selector: SELECTOR, last: 3, fromSeq: 8 },
      createFixtureState()
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--last cannot be used with --from-seq')
  })

  test('--pretty uses the tree renderer with lifecycle payload details', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.message', {
          turnId: TURN_ID,
          runId: TURN_ID,
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'pretty restored' },
          },
        }),
      ],
    })

    const stdoutChunks: string[] = []
    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        selector: SELECTOR,
        pretty: true,
      },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const output = stdoutChunks.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('assistant')
    expect(output).toContain('pretty restored')
    expect(output).toContain('cody@agent-spaces:T-01290')
    expect(() => JSON.parse(output.split('\n')[0] ?? '')).toThrow()
  })

  test('--pretty renders orphan Bash result stdout as structured output', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.tool_result', {
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            result: {
              content: [
                {
                  type: 'text',
                  text: '{"event":"monitor.completed","condition":"response","result":"response","exitCode":0}',
                },
              ],
              details: {
                stdout:
                  '{"event":"monitor.completed","condition":"response","result":"response","exitCode":0}',
                stderr: '',
                interrupted: false,
              },
            },
            isError: false,
          },
        }),
      ],
    })

    const stdoutChunks: string[] = []
    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        selector: SELECTOR,
        pretty: true,
      },
      {
        buildMonitorState: async () => state,
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: {
          write() {
            return true
          },
        },
      }
    )

    const output = stdoutChunks.join('')
    expect(exitCode).toBe(0)
    expect(output).toContain('Bash result')
    expect(output).toContain('stdout')
    expect(output).toContain('event')
    expect(output).toContain('monitor.completed')
    expect(output).toContain('exitCode')
    expect(output).not.toContain('{"event":"monitor.completed"')
  })

  test('--pretty renders tool descriptions and compact edit inputs', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.tool_call', {
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            input: {
              command: 'bun test',
              description: 'Run focused unit tests',
            },
          },
        }),
        event(101, 'turn.tool_result', {
          payload: {
            type: 'tool_execution_end',
            toolUseId: 'toolu-bash',
            toolName: 'Bash',
            result: { content: [{ type: 'text', text: 'ok' }] },
            isError: false,
          },
        }),
        event(102, 'turn.tool_call', {
          payload: {
            type: 'tool_execution_start',
            toolUseId: 'toolu-edit',
            toolName: 'Edit',
            input: {
              file_path: '/Users/lherron/praesidium/agent-spaces/JOB_E2E_PLAN.md',
              old_string: 'old text',
              new_string: 'new text',
            },
          },
        }),
      ],
    })

    const result = await invokeWatchText({ selector: SELECTOR, pretty: true }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Bash - Run focused unit tests')
    expect(result.stdout).toContain('$ bun test')
    expect(result.stdout).toContain('-> ok')
    expect(result.stdout).toContain('Edit - ')
    expect(result.stdout).toContain('JOB_E2E_PLAN.md')
    expect(result.stdout).toContain('replace one block')
    expect(result.stdout).toContain('old: 1 line')
    expect(result.stdout).not.toContain('"old_string"')
  })

  test('--pretty includes event sequence and replay marker', async () => {
    const state = createFixtureState({
      events: [
        event(100, 'turn.message', {
          payload: {
            type: 'message_end',
            message: { role: 'assistant', content: 'sequenced' },
          },
        }),
      ],
    })

    const result = await invokeWatchText({ selector: SELECTOR, pretty: true }, state)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('#100 replayed')
  })

  test('--timeout exits 20 and emits monitor.completed with result=timeout', async () => {
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', timeoutMs: 1 },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] })
    )

    expect(cli.exitCode).toBe(20)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.completed',
      result: 'timeout',
      outcome: 'not_matched',
      exitCode: 20,
      phase: 'after-arm',
      conditions: ['turn-finished'],
    })
  })

  test('initial-read timeout exits 20 with before-arm machine fields', async () => {
    const stdoutChunks: string[] = []
    const exitCode = await (
      cmdMonitorWatch as unknown as (
        args: MonitorWatchArgs,
        deps: {
          buildMonitorState: () => Promise<MonitorFixtureState>
          stdout: { write(chunk: string): boolean }
          stderr: { write(chunk: string): boolean }
        }
      ) => Promise<number | undefined>
    )(
      {
        json: true,
        selector: SELECTOR,
        follow: true,
        timeoutMs: 1,
      },
      {
        buildMonitorState: () => new Promise<MonitorFixtureState>(() => {}),
        stdout: {
          write(chunk: string) {
            stdoutChunks.push(chunk)
            return true
          },
        },
        stderr: { write: () => true },
      }
    )

    expect(exitCode).toBe(20)
    expect(parseJsonLines(stdoutChunks.join(''))).toEqual([
      expect.objectContaining({
        event: 'monitor.completed',
        result: 'timeout',
        outcome: 'not_matched',
        exitCode: 20,
        phase: 'before-arm',
        members: [],
        reason: 'initial_read_timeout',
      }),
    ])
  })

  test('--stall-after exits 21 and emits monitor.stalled', async () => {
    const cli = await invokeWatch(
      { selector: SELECTOR, follow: true, until: 'turn-finished', stallAfterMs: 1 },
      createFixtureState({ events: [event(100, 'turn.started', { turnId: TURN_ID })] })
    )

    expect(cli.exitCode).toBe(21)
    expect(cli.events.at(-1)).toMatchObject({
      event: 'monitor.stalled',
      result: 'stalled',
      outcome: 'not_matched',
      exitCode: 21,
      conditions: ['turn-finished'],
    })
  })
})

// -- Polling condition reader (T-01297) ----------------------------------------
