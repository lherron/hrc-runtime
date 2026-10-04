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
  'turns-by-selector': ['enqueue'],
  'literal-flush': [],
  dm: ['enqueue'],
  'turn-handoff': [],
  'runtime-start-prompt': [],
  'prepare-attached': ['invoke'],
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
  'turns-by-selector': {
    enabled: true,
    freshContext: 'not on the wire contract',
    proof: ['enqueue'],
    replay: 'not on the wire contract; selector door has no idempotency field',
  },
  'literal-flush': { enabled: false, reason: 'phase 3' },
  dm: {
    enabled: true,
    freshContext:
      'not accepted by this door; semantic DM rejects freshContext before target lookup',
    proof: [],
    replay: 'not on the wire contract; semantic DM has no idempotency field',
  },
  'turn-handoff': { enabled: false, reason: 'phase 3' },
  'runtime-start-prompt': { enabled: false, reason: 'phase 3' },
  'prepare-attached': {
    enabled: true,
    freshContext: 'not on the wire contract; prepare-attached has no freshContext field',
    proof: [],
    replay: 'not on the wire contract; prepare-attached has no idempotency field',
    legacyColdDelivery:
      'T-08596 retired the no-aspd compiler fallback; aspd_unconfigured is authoritative',
    headlessDelivery: 'attached delivery requires an attach surface; ordinary headless has none',
  },
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

// D14 continues admitted work and never has a second door trace.
export const QUEUE_CONTINUATION = {
  intentField: 'admittedIntent',
  legacyIntent: 'enqueue',
  readmitted: false,
} as const
