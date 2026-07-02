import type { HrcTargetOperatorDisplayState } from 'hrc-core'

/**
 * `hrc top` triage-board theme (T-05412).
 *
 * Terminal truecolor palette + a pure ANSI painter. This is PRESENTATION ONLY:
 * it maps semantic tokens (state color, luminance tier) to SGR escape codes.
 * The palette hex values are the reconciled design tokens — semantic, not brand.
 *
 * Luminance is the hierarchy: state color (brightest) > ink (handles) > dim
 * (metadata) > faint (the idle sea, ~2 steps below actionable rows — that gap is
 * the whole design) > ghost (chrome/labels). Weight (bold) is the second axis.
 */

export const PALETTE = {
  // Surfaces
  bg: '#0b0f14',
  selectedBg: '#152030',
  rule: '#1a2230',
  // Text tiers (luminance = hierarchy)
  ink: '#e8eef5',
  dim: '#7f8b99',
  faint: '#464f5d',
  ghost: '#2a323d',
  // State colors (semantic)
  input: '#f2c14e', // amber — the single loudest hue: "you are the blocker"
  busy: '#4aa3ff', // blue
  ready: '#3fb950', // green
  dormant: '#b585ff', // violet (resumable)
  stale: '#e0873d', // orange
  broken: '#f2545b', // red
} as const

export type PaletteToken = keyof typeof PALETTE

/**
 * State color per projected display state. `headless` is a live-but-not-you
 * background state — it rides the faint tier, not a loud hue. `ambiguous` shares
 * the broken red (both live in the ATTENTION group and want a human).
 */
export function stateColorHex(state: HrcTargetOperatorDisplayState): string {
  switch (state) {
    case 'input':
      return PALETTE.input
    case 'busy':
      return PALETTE.busy
    case 'starting':
      return PALETTE.busy
    case 'ready':
      return PALETTE.ready
    case 'dormant':
      return PALETTE.dormant
    case 'stale':
      return PALETTE.stale
    case 'broken':
      return PALETTE.broken
    case 'ambiguous':
      return PALETTE.broken
    case 'headless':
      return PALETTE.dim
  }
}

export type StyleSpec = {
  fg?: string | undefined
  bg?: string | undefined
  bold?: boolean | undefined
}

export type Painter = {
  readonly enabled: boolean
  paint(text: string, spec: StyleSpec): string
}

const RESET = '[0m'

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return [r, g, b]
}

/** Build an SGR prefix for a style spec (no reset). Empty when spec is empty. */
export function sgrPrefix(spec: StyleSpec): string {
  const codes: string[] = []
  if (spec.bold) codes.push('1')
  if (spec.fg) {
    const [r, g, b] = hexToRgb(spec.fg)
    codes.push(`38;2;${r};${g};${b}`)
  }
  if (spec.bg) {
    const [r, g, b] = hexToRgb(spec.bg)
    codes.push(`48;2;${r};${g};${b}`)
  }
  return codes.length > 0 ? `[${codes.join(';')}m` : ''
}

/**
 * A painter serializes styled text to ANSI when enabled, or returns the plain
 * text unchanged when disabled (piped output / snapshot tests). Keeping color a
 * gate at serialization time — not baked into the view-model — is what keeps the
 * render pure and snapshot-legible.
 */
export function createPainter(enabled: boolean): Painter {
  return {
    enabled,
    paint(text: string, spec: StyleSpec): string {
      if (!enabled) return text
      const prefix = sgrPrefix(spec)
      if (prefix === '') return text
      return `${prefix}${text}${RESET}`
    },
  }
}
