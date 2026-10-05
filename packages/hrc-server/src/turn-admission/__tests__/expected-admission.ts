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
  'literal-flush': ['enqueue'],
  dm: ['enqueue'],
  'turn-handoff': ['enqueue'],
  'runtime-start-prompt': ['enqueue'],
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
  'literal-flush': {
    enabled: true,
    freshContext: 'not on the wire contract; literal flush accepts text and enter only',
    proof: [],
    replay: 'not on the wire contract; literal flush has no idempotency field',
    nonTmuxDelivery:
      'broker literal flush requires a live tmux runtime; headless, cold and SDK rows do not submit',
    nonSubmitting:
      'enter:false and empty Enter on an empty buffer remain keystrokes, not submissions',
  },
  dm: {
    enabled: true,
    freshContext:
      'not accepted by this door; semantic DM rejects freshContext before target lookup',
    proof: [],
    replay: 'not on the wire contract; semantic DM has no idempotency field',
  },
  'turn-handoff': {
    enabled: true,
    freshContext: true,
    proof: [],
    replay: 'not on the wire contract; turn handoff has no input idempotency field',
  },
  'runtime-start-prompt': {
    enabled: true,
    freshContext: 'not on the wire contract; START accepts restartStyle instead',
    proof: [],
    replay:
      'claim idempotencyKey identifies the claim, not the input; claim replay re-runs startRuntimeForSession by design (roster-claim.ts:193-197, exact-claim.ts:163-166); input-idempotent claim replay is out of R1 scope.',
    participantDelivery:
      'START retains its participant_address_reserved refusal; participants cannot be cold-born',
  },
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
