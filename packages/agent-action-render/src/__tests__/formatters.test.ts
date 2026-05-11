import { describe, expect, test } from 'bun:test'

import {
  extractToolPreview,
  formatEventPreviewLine,
  formatNoticeLine,
  formatToolLine,
  getHrcEventIcon,
  getToolEmoji,
  renderMarkdownBlock,
} from '../index.js'

describe('agent action render helpers', () => {
  test('keeps Discord tool formatting stable', () => {
    expect(getToolEmoji('Read')).toBe('📖')
    expect(extractToolPreview('Bash', { command: 'ls -la', description: 'list' }, '')).toBe(
      'ls -la'
    )
    expect(formatToolLine('Read', { file_path: '/src/index.ts' }, '', false)).toBe(
      '📖 Read: "/src/index.ts"'
    )
    expect(formatToolLine('Read', { file_path: '/src/index.ts' }, '', true)).toBe(
      '❌ Read: "/src/index.ts"'
    )
    expect(
      formatToolLine('Bash', { command: 'x'.repeat(200) }, '', false).length
    ).toBeLessThanOrEqual(80)
  })

  test('formats notice lines', () => {
    expect(formatNoticeLine('info', 'connected')).toBe('ℹ️ connected')
    expect(formatNoticeLine('warn', 'slow query')).toBe('⚠️ slow query')
    expect(formatNoticeLine('error', 'crash')).toBe('❌ crash')
  })

  test('maps HRC event icons', () => {
    expect(getHrcEventIcon('tool_execution_start', { toolName: 'exec_command' })).toBe('💻')
    expect(getHrcEventIcon('tool_execution_end', { toolName: 'apply_patch' })).toBe('🔧')
    expect(getHrcEventIcon('codex.user_prompt')).toBe('💬')
    expect(getHrcEventIcon('turn.user_prompt')).toBe('💬')
    expect(getHrcEventIcon('message_end')).toBe('✉️')
    expect(getHrcEventIcon('runtime.dead')).toBe('💀')
  })

  test('formats narrative event previews from primary payload fields', () => {
    expect(
      formatEventPreviewLine({
        icon: '💬',
        eventKind: 'codex.user_prompt',
        preview: 'You are starting an ACP workflow\nparticipant run.',
      })
    ).toBe('💬 codex.user_prompt  "You are starting an ACP workflow participant run."')
  })

  test('renders markdown blocks with wrapping and truncation', () => {
    const lines = renderMarkdownBlock('- one\n- two\n- three', {
      width: 20,
      maxLines: 2,
      style: 'plain',
    })
    expect(lines).toEqual(['• one', '… 2 more lines'])
  })
})
