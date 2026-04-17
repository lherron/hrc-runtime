import { describe, expect, it } from 'bun:test'
import { formatToolSummary, normalizeClaudeHook } from '../hook-normalizer.js'

describe('normalizeClaudeHook', () => {
  it('normalizes PreToolUse into tool_execution_start', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tu_123',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    })

    expect(result.hookName).toBe('PreToolUse')
    expect(result.isCompletion).toBe(false)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'tool_execution_start',
      toolUseId: 'tu_123',
      toolName: 'Bash',
      input: { command: 'ls -la' },
    })
    expect(result.progress?.message).toContain('ls -la')
  })

  it('normalizes PostToolUse into tool_execution_end', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tu_456',
      tool_name: 'Read',
      tool_input: { file_path: '/foo/bar.ts' },
      tool_response: 'file contents here',
      is_error: false,
    })

    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.type).toBe('tool_execution_end')
    if (event.type === 'tool_execution_end') {
      expect(event.toolUseId).toBe('tu_456')
      expect(event.toolName).toBe('Read')
      expect(event.isError).toBe(false)
      expect(event.result.content[0]).toEqual({ type: 'text', text: 'file contents here' })
    }
  })

  it('normalizes PostToolUse with is_error=true', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tu_err',
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: 'command failed',
      is_error: true,
    })

    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.type).toBe('tool_execution_end')
    if (event.type === 'tool_execution_end') {
      expect(event.isError).toBe(true)
    }
  })

  it('normalizes Notification with toolUseId into tool_execution_update', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'Notification',
      tool_use_id: 'tu_789',
      message: 'Processing...',
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'tool_execution_update',
      toolUseId: 'tu_789',
      message: 'Processing...',
    })
  })

  it('normalizes Notification without toolUseId into notice', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'Notification',
      message: 'General info',
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'notice',
      level: 'info',
      message: 'General info',
    })
  })

  it('normalizes PreCompact into context_compaction', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'PreCompact',
      trigger: 'auto',
      custom_instructions: 'keep tests',
      extra_field: 42,
    })

    expect(result.events).toHaveLength(1)
    const event = result.events[0]!
    expect(event.type).toBe('context_compaction')
    if (event.type === 'context_compaction') {
      expect(event.trigger).toBe('auto')
      expect(event.customInstructions).toBe('keep tests')
      expect(event.details).toEqual({ extra_field: 42 })
    }
  })

  it('normalizes SubagentStart', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'SubagentStart',
      agent_id: 'sub-1',
      agent_type: 'code-reviewer',
    })

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'subagent_start',
      agentId: 'sub-1',
      agentType: 'code-reviewer',
    })
  })

  it('marks Stop as completion with no events', () => {
    const result = normalizeClaudeHook({ hook_event_name: 'Stop' })
    expect(result.isCompletion).toBe(true)
    expect(result.events).toHaveLength(0)
    expect(result.hookName).toBe('Stop')
  })

  it('marks SessionEnd as completion', () => {
    const result = normalizeClaudeHook({ hook_event_name: 'SessionEnd' })
    expect(result.isCompletion).toBe(true)
  })

  it('marks SubagentStop as completion', () => {
    const result = normalizeClaudeHook({ hook_event_name: 'SubagentStop' })
    expect(result.isCompletion).toBe(true)
  })

  it('returns empty events for unrecognized hooks', () => {
    const result = normalizeClaudeHook({ hook_event_name: 'SomeFutureHook' })
    expect(result.events).toHaveLength(0)
    expect(result.isCompletion).toBe(false)
    expect(result.hookName).toBe('SomeFutureHook')
  })

  it('skips event when PreToolUse has no toolUseId', () => {
    const result = normalizeClaudeHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    })
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBeDefined()
  })

  describe('wrapped HRC envelope shape', () => {
    it('unwraps { kind, hookEvent: { hook_event_name, ... } } for PreToolUse', () => {
      const result = normalizeClaudeHook({
        kind: 'turn.started',
        hookEvent: {
          hook_event_name: 'PreToolUse',
          tool_use_id: 'tu_wrapped',
          tool_name: 'Bash',
          tool_input: { command: 'echo wrapped' },
        },
      })

      expect(result.hookName).toBe('PreToolUse')
      expect(result.events).toHaveLength(1)
      expect(result.events[0]).toEqual({
        type: 'tool_execution_start',
        toolUseId: 'tu_wrapped',
        toolName: 'Bash',
        input: { command: 'echo wrapped' },
      })
    })

    it('unwraps PostToolUse from wrapped shape', () => {
      const result = normalizeClaudeHook({
        kind: 'turn.stopped',
        hookEvent: {
          hook_event_name: 'PostToolUse',
          tool_use_id: 'tu_wrapped2',
          tool_name: 'Read',
          tool_input: { file_path: '/foo.ts' },
          tool_response: 'contents',
          is_error: false,
        },
      })

      expect(result.hookName).toBe('PostToolUse')
      expect(result.events).toHaveLength(1)
      expect(result.events[0]!.type).toBe('tool_execution_end')
    })

    it('unwraps Stop from wrapped shape', () => {
      const result = normalizeClaudeHook({
        kind: 'turn.stopped',
        hookEvent: { hook_event_name: 'Stop' },
      })

      expect(result.hookName).toBe('Stop')
      expect(result.isCompletion).toBe(true)
    })

    it('falls back to top-level when hookEvent has no hook_event_name', () => {
      const result = normalizeClaudeHook({
        kind: 'turn.started',
        hookEvent: { someOtherField: true },
      })

      expect(result.hookName).toBe('unknown')
      expect(result.events).toHaveLength(0)
    })
  })
})

describe('formatToolSummary', () => {
  it('formats Bash commands', () => {
    expect(formatToolSummary('Bash', { command: 'ls -la' })).toBe('`ls -la`')
  })

  it('formats Read paths', () => {
    expect(formatToolSummary('Read', { file_path: '/foo/bar.ts' })).toBe('Read `/foo/bar.ts`')
  })

  it('formats Edit with filename only', () => {
    expect(formatToolSummary('Edit', { file_path: '/a/b/component.tsx' })).toBe('component.tsx')
  })

  it('truncates long values', () => {
    const long = 'x'.repeat(100)
    const result = formatToolSummary('Bash', { command: long })
    expect(result.length).toBeLessThan(100)
    expect(result).toContain('\u2026')
  })

  it('falls back to tool name when no input', () => {
    expect(formatToolSummary('Unknown', undefined)).toBe('Unknown')
  })
})
