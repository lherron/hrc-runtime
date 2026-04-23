import { describe, expect, it } from 'bun:test'
import { normalizeCodexOtelEvent } from '../otel-normalizer.js'
import type { OtelLogRecordInput } from '../otel-normalizer.js'

function makeRecord(
  eventName: string,
  extraAttrs: Record<string, unknown> = {}
): OtelLogRecordInput {
  return {
    logRecord: {
      timeUnixNano: '1713370000000000000',
      severityNumber: 9,
      severityText: 'INFO',
      body: null,
      attributes: {
        'event.name': eventName,
        'conversation.id': 'conv-test-123',
        'app.version': '0.121.0',
        model: 'gpt-5.5',
        ...extraAttrs,
      },
    },
  }
}

describe('normalizeCodexOtelEvent', () => {
  describe('codex.tool_decision → tool_execution_start', () => {
    it('maps tool_decision with call_id to tool_execution_start', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_decision', {
          tool_name: 'exec_command',
          call_id: 'call_abc123',
          decision: 'approved',
          source: 'Config',
          arguments: '{"cmd":"ls","workdir":"/tmp"}',
        })
      )

      expect(result.eventName).toBe('codex.tool_decision')
      expect(result.events).toHaveLength(1)
      const event = result.events[0]!
      expect(event.type).toBe('tool_execution_start')
      if (event.type === 'tool_execution_start') {
        expect(event.toolUseId).toBe('call_abc123')
        expect(event.toolName).toBe('exec_command')
        expect(event.input).toEqual({ cmd: 'ls', workdir: '/tmp' })
      }
    })

    it('returns no typed event when tool_decision has no arguments payload', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_decision', {
          tool_name: 'exec_command',
          call_id: 'call_xyz',
        })
      )

      expect(result.events).toHaveLength(0)
      expect(result.eventName).toBe('codex.tool_decision')
    })

    it('returns no typed event when arguments is not valid JSON', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_decision', {
          tool_name: 'exec_command',
          call_id: 'call_xyz',
          arguments: 'not-json',
        })
      )

      expect(result.events).toHaveLength(0)
    })

    it('returns empty events when call_id is missing', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_decision', {
          tool_name: 'exec_command',
        })
      )

      expect(result.events).toHaveLength(0)
      expect(result.eventName).toBe('codex.tool_decision')
    })

    it('defaults tool_name to "tool" when tool_result backfills the start event', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', {
          call_id: 'call_1',
          arguments: '{"cmd":"ls"}',
        })
      )

      expect(result.events).toHaveLength(2)
      if (result.events[0]!.type === 'tool_execution_start') {
        expect(result.events[0]!.toolName).toBe('tool')
      }
    })
  })

  describe('codex.tool_result → tool_execution_end', () => {
    it('maps tool_result to tool_execution_end', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', {
          tool_name: 'exec_command',
          call_id: 'call_abc123',
          output: 'hello world',
          success: true,
          duration_ms: '150',
        })
      )

      expect(result.events).toHaveLength(1)
      const event = result.events[0]!
      expect(event.type).toBe('tool_execution_end')
      if (event.type === 'tool_execution_end') {
        expect(event.toolUseId).toBe('call_abc123')
        expect(event.toolName).toBe('exec_command')
        expect(event.isError).toBe(false)
        expect(event.result.content).toEqual([{ type: 'text', text: 'hello world' }])
      }
    })

    it('emits tool_execution_start before tool_execution_end when tool_result carries arguments', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', {
          tool_name: 'exec_command',
          call_id: 'call_args',
          arguments: '{"cmd":"agentchat dm animata","workdir":"/tmp/project"}',
          output: 'ok',
          success: true,
        })
      )

      expect(result.events).toHaveLength(2)
      expect(result.events[0]?.type).toBe('tool_execution_start')
      expect(result.events[1]?.type).toBe('tool_execution_end')
      if (result.events[0]?.type === 'tool_execution_start') {
        expect(result.events[0].input).toEqual({
          cmd: 'agentchat dm animata',
          workdir: '/tmp/project',
        })
      }
    })

    it('sets isError when success is false', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', {
          tool_name: 'exec_command',
          call_id: 'call_err',
          output: 'command failed',
          success: false,
        })
      )

      expect(result.events).toHaveLength(1)
      if (result.events[0]!.type === 'tool_execution_end') {
        expect(result.events[0]!.isError).toBe(true)
      }
    })

    it('handles success as string "false"', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', {
          tool_name: 'exec_command',
          call_id: 'call_str',
          success: 'false',
        })
      )

      expect(result.events).toHaveLength(1)
      if (result.events[0]!.type === 'tool_execution_end') {
        expect(result.events[0]!.isError).toBe(true)
      }
    })

    it('returns empty events when call_id is missing', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.tool_result', { tool_name: 'exec_command' })
      )
      expect(result.events).toHaveLength(0)
    })
  })

  describe('codex.user_prompt → notice', () => {
    it('maps user_prompt to notice with truncated prompt', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.user_prompt', {
          prompt: 'fix the bug in auth.ts',
          prompt_length: '22',
        })
      )

      expect(result.events).toHaveLength(1)
      const event = result.events[0]!
      expect(event.type).toBe('notice')
      if (event.type === 'notice') {
        expect(event.level).toBe('info')
        expect(event.message).toContain('fix the bug in auth.ts')
      }
    })

    it('truncates long prompts at 200 chars', () => {
      const longPrompt = 'x'.repeat(300)
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.user_prompt', { prompt: longPrompt })
      )

      if (result.events[0]!.type === 'notice') {
        expect(result.events[0]!.message.length).toBeLessThan(300)
        expect(result.events[0]!.message).toContain('\u2026')
      }
    })
  })

  describe('codex.conversation_starts → notice', () => {
    it('maps conversation_starts to notice with model info', () => {
      const result = normalizeCodexOtelEvent(
        makeRecord('codex.conversation_starts', {
          provider_name: 'openai',
        })
      )

      expect(result.events).toHaveLength(1)
      const event = result.events[0]!
      expect(event.type).toBe('notice')
      if (event.type === 'notice') {
        expect(event.level).toBe('info')
        expect(event.message).toContain('openai/gpt-5.5')
      }
    })

    it('shows model only when provider is missing', () => {
      const result = normalizeCodexOtelEvent(makeRecord('codex.conversation_starts', {}))

      if (result.events[0]!.type === 'notice') {
        expect(result.events[0]!.message).toContain('gpt-5.5')
        expect(result.events[0]!.message).not.toContain('/')
      }
    })
  })

  describe('transport/infra events — no mapping', () => {
    for (const eventName of [
      'codex.api_request',
      'codex.sse_event',
      'codex.websocket_connect',
      'codex.websocket_event',
      'codex.websocket_request',
    ]) {
      it(`returns empty events for ${eventName}`, () => {
        const result = normalizeCodexOtelEvent(makeRecord(eventName))
        expect(result.events).toHaveLength(0)
        expect(result.eventName).toBe(eventName)
      })
    }
  })

  describe('unknown events', () => {
    it('returns empty events for unknown event names', () => {
      const result = normalizeCodexOtelEvent(makeRecord('codex.future_event'))
      expect(result.events).toHaveLength(0)
      expect(result.eventName).toBe('codex.future_event')
    })

    it('falls back to otel.log when no event name attribute', () => {
      const result = normalizeCodexOtelEvent({
        logRecord: { body: 'plain log line' },
      })
      expect(result.events).toHaveLength(0)
      expect(result.eventName).toBe('otel.log')
    })
  })

  describe('event name extraction fallbacks', () => {
    it('extracts from event_name attribute', () => {
      const result = normalizeCodexOtelEvent({
        logRecord: {
          attributes: { event_name: 'codex.user_prompt', prompt: 'hello' },
        },
      })
      expect(result.eventName).toBe('codex.user_prompt')
      expect(result.events).toHaveLength(1)
    })

    it('extracts from body.eventName', () => {
      const result = normalizeCodexOtelEvent({
        logRecord: {
          body: { eventName: 'codex.conversation_starts' },
          attributes: { model: 'test' },
        },
      })
      expect(result.eventName).toBe('codex.conversation_starts')
    })

    it('extracts from body.event_name', () => {
      const result = normalizeCodexOtelEvent({
        logRecord: {
          body: { event_name: 'codex.conversation_starts' },
          attributes: { model: 'test' },
        },
      })
      expect(result.eventName).toBe('codex.conversation_starts')
    })
  })
})
