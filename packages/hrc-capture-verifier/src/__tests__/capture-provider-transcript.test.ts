import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProviderTranscript } from '../index.js'

describe('provider transcript adapters', () => {
  it('normalizes minimized Codex JSONL with line numbers and tool correlation ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-jsonl-'))
    const path = join(dir, 'codex.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'exec_command',
            arguments: '{"cmd":"date"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-1', output: 'Tue' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-2',
            name: 'write_stdin',
            arguments: '{}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call-2', output: 'ignored' },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('codex')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([
        [1, 'assistant.message.completed', undefined],
        [2, 'tool.call.started', 'call-1'],
        [3, 'tool.call.completed', 'call-1'],
      ])
      expect(transcript.warnings).toContain(
        'line 4: Codex function_call write_stdin is outside broker JSONL v1 scope'
      )
      expect(transcript.totalLines).toBe(5)
      expect(transcript.parsedRecords).toBe(5)
      expect(transcript.invalidJsonRecords).toBe(0)
      expect(transcript.applicableObservations).toBe(3)
      expect(transcript.ignoredRecords).toBe(1)
      expect(transcript.unsupportedRecords).toBe(1)
      expect(transcript.unknownRecords).toBe(0)
      expect(transcript.warningCount).toBe(1)
      expect(transcript.observationsByType).toMatchObject({
        'assistant.message.completed': 1,
        'tool.call.started': 1,
        'tool.call.completed': 1,
      })
      expect(transcript.observations[1]?.normalizedPayload).toEqual({
        toolCallId: 'call-1',
        name: 'command',
        input: { cmd: 'date' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a nonzero Codex command result completed and preserves its neutral exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-nonzero-'))
    const path = join(dir, 'codex.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-nonzero',
            name: 'exec_command',
            arguments: '{"cmd":"rg definitely_missing"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-nonzero',
            output: 'Process exited with code 1\nOutput:\nno matches',
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.observations[1]).toMatchObject({
        type: 'tool.call.completed',
        correlationKey: 'call-nonzero',
        normalizedPayload: {
          toolCallId: 'call-nonzero',
          result: { output: 'no matches', exitCode: 1 },
        },
      })
      expect(transcript.observationsByType).toMatchObject({
        'tool.call.completed': 1,
        'tool.call.failed': 0,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes installed Codex JSON-RPC command notifications without reclassifying exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-codex-jsonrpc-'))
    const path = join(dir, 'codex.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/started',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call-jsonrpc',
              command: "/bin/zsh -lc 'rg definitely_missing'",
              cwd: '/workspace',
              status: 'inProgress',
              aggregatedOutput: null,
              exitCode: null,
            },
          },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/commandExecution/outputDelta',
          params: { itemId: 'call-jsonrpc', delta: 'no matches' },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call-jsonrpc',
              command: "/bin/zsh -lc 'rg definitely_missing'",
              cwd: '/workspace',
              status: 'failed',
              aggregatedOutput: 'no matches',
              exitCode: 1,
            },
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('codex')
      expect(transcript.observations).toHaveLength(2)
      expect(transcript.ignoredRecords).toBe(1)
      expect(transcript.observations[0]).toMatchObject({
        type: 'tool.call.started',
        correlationKey: 'call-jsonrpc',
        normalizedPayload: {
          toolCallId: 'call-jsonrpc',
          name: 'command',
          input: { cmd: 'rg definitely_missing', cwd: '/workspace' },
        },
      })
      expect(transcript.observations[1]).toMatchObject({
        type: 'tool.call.completed',
        correlationKey: 'call-jsonrpc',
        normalizedPayload: {
          toolCallId: 'call-jsonrpc',
          result: { output: 'no matches', exitCode: 1 },
        },
      })
      expect(transcript.observationsByType).toMatchObject({
        'tool.call.started': 1,
        'tool.call.completed': 1,
        'tool.call.failed': 0,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes minimized Claude JSONL user, assistant, tool_use, and tool_result records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-claude-'))
    const path = join(dir, 'claude.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'pwd' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' }],
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('claude-code')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([
        [1, 'user.message', undefined],
        [2, 'tool.call.started', 'toolu-1'],
        [3, 'tool.call.completed', 'toolu-1'],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a Claude domain-error result completed and records isError as payload data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-claude-error-'))
    const path = join(dir, 'claude.jsonl')
    await writeFile(
      path,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-error',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      })
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.observations[0]).toMatchObject({
        type: 'tool.call.completed',
        correlationKey: 'toolu-error',
        normalizedPayload: {
          toolCallId: 'toolu-error',
          result: { output: 'permission denied' },
          isError: true,
        },
      })
      expect(transcript.observationsByType).toMatchObject({
        'tool.call.completed': 1,
        'tool.call.failed': 0,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores Codex pending exec placeholders as non-final tool output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-pending-'))
    const path = join(dir, 'codex-pending.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call-pending',
            name: 'exec_command',
            arguments: '{"cmd":"sleep 1"}',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-pending',
            output:
              'Chunk ID: abc\nWall time: 10.0000 seconds\nProcess running with session ID 42\nOriginal token count: 0\nOutput:\n',
          },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.provider).toBe('codex')
      expect(
        transcript.observations.map((event) => [event.line, event.type, event.correlationKey])
      ).toEqual([[1, 'tool.call.started', 'call-pending']])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports parser disposition stats without deriving them from warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-stats-'))
    const path = join(dir, 'stats.jsonl')
    await writeFile(
      path,
      [
        '{bad json',
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'call-x', name: 'write_stdin' },
        }),
        JSON.stringify({ type: 'session_meta', sessionId: 's1' }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: 'one' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: 'two' },
        }),
      ].join('\n')
    )

    try {
      const transcript = await parseProviderTranscript({ path })
      expect(transcript.totalLines).toBe(6)
      expect(transcript.parsedRecords).toBe(5)
      expect(transcript.invalidJsonRecords).toBe(1)
      expect(transcript.ignoredRecords).toBe(1)
      expect(transcript.unsupportedRecords).toBe(1)
      expect(transcript.unknownRecords).toBe(1)
      expect(transcript.warningCount).toBe(3)
      expect(transcript.applicableObservations).toBe(2)
      expect(transcript.observationsByType['assistant.message.completed']).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
