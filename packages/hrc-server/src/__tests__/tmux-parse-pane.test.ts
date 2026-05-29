/**
 * Unit tests for parsePaneState — the tmux `list-panes -F` / `new-session -F`
 * output parser. Covers both the normal tab-separated output and the
 * underscore-separated fallback tmux emits when LANG is unset (seen under
 * launchd, which does not inherit the user shell's locale).
 */
import { describe, expect, it } from 'bun:test'

import { parsePaneLiveness, parsePaneState } from '../tmux'

const SOCKET = '/tmp/test-tmux.sock'

describe('parsePaneState', () => {
  it('parses tab-separated metadata (normal locale)', () => {
    const state = parsePaneState('$0\t@0\t%0\thrc-hsid-61dc42b\n', SOCKET)
    expect(state).toEqual({
      socketPath: SOCKET,
      sessionName: 'hrc-hsid-61dc42b',
      windowName: 'main',
      sessionId: '$0',
      windowId: '@0',
      paneId: '%0',
    })
  })

  it('parses underscore-separated metadata (launchd/unset LANG fallback)', () => {
    const state = parsePaneState('$3_@3_%3_hrc-hsid-61dc42b\n', SOCKET)
    expect(state).toEqual({
      socketPath: SOCKET,
      sessionName: 'hrc-hsid-61dc42b',
      windowName: 'main',
      sessionId: '$3',
      windowId: '@3',
      paneId: '%3',
    })
  })

  it('preserves multi-digit ids and dashes in session names', () => {
    const state = parsePaneState('$12\t@34\t%567\tmy-project-main\n', SOCKET)
    expect(state.sessionId).toBe('$12')
    expect(state.windowId).toBe('@34')
    expect(state.paneId).toBe('%567')
    expect(state.sessionName).toBe('my-project-main')
  })

  it('trims surrounding whitespace and picks the first non-empty line', () => {
    const state = parsePaneState('\n  $1\t@1\t%1\tfoo  \n\n', SOCKET)
    expect(state.sessionId).toBe('$1')
    expect(state.sessionName).toBe('foo')
  })

  it('throws on empty output', () => {
    expect(() => parsePaneState('\n\n', SOCKET)).toThrow('did not return pane metadata')
  })

  it('throws on malformed lines that match neither separator shape', () => {
    expect(() => parsePaneState('garbage with no prefixes\n', SOCKET)).toThrow(
      /unexpected tmux metadata line/
    )
  })
})

describe('parsePaneLiveness', () => {
  it('treats a non-dead pane running the exec wrapper (bun) as live', () => {
    expect(parsePaneLiveness('0\tbun\n')).toEqual({
      alive: true,
      dead: false,
      currentCommand: 'bun',
    })
  })

  it('treats a re-exec to node/codex/claude as live', () => {
    expect(parsePaneLiveness('0\tnode').alive).toBe(true)
    expect(parsePaneLiveness('0\tcodex').alive).toBe(true)
    expect(parsePaneLiveness('0\tclaude').alive).toBe(true)
  })

  it('treats a bare shell foreground as NOT live (failed exec / harness exited)', () => {
    expect(parsePaneLiveness('0\tzsh').alive).toBe(false)
    expect(parsePaneLiveness('0\tbash').alive).toBe(false)
    expect(parsePaneLiveness('0\tsh').alive).toBe(false)
    expect(parsePaneLiveness('0\tfish').alive).toBe(false)
  })

  it('treats a login shell (leading dash) as NOT live', () => {
    expect(parsePaneLiveness('0\t-zsh').alive).toBe(false)
    expect(parsePaneLiveness('0\t-bash').alive).toBe(false)
  })

  it('treats a dead pane as NOT live regardless of command', () => {
    expect(parsePaneLiveness('1\tbun')).toEqual({
      alive: false,
      dead: true,
      currentCommand: 'bun',
    })
  })

  it('parses the underscore-separated fallback (launchd/unset LANG)', () => {
    expect(parsePaneLiveness('0_bun').alive).toBe(true)
    expect(parsePaneLiveness('0_zsh').alive).toBe(false)
    expect(parsePaneLiveness('1_bun').dead).toBe(true)
  })

  it('reassembles a command containing underscores under the fallback separator', () => {
    expect(parsePaneLiveness('0_my_tool')).toEqual({
      alive: true,
      dead: false,
      currentCommand: 'my_tool',
    })
  })

  it('treats empty/whitespace output as NOT live without throwing', () => {
    expect(parsePaneLiveness('\n\n')).toEqual({
      alive: false,
      dead: false,
      currentCommand: '',
    })
  })
})
