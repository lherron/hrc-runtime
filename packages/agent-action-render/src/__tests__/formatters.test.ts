import { describe, expect, test } from 'bun:test'

import {
  admissionLabel,
  admissionLabelFromResponse,
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
      '📖 Read: /src/index.ts'
    )
    expect(formatToolLine('Read', { file_path: '/src/index.ts' }, '', true)).toBe(
      '❌ Read: /src/index.ts'
    )
    expect(
      formatToolLine('Bash', { command: 'x'.repeat(200) }, '', false).length
    ).toBeLessThanOrEqual(80)
  })

  test('renders Bash clean commands with a shell display label', () => {
    expect(formatToolLine('Bash', { command: 'ls -la' }, '', false)).toBe('💻 shell: ls -la')
  })

  test('unwraps zsh shell wrappers for command_execution display', () => {
    expect(
      formatToolLine('command_execution', { command: "/bin/zsh -lc 'ls -la'" }, '', false)
    ).toBe('💻 shell: ls -la')
  })

  test('unwraps unquoted shell wrapper commands for command_execution display', () => {
    expect(formatToolLine('command_execution', { command: '/bin/zsh -lc pwd' }, '', false)).toBe(
      '💻 shell: pwd'
    )
  })

  test('unwraps double-quoted bash wrappers for command_execution display', () => {
    expect(formatToolLine('command_execution', { command: 'bash -c "cd x && y"' }, '', false)).toBe(
      '💻 shell: cd x && y'
    )
  })

  test('unwraps single-quoted sh wrappers for command_execution display', () => {
    expect(formatToolLine('command_execution', { command: "sh -c 'echo hi'" }, '', false)).toBe(
      '💻 shell: echo hi'
    )
  })

  test('renders command_execution with shell metacharacters as shell display', () => {
    expect(formatToolLine('command_execution', { command: 'ls | grep foo' }, '', false)).toBe(
      '💻 shell: ls | grep foo'
    )
  })

  test('keeps command_execution direct binaries under the wire label', () => {
    expect(formatToolLine('command_execution', { command: 'cat package.json' }, '', false)).toBe(
      '⚙️ command_execution: cat package.json'
    )
  })

  test('falls back gracefully for malformed shell wrappers', () => {
    const command = "/bin/zsh -lc 'echo \\'hi\\''"
    const line = formatToolLine('command_execution', { command }, '', false)
    expect(line).toContain(command)
  })

  test('unwraps exec_command cmd shell wrappers for display', () => {
    expect(formatToolLine('exec_command', { cmd: "/bin/bash -lc 'pwd'" }, '', false)).toBe(
      '💻 shell: pwd'
    )
  })

  test('unwraps unquoted exec_command cmd shell wrappers for display', () => {
    expect(formatToolLine('exec_command', { cmd: '/bin/bash -lc pwd' }, '', false)).toBe(
      '💻 shell: pwd'
    )
  })

  test('renders failed Bash as a failed shell display line', () => {
    expect(formatToolLine('Bash', { command: 'false' }, '', true)).toBe('❌ shell: false')
  })

  test('keeps Read tool formatting unchanged', () => {
    expect(formatToolLine('Read', { file_path: '/src/index.ts' }, '', false)).toBe(
      '📖 Read: /src/index.ts'
    )
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

  test('passes fenced code block delimiters through unchanged', () => {
    const lines = renderMarkdownBlock('```\n- not a bullet\n```', {
      width: 80,
      maxLines: 10,
      style: 'plain',
    })
    expect(lines[0]).toBe('```')
    expect(lines[lines.length - 1]).toBe('```')
  })

  test('maps additional HRC event icons and fallbacks', () => {
    expect(getHrcEventIcon('codex.tool_decision')).toBe('⚖️')
    expect(getHrcEventIcon('sdk.message')).toBe('🤖')
    expect(getHrcEventIcon('message_chunk')).toBe('🤖')
    expect(getHrcEventIcon('hook.ingested')).toBe('🪝')
    expect(getHrcEventIcon('anything', { failed: true })).toBe('❌')
    expect(getHrcEventIcon('notice', { level: 'warn' })).toBe('⚠️')
    expect(getHrcEventIcon('notice', { level: 'error' })).toBe('❌')
    expect(getHrcEventIcon('notice')).toBe('ℹ️')
    expect(getHrcEventIcon('tool_execution_start')).toBe('⚙️')
    expect(getHrcEventIcon('unknown.kind')).toBe('⚙️')
  })
})

describe('admission labels', () => {
  test('maps each admission eventKind to its mandated label', () => {
    expect(admissionLabel({ eventKind: 'input.application.accepted' })).toBe(
      'Contribution accepted'
    )
    expect(admissionLabel({ eventKind: 'input.application.pending' })).toBe('Contribution pending')
    expect(admissionLabel({ eventKind: 'input.application.ambiguous' })).toBe(
      'Contribution ambiguous'
    )
    expect(admissionLabel({ eventKind: 'input.application.failed' })).toBe('Contribution failed')
    expect(admissionLabel({ eventKind: 'input.rejected' })).toBe('Input rejected')
    expect(admissionLabel({ eventKind: 'input.queued' })).toBe('Queued')
    expect(
      admissionLabel({
        eventKind: 'input.queued',
        reason: 'contribution_unsupported_fallback_queued',
      })
    ).toBe('Unsupported contribution fallback queued')
    expect(admissionLabel({ eventKind: 'input.admitted' })).toBe('Input admitted')
    expect(admissionLabel({ eventKind: 'input.dispatching' })).toBe('Dispatching queued work')
    expect(admissionLabel({ eventKind: 'input.started' })).toBe('Input started')
    expect(admissionLabel({ eventKind: 'input.queue.expired' })).toBe('Queued input expired')
  })

  test('never uses the forbidden steered/applied wording', () => {
    expect(admissionLabel({ eventKind: 'input.application.accepted' })).not.toContain('applied')
    expect(admissionLabel({ eventKind: 'input.application.accepted' })).not.toContain('steered')
  })

  test('falls back to the raw eventKind for unknown kinds', () => {
    expect(admissionLabel({ eventKind: 'totally.unknown' })).toBe('totally.unknown')
  })

  test('derives labels from send response payloads per branch', () => {
    expect(
      admissionLabelFromResponse({
        admission: { kind: 'accepted_in_flight' },
        inputApplication: { status: 'accepted' },
      })
    ).toBe('Contribution accepted')
    expect(
      admissionLabelFromResponse({
        admission: { kind: 'admission_pending' },
        inputApplication: { status: 'pending' },
      })
    ).toBe('Contribution pending')
    expect(
      admissionLabelFromResponse({
        currentState: { applicationStatus: 'ambiguous' },
      })
    ).toBe('Contribution ambiguous')
    expect(
      admissionLabelFromResponse({
        currentState: { reason: 'contribution_unsupported_fallback_queued' },
      })
    ).toBe('Unsupported contribution fallback queued')
    expect(admissionLabelFromResponse({ admission: { kind: 'queued_run' } })).toBe('Queued')
  })

  test('keeps admission response precedence stable', () => {
    expect(
      admissionLabelFromResponse({
        admission: { kind: 'queued_run' },
        currentState: {
          applicationStatus: 'ambiguous',
          reason: 'contribution_unsupported_fallback_queued',
        },
      })
    ).toBe('Contribution ambiguous')
    expect(
      admissionLabelFromResponse({
        admission: { kind: 'queued_run' },
        currentState: { reason: 'contribution_unsupported_fallback_queued' },
      })
    ).toBe('Unsupported contribution fallback queued')
  })

  test('falls back to applicationStatus, then admissionKind, then empty string', () => {
    expect(admissionLabelFromResponse({ inputApplication: { status: 'some_status' } })).toBe(
      'some_status'
    )
    expect(admissionLabelFromResponse({ admission: { kind: 'some_kind' } })).toBe('some_kind')
    expect(admissionLabelFromResponse({})).toBe('')
  })
})
