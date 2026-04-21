import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createAgentMessagePayload,
  createUserPromptPayload,
  deriveSemanticTurnEventFromHookDerivedEvent,
  deriveSemanticTurnEventFromLaunchEvent,
  deriveSemanticTurnEventFromSdkEvent,
  deriveSemanticTurnMessageFromHookPayload,
  extractLaunchPrimingPrompt,
} from '../hrc-event-helper'

describe('hrc semantic turn helpers', () => {
  it('truncates oversized user prompts to 16 KiB and flags them', () => {
    const payload = createUserPromptPayload('x'.repeat(16 * 1024 + 32))

    expect(payload.type).toBe('message_end')
    expect(payload.message.role).toBe('user')
    expect(payload.message.content).toHaveLength(16 * 1024)
    expect(payload.truncated).toBe(true)
  })

  it('builds assistant message payloads with CP-compatible shape', () => {
    const payload = createAgentMessagePayload('done')

    expect(payload).toEqual({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: 'done',
      },
    })
  })

  it('extracts Codex priming prompts from launch argv for interactive and resume modes', () => {
    expect(
      extractLaunchPrimingPrompt({
        harness: 'codex-cli',
        argv: ['codex', 'Reply READY', '--model', 'gpt-5.4'],
      })
    ).toBe('Reply READY')

    expect(
      extractLaunchPrimingPrompt({
        harness: 'codex-cli',
        argv: ['codex', 'resume', 'thread-123', 'Continue here'],
      })
    ).toBe('Continue here')

    expect(
      extractLaunchPrimingPrompt({
        harness: 'codex-cli',
        argv: ['codex', 'exec', 'Ship it', '--json'],
      })
    ).toBe('Ship it')
  })

  it('maps SDK message/tool events into semantic turn events', () => {
    expect(
      deriveSemanticTurnEventFromSdkEvent('sdk.message', {
        role: 'assistant',
        content: 'hello',
      })
    ).toEqual({
      eventKind: 'turn.message',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    })

    expect(
      deriveSemanticTurnEventFromSdkEvent('sdk.tool_call', {
        toolUseId: 'tool-1',
        toolName: 'read_file',
        input: { path: '/tmp/demo.txt' },
      })
    ).toEqual({
      eventKind: 'turn.tool_call',
      payload: {
        type: 'tool_execution_start',
        toolUseId: 'tool-1',
        toolName: 'read_file',
        input: { path: '/tmp/demo.txt' },
      },
    })

    expect(
      deriveSemanticTurnEventFromSdkEvent('sdk.tool_result', {
        toolUseId: 'tool-1',
        toolName: 'read_file',
        output: 'contents',
        isError: false,
      })
    ).toEqual({
      eventKind: 'turn.tool_result',
      payload: {
        type: 'tool_execution_end',
        toolUseId: 'tool-1',
        toolName: 'read_file',
        result: {
          content: [{ type: 'text', text: 'contents' }],
        },
        isError: false,
      },
    })
  })

  it('maps hook-derived tool events into semantic turn events', () => {
    expect(
      deriveSemanticTurnEventFromHookDerivedEvent({
        type: 'tool_execution_start',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        input: { command: 'pwd' },
      })
    ).toEqual({
      eventKind: 'turn.tool_call',
      payload: {
        type: 'tool_execution_start',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        input: { command: 'pwd' },
      },
    })

    expect(
      deriveSemanticTurnEventFromHookDerivedEvent({
        type: 'tool_execution_end',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      })
    ).toEqual({
      eventKind: 'turn.tool_result',
      payload: {
        type: 'tool_execution_end',
        toolUseId: 'tool-2',
        toolName: 'Bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      },
    })
  })

  it('maps launch message_end callbacks into semantic turn messages', () => {
    expect(
      deriveSemanticTurnEventFromLaunchEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final answer' }],
        },
      })
    ).toEqual({
      eventKind: 'turn.message',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: 'final answer',
        },
      },
    })
  })

  it('extracts assistant text from Stop hook transcript_path', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'hrc-hook-message-'))
    try {
      const transcriptPath = join(tmp, 'transcript.jsonl')
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'final from transcript' }] },
          }),
        ].join('\n'),
        'utf-8'
      )

      expect(
        deriveSemanticTurnMessageFromHookPayload({
          hook_event_name: 'Stop',
          transcript_path: transcriptPath,
        })
      ).toEqual({
        eventKind: 'turn.message',
        payload: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: 'final from transcript',
          },
        },
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('falls back to last_response when transcript extraction is unavailable', () => {
    expect(
      deriveSemanticTurnMessageFromHookPayload({
        hook_event_name: 'Stop',
        transcript_path: '/no/such/transcript.jsonl',
        last_response: 'final from last_response',
      })
    ).toEqual({
      eventKind: 'turn.message',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: 'final from last_response',
        },
      },
    })
  })

  it('maps Codex Stop last_assistant_message into a semantic turn message', () => {
    expect(
      deriveSemanticTurnMessageFromHookPayload({
        hook_event_name: 'Stop',
        last_assistant_message: 'final from codex stop',
      })
    ).toEqual({
      eventKind: 'turn.message',
      payload: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: 'final from codex stop',
        },
      },
    })
  })
})
