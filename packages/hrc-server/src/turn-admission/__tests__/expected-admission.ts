import type { SubmissionDoorKind } from '../types'

export const DRIVERS = [
  'v2-headless',
  'format1-headless',
  'tmux-live',
  'tmux-cold',
  'sdk',
  'participant',
] as const
export type Driver = (typeof DRIVERS)[number]
export const DOORS = {
  submission: ['invoke', 'enqueue', 'preempt', 'steer'],
  turns: ['invoke'],
  'turns-by-selector': [],
  'literal-flush': [],
  dm: [],
  'turn-handoff': [],
  'runtime-start-prompt': [],
  'prepare-attached': [],
} as const satisfies Record<SubmissionDoorKind, readonly string[]>
export const EXPECTED = {
  submission: {
    enabled: true,
    freshContext: true,
    proof: ['invoke', 'enqueue', 'preempt'],
    replay: true,
  },
  turns: {
    enabled: true,
    freshContext: 'not on the wire contract; parser rejects unknown field',
    proof: ['invoke'],
    replay: true,
  },
  'turns-by-selector': { enabled: false, reason: 'phase 2' },
  'literal-flush': { enabled: false, reason: 'phase 3' },
  dm: { enabled: false, reason: 'phase 2' },
  'turn-handoff': { enabled: false, reason: 'phase 3' },
  'runtime-start-prompt': { enabled: false, reason: 'phase 3' },
  'prepare-attached': { enabled: false, reason: 'phase 2' },
} as const satisfies Record<SubmissionDoorKind, object>

// The whole trace, including cells that did not execute, is part of each expectation.
export function expectedTrace(
  driver: Driver,
  cell: 'drain' | 'retired' | 'format-replay-refusal' | 'replay' | 'accepted'
): readonly string[] {
  const refusedAt = { drain: 0, retired: 1, 'format-replay-refusal': 2 } as const
  if (cell in refusedAt) {
    const index = refusedAt[cell as keyof typeof refusedAt]
    return Array.from({ length: 9 }, (_, step) =>
      step < index ? 'passed' : step === index ? 'refused' : 'not-reached'
    )
  }
  if (cell === 'replay')
    return ['passed', 'passed', 'replayed', ...Array<string>(6).fill('skipped:replay')]
  return [
    'passed',
    'passed',
    'skipped:not-carried',
    driver === 'participant' ? 'passed' : 'skipped:not-applicable',
    'skipped:not-carried',
    'passed',
    'passed',
    driver === 'participant' ? 'skipped:not-applicable' : 'passed',
    'passed',
  ]
}

export const DELIVERY_INAPPLICABLE = {
  sdk: 'SDK executor is retired; guard and replay cells still apply',
  'tmux-cold': 'cold launch carry is covered by t09643-launch-carried-door-identity.test.ts',
  'v2-headless':
    'format2 durable input and uncertainty are covered by t08207-public-ingress.test.ts and uncertainty-ledger.test.ts',
} as const
