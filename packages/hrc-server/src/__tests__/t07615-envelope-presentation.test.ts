import { describe, expect, it } from 'bun:test'

import {
  type PresentableEnvelope,
  formatEnvelopePresentation,
  formatEnvelopePresentations,
} from '../wrkq/envelope-presentation.js'
import { targetSessionRefForLedgerScope } from '../wrkq/ledger-scope.js'
import type { WrkqEnvelope } from '../wrkq/ledger-types.js'
import { envelopeIdSequence } from '../wrkq/ledger-types.js'

/**
 * The §7 injection format and the wrkq↔HRC scope seam (T-07612, T-07615).
 */

const NOW = new Date('2026-08-27T12:00:00Z')

function envelope(overrides: Partial<WrkqEnvelope> = {}): WrkqEnvelope {
  return {
    uuid: 'uuid-EN-00042',
    id: 'EN-00042',
    roomUuid: 'room-T-07604',
    roomKey: 'T-07604',
    roomKind: 'task',
    from: { principalRef: 'agent:cody', scopeRef: 'cody@hrc-runtime:T-07604' },
    to: { principalRef: 'agent:clod', scopeRef: 'clod@hrc-runtime:T-07604' },
    obligation: 'reply_required',
    body: 'the body',
    state: 'presented',
    terminal: false,
    roundCount: 0,
    urgent: false,
    presentedTo: [],
    createdAt: '2026-08-27T10:00:00Z',
    updatedAt: '2026-08-27T10:00:00Z',
    ...overrides,
  }
}

function presentable(overrides: Partial<PresentableEnvelope> = {}): PresentableEnvelope {
  return {
    envelope: envelope(),
    historyHint: false,
    messageCount: 1,
    ...overrides,
  }
}

describe('T-07612 §7 presentation', () => {
  it('renders header, body, and one reply line — and never the envelope id', () => {
    const rendered = formatEnvelopePresentation(presentable({ senderGeneration: 3 }), NOW)
    expect(rendered).toBe(
      [
        '[T-07604 · cody@hrc-runtime:T-07604 (gen 3) → you · reply required]',
        'the body',
        "reply: wrkc say T-07604 --to cody@hrc-runtime:T-07604 - <<'EOF'",
        '…',
        'EOF',
      ].join('\n')
    )
    // EN ids are INTERNAL: inbox/show/log surface them, the injection must not.
    expect(rendered).not.toContain('EN-00042')
  })

  it('omits the generation when this node cannot see the sender', () => {
    expect(formatEnvelopePresentation(presentable(), NOW)).toContain(
      '[T-07604 · cody@hrc-runtime:T-07604 → you · reply required]'
    )
  })

  it('adds the history cue only when wrkq says the runtime is cold', () => {
    const cold = formatEnvelopePresentation(
      presentable({
        historyHint: true,
        messageCount: 14,
        lastMessageAt: '2026-08-27T10:00:00Z',
      }),
      NOW
    )
    expect(cold).toContain('history: wrkc log T-07604   (14 messages · last 2h ago)')
    // A cue, never the history itself: no room content is ever injected.
    expect(cold.split('\n')).toHaveLength(6)
  })

  it('never cues a brand-new room even when asked', () => {
    expect(
      formatEnvelopePresentation(presentable({ historyHint: false, messageCount: 1 }), NOW)
    ).not.toContain('history:')
  })

  it('ends a fyi header with fyi and gives it no reply line', () => {
    const rendered = formatEnvelopePresentation(
      presentable({ envelope: envelope({ obligation: 'fyi' }) }),
      NOW
    )
    expect(rendered).toContain('→ you · fyi]')
    expect(rendered).not.toContain('reply:')
  })

  it('quotes an ad-hoc room subject and addresses its key', () => {
    const rendered = formatEnvelopePresentation(
      presentable({
        envelope: envelope({
          roomKey: 'R-00012',
          roomKind: 'adhoc',
          from: { principalRef: 'agent:mable', scopeRef: 'mable@hrc-runtime:primary' },
        }),
        roomSubject: 'T-07603 landed',
        senderGeneration: 7,
      }),
      NOW
    )
    expect(rendered).toContain(
      '[R-00012 "T-07603 landed" · mable@hrc-runtime:primary (gen 7) → you · reply required]'
    )
    expect(rendered).toContain("reply: wrkc say R-00012 --to mable@hrc-runtime:primary - <<'EOF'")
  })

  // T-07638, observed live on T-07616: a bare `--to clod` in task room T-07616
  // resolves to the ROOM default `clod@hrc-runtime:T-07616`, so a reply meant
  // for a differently-scoped clod seat landed on the wrong scope and, because
  // reply-is-ack keys on the counterparty scope, silently failed to ack.
  it('addresses the exact sender scope, not the room-default seat of that agent', () => {
    const rendered = formatEnvelopePresentation(
      presentable({
        envelope: envelope({
          roomKey: 'T-07616',
          from: {
            principalRef: 'agent:clod',
            scopeRef: 'clod@hrc-runtime:codex-019efeb5-1234-7abc-8def-0123456789ab',
          },
        }),
      }),
      NOW
    )
    expect(rendered).toContain(
      "reply: wrkc say T-07616 --to clod@hrc-runtime:codex-019efeb5-1234-7abc-8def-0123456789ab - <<'EOF'"
    )
    // The bare name is exactly what misresolved; it must not survive anywhere
    // in the reply line.
    expect(rendered).not.toContain('--to clod ')
  })

  it('addresses a scope-less human sender by their principal', () => {
    const rendered = formatEnvelopePresentation(
      presentable({ envelope: envelope({ from: { principalRef: 'agent:lance' } }) }),
      NOW
    )
    expect(rendered).toContain('· lance → you · reply required]')
    expect(rendered).toContain('--to lance')
  })

  it('separates several envelopes into one injection', () => {
    const rendered = formatEnvelopePresentations(
      [
        presentable(),
        presentable({ envelope: envelope({ id: 'EN-00043', body: 'the second body' }) }),
      ],
      NOW
    )
    expect(rendered).toContain('the body')
    expect(rendered).toContain('the second body')
  })
})

describe('the wrkq/HRC scope seam', () => {
  it('accepts the handle wrkq stores, the canonical scope, and a full session ref', () => {
    expect(targetSessionRefForLedgerScope('cody@wrkq:primary')).toBe(
      'agent:cody:project:wrkq:task:primary/lane:main'
    )
    expect(targetSessionRefForLedgerScope('agent:clod:project:hrc-runtime:task:T-07615')).toBe(
      'agent:clod:project:hrc-runtime:task:T-07615/lane:main'
    )
    expect(
      targetSessionRefForLedgerScope('agent:clod:project:hrc-runtime:task:T-07615/lane:main')
    ).toBe('agent:clod:project:hrc-runtime:task:T-07615/lane:main')
  })

  it('returns undefined rather than inventing a target for an unparseable scope', () => {
    expect(targetSessionRefForLedgerScope('not a scope at all!!')).toBeUndefined()
    expect(targetSessionRefForLedgerScope('   ')).toBeUndefined()
  })

  it('reads the monotonic marker out of an EN id, and refuses EV ids', () => {
    expect(envelopeIdSequence('EN-00042')).toBe(42)
    expect(envelopeIdSequence('EN-00001')).toBe(1)
    // EV- belongs to evidence items; it is not an envelope (T-07612 C-16371).
    expect(envelopeIdSequence('EV-00042')).toBe(0)
    expect(envelopeIdSequence('nonsense')).toBe(0)
  })
})
