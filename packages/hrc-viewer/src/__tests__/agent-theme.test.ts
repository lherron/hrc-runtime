/**
 * T-04439 — agent identity theme (curated cast + deterministic hash fallback).
 */

import { describe, expect, it } from 'bun:test'

import {
  CURATED_AGENT_COLORS,
  CURATED_TERMINAL_TINTS,
  agentTheme,
  contrastForeground,
  terminalTint,
} from '../agent-theme.js'

const HEX = /^#[0-9a-f]{6}$/i

function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

describe('agentTheme', () => {
  it('returns the curated color for known agents', () => {
    expect(agentTheme('clod').bg).toBe('#6B4FB0')
    expect(agentTheme('daedalus').bg).toBe('#2F5FA6')
    expect(agentTheme('smokey').bg).toBe('#B5562E')
  })

  it('is case-insensitive for curated agents', () => {
    expect(agentTheme('CLOD').bg).toBe(CURATED_AGENT_COLORS.clod)
    expect(agentTheme('  Daedalus ').bg).toBe(CURATED_AGENT_COLORS.daedalus)
  })

  it('derives a deterministic color for unlisted agents', () => {
    const a = agentTheme('some-random-agent')
    const b = agentTheme('some-random-agent')
    expect(a.bg).toBe(b.bg)
    expect(a.bg).toMatch(HEX)
    expect(CURATED_AGENT_COLORS).not.toHaveProperty('some-random-agent')
  })

  it('gives different unlisted agents different colors', () => {
    expect(agentTheme('alpha').bg).not.toBe(agentTheme('beta').bg)
  })

  it('gives every curated agent a foreground that is the higher-contrast choice', () => {
    for (const [agent, bg] of Object.entries(CURATED_AGENT_COLORS)) {
      const fg = agentTheme(agent).fg
      expect(fg).toBe(contrastForeground(bg))
      expect(['#F2EEE6', '#15110C']).toContain(fg)
    }
  })

  it('switches the foreground by luminance', () => {
    expect(contrastForeground('#000000')).toBe('#F2EEE6') // dark bg → light fg
    expect(contrastForeground('#FFFFFF')).toBe('#15110C') // light bg → dark fg
  })

  it('gives every curated agent a distinct dark-band terminal tint', () => {
    for (const agent of Object.keys(CURATED_AGENT_COLORS)) {
      const t = agentTheme(agent)
      expect(t.terminalBg).toMatch(HEX)
      // distinct from the saturated statusbar color, and forced dark for readability
      expect(t.terminalBg.toLowerCase()).not.toBe(t.bg.toLowerCase())
      expect(luminance(t.terminalBg)).toBeLessThan(0.06)
    }
  })

  it('derives the terminal tint deterministically for unlisted agents', () => {
    expect(agentTheme('mystery').terminalBg).toBe(agentTheme('mystery').terminalBg)
    expect(agentTheme('mystery').terminalBg).toMatch(HEX)
    expect(luminance(agentTheme('mystery').terminalBg)).toBeLessThan(0.06)
  })

  it('prefers a per-agent terminal-tint override over the derived tint (T-07995)', () => {
    expect(agentTheme('chief').terminalBg).toBe('#41161c')
    // the override replaces the derived value rather than coinciding with it
    expect(agentTheme('chief').terminalBg).not.toBe(terminalTint(CURATED_AGENT_COLORS.chief))
    // and it does not disturb the statusbar identity color
    expect(agentTheme('chief').bg).toBe(CURATED_AGENT_COLORS.chief)
  })

  it('overrides exactly the agents we intend, and no others (T-07995)', () => {
    // The map IS the leak surface: an accidental entry silently repaints an agent,
    // and a skip-the-overridden loop can never catch it. Pin the roster instead.
    expect(Object.keys(CURATED_TERMINAL_TINTS).sort()).toEqual(['chief'])
  })

  it('leaves every non-overridden agent on the derived tint (T-07995)', () => {
    for (const [agent, bg] of Object.entries(CURATED_AGENT_COLORS)) {
      if (agent in CURATED_TERMINAL_TINTS) continue
      expect(agentTheme(agent).terminalBg).toBe(terminalTint(bg))
    }
  })

  it('holds overrides to the same dark band as derived tints (T-07995)', () => {
    for (const tint of Object.values(CURATED_TERMINAL_TINTS)) {
      expect(tint).toMatch(HEX)
      expect(luminance(tint)).toBeLessThan(0.06)
    }
  })

  it('gives every curated agent a statusbar color distinct from the rest (T-07980)', () => {
    const seen = new Map<string, string>()
    for (const [agent, bg] of Object.entries(CURATED_AGENT_COLORS)) {
      const prior = seen.get(bg.toLowerCase())
      expect(prior, `${agent} duplicates ${prior}'s color ${bg}`).toBeUndefined()
      seen.set(bg.toLowerCase(), agent)
    }
  })

  it('keeps the hue when forcing a color into the dark tint band', () => {
    // a saturated red stays reddish (R dominant) after darkening
    const tint = terminalTint('#FF0000')
    const n = tint.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(n.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g)
    expect(r).toBeGreaterThan(b)
  })
})
