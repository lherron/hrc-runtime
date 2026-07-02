import { describe, expect, it } from 'bun:test'

import { PALETTE, createPainter, sgrPrefix, stateColorHex } from './theme.js'

describe('hrc-top theme', () => {
  it('maps each display state to a semantic palette hue', () => {
    expect(stateColorHex('input')).toBe(PALETTE.input)
    expect(stateColorHex('busy')).toBe(PALETTE.busy)
    expect(stateColorHex('starting')).toBe(PALETTE.busy)
    expect(stateColorHex('ready')).toBe(PALETTE.ready)
    expect(stateColorHex('dormant')).toBe(PALETTE.dormant)
    expect(stateColorHex('stale')).toBe(PALETTE.stale)
    expect(stateColorHex('broken')).toBe(PALETTE.broken)
    expect(stateColorHex('ambiguous')).toBe(PALETTE.broken)
    expect(stateColorHex('headless')).toBe(PALETTE.dim)
  })

  it('encodes truecolor fg/bg/bold into a single SGR prefix', () => {
    const ESC = ''
    // #f2c14e => 242;193;78
    expect(sgrPrefix({ fg: '#f2c14e', bold: true })).toBe(`${ESC}[1;38;2;242;193;78m`)
    expect(sgrPrefix({ bg: '#152030' })).toBe(`${ESC}[48;2;21;32;48m`)
    expect(sgrPrefix({})).toBe('')
  })

  it('painter emits ANSI when enabled and plain text when disabled', () => {
    const on = createPainter(true)
    const off = createPainter(false)
    expect(off.paint('needsYou', { fg: PALETTE.input })).toBe('needsYou')
    const painted = on.paint('needsYou', { fg: PALETTE.input })
    expect(painted).toContain('needsYou')
    expect(painted).toContain('38;2;242;193;78')
    expect(painted.endsWith('[0m')).toBe(true)
  })
})
