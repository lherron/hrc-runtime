import { describe, expect, it } from 'bun:test'

import { interpretHrcTopKey } from './keymap.js'

describe('hrc-top keymap', () => {
  it('maps vi movement and mark prefixes to navigation intents', () => {
    expect(interpretHrcTopKey('j').intent).toEqual({ type: 'key', key: 'j' })
    expect(interpretHrcTopKey('G').intent).toEqual({ type: 'key', key: 'G' })
    expect(interpretHrcTopKey('\u0004').intent).toEqual({ type: 'key', key: 'ctrl-d' })

    const g = interpretHrcTopKey('g')
    expect(g.prefix).toBe('g')
    expect(interpretHrcTopKey('g', g.prefix).intent).toEqual({ type: 'key', key: 'gg' })

    const mark = interpretHrcTopKey('m')
    expect(mark.prefix).toBe('mark')
    expect(interpretHrcTopKey('x', mark.prefix).intent).toEqual({ type: 'mark', name: 'x' })

    const jump = interpretHrcTopKey("'")
    expect(jump.prefix).toBe('jump')
    expect(interpretHrcTopKey('x', jump.prefix).intent).toEqual({
      type: 'jumpToMark',
      name: 'x',
    })
  })

  it('maps enter to read-only focus and q to back/quit', () => {
    expect(interpretHrcTopKey('\r').intent).toEqual({ type: 'focus' })
    expect(interpretHrcTopKey('q').intent).toEqual({ type: 'quit' })
  })

  it('maps action keys and command entry for the live TUI loop', () => {
    expect(interpretHrcTopKey(':').intent).toEqual({ type: 'command' })
    for (const key of ['o', 'a', 'r', 'R', 'e', 'c', 'i', 'p', 's', 'y']) {
      expect(interpretHrcTopKey(key).intent).toEqual({ type: 'action', key })
    }
  })

  it('maps . to the show-all (faint idle tail) toggle', () => {
    expect(interpretHrcTopKey('.').intent).toEqual({ type: 'toggleShowAll' })
  })
})
