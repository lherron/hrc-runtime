import { describe, expect, it } from 'bun:test'

import {
  type PresentableEnvelope,
  formatEnvelopeFailureNotice,
  formatEnvelopePresentation,
  formatEnvelopePresentations,
} from '../wrkq/envelope-presentation.js'
import { targetSessionRefForLedgerScope } from '../wrkq/ledger-scope.js'
import type { WrkqEnvelope } from '../wrkq/ledger-types.js'
import { envelopeIdSequence } from '../wrkq/ledger-types.js'

/**
 * The §4 injection formats and the wrkq↔HRC scope seam (T-07612 rev 5.1,
 * T-07615, T-07704).
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

describe('T-07612 rev 5.1 §4 presentation', () => {
  it('renders header, body, reply and defer lines in the full form', () => {
    const rendered = formatEnvelopePresentation(presentable({ senderGeneration: 3 }), NOW)
    expect(rendered).toBe(
      [
        '[T-07604 · cody@hrc-runtime:T-07604 (gen 3) → you · reply required]',
        'the body',
        "reply: wrkc say T-07604 --to cody@hrc-runtime:T-07604 - <<'EOF'",
        '…',
        'EOF',
        'defer: wrkc defer EN-00042 --reason … [--retry-after 10m]',
      ].join('\n')
    )
  })

  // rev 5.1: not answering now is a VERB. A reader who has never been shown it
  // defaults to the silence the whole revision exists to stop.
  it('teaches the defer verb at first contact', () => {
    expect(formatEnvelopePresentation(presentable(), NOW)).toContain(
      'defer: wrkc defer EN-00042 --reason …'
    )
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
    expect(cold.split('\n')).toHaveLength(7)
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
    // A fyi is auto-acked at presentation: there is nothing to defer either.
    expect(rendered).not.toContain('defer:')
  })

  // T-07698: an R- room is a pair channel, not a topic. Its key renders bare,
  // exactly like a derived room's, with nothing quoted after it.
  it('renders an ad-hoc room as its bare key and addresses that key', () => {
    const rendered = formatEnvelopePresentation(
      presentable({
        envelope: envelope({
          roomKey: 'R-00012',
          roomKind: 'adhoc',
          from: { principalRef: 'agent:mable', scopeRef: 'mable@hrc-runtime:primary' },
        }),
        senderGeneration: 7,
      }),
      NOW
    )
    expect(rendered).toContain(
      '[R-00012 · mable@hrc-runtime:primary (gen 7) → you · reply required]'
    )
    expect(rendered).not.toContain('"')
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

/**
 * rev 5.1 §4 — the POINTER forms and the sender-side failure notice.
 *
 * The body is pushed once per envelope on the common path; every later surface
 * is a pointer with a read hint, and the header's fourth clause is what tells
 * the reader why a body-less injection just arrived.
 */
describe('T-07612 rev 5.1 §4 pointer forms', () => {
  it('reminds with no body, a read hint, and how long the turn has been over', () => {
    const rendered = formatEnvelopePresentation(
      presentable({ form: 'reminder', turnEndedAt: '2026-08-27T11:56:00Z' }),
      NOW
    )
    expect(rendered).toBe(
      [
        '[T-07604 · cody@hrc-runtime:T-07604 → you · reply required · still owed — your turn ended 4m ago without a reply or defer]',
        'read: wrkc show EN-00042   ·   thread: wrkc log T-07604',
        "reply: wrkc say T-07604 --to cody@hrc-runtime:T-07604 - <<'EOF'",
        '…',
        'EOF',
        'defer: wrkc defer EN-00042 --reason … [--retry-after 10m]',
      ].join('\n')
    )
    // The rule, not an optimization: a pointer NEVER carries the body.
    expect(rendered).not.toContain('the body')
  })

  it('never cues history on a pointer, even when the ledger says the room is cold', () => {
    const rendered = formatEnvelopePresentation(
      presentable({ form: 'reminder', historyHint: true, messageCount: 14 }),
      NOW
    )
    expect(rendered).not.toContain('history:')
  })

  it('quotes the reader their own defer reason on the retry', () => {
    const rendered = formatEnvelopePresentation(
      presentable({
        form: 'defer-retry',
        envelope: envelope({
          state: 'pending',
          deferReason: 'mid-restart drain, back in 10',
          presentedTo: [{ memberRef: 'clod@hrc-runtime:T-07604', presentedAt: NOW.toISOString() }],
        }),
      }),
      NOW
    )
    expect(rendered).toContain(
      '· reply required · you deferred this: "mid-restart drain, back in 10"]'
    )
    expect(rendered).toContain('read: wrkc show EN-00042   ·   thread: wrkc log T-07604')
    expect(rendered).not.toContain('the body')
  })

  it('clips a runaway defer reason rather than re-injecting an essay', () => {
    const rendered = formatEnvelopePresentation(
      presentable({
        form: 'defer-retry',
        envelope: envelope({ state: 'pending', deferReason: 'x'.repeat(400) }),
      }),
      NOW
    )
    expect(rendered).toContain(`"${'x'.repeat(120)}…"`)
  })
})

describe('T-07612 rev 5.1 §5 sender failure notice', () => {
  it('names the room, the envelope, the addressee, the reason, and the resend', () => {
    const failed = envelope({
      state: 'failed',
      terminal: true,
      failureReason: 'runtime_terminated',
      presentedTo: [
        {
          memberRef: 'clod@hrc-runtime:T-07604',
          runtimeId: 'rt-0e428a10',
          presentedAt: '2026-08-27T11:58:59Z',
        },
      ],
    })
    expect(formatEnvelopeFailureNotice(failed, 'runtime_terminated', { now: NOW })).toBe(
      [
        '[T-07604 · your EN-00042 → clod@hrc-runtime:T-07604 · failed: runtime_terminated]',
        'presented 61s, undisposed; runtime rt-0e428a10 ended. Resend: wrkc say T-07604 --to clod@hrc-runtime:T-07604 -',
      ].join('\n')
    )
  })

  it('reports a strike-out as two undisposed turns on the runtime that held it', () => {
    const failed = envelope({ state: 'failed', terminal: true, failureReason: 'ignored' })
    expect(
      formatEnvelopeFailureNotice(failed, 'ignored', { runtimeId: 'rt-1fa86350', now: NOW })
    ).toBe(
      [
        '[T-07604 · your EN-00042 → clod@hrc-runtime:T-07604 · failed: ignored]',
        'presented, reminded, 2 turns ended undisposed on rt-1fa86350. Resend or escalate.',
      ].join('\n')
    )
  })

  it('says an undeliverable envelope was never delivered at all', () => {
    const failed = envelope({ state: 'failed', terminal: true, failureReason: 'undeliverable' })
    expect(formatEnvelopeFailureNotice(failed, 'undeliverable', { now: NOW })).toContain(
      'never delivered; clod@hrc-runtime:T-07604 could not be seated.'
    )
  })
})
