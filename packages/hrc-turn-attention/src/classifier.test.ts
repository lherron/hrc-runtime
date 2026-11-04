import { describe, expect, test } from 'bun:test'
import { classify } from './classifier.js'

const turn = {
  agent: 'mable',
  project: 'wrkq',
  seat: 'primary',
  user_text_tail: '',
  final_text: 'Ship it?',
}

function fakeJev(probabilities: Record<string, number>) {
  return (async () =>
    new Response(
      JSON.stringify({
        model: 'jev-test',
        answers: {
          ask: { probabilities, confidence: 0.9 },
          kind: { choice: 'decision' },
          to_lance: { noul: 0.9 },
          waiting_on_other: { noul: 0.1 },
        },
      }),
      { status: 200 }
    )) as unknown as typeof fetch
}

describe('classify lit/state agreement', () => {
  // Live case: mable@wrkq:primary 2026-11-04T14:03:41.137Z. blocking and decision
  // split the ask vote, so none won the argmax while their sum lit the turn.
  test('a lit split vote reports the larger of blocking and decision', async () => {
    const out = await classify(
      turn,
      'k',
      fakeJev({ blocking: 0.28, decision: 0.22, offer: 0, none: 0.5 })
    )
    expect(out.lit).toBe(true)
    expect(out.state).toBe('blocking')
  })

  test('decision wins a lit split when it is larger', async () => {
    const out = await classify(
      turn,
      'k',
      fakeJev({ blocking: 0.2, decision: 0.3, offer: 0.05, none: 0.45 })
    )
    expect(out.lit).toBe(true)
    expect(out.state).toBe('decision')
  })

  test('an unlit turn keeps the argmax', async () => {
    const out = await classify(
      turn,
      'k',
      fakeJev({ blocking: 0.1, decision: 0.1, offer: 0.6, none: 0.2 })
    )
    expect(out.lit).toBe(false)
    expect(out.state).toBe('offer')
  })
})
