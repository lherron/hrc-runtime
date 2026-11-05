import { describe, expect, test } from 'bun:test'
import { type JevRequest, TEXT_BYTES, buildRequest, capText, classify } from './classifier.js'

const turn = {
  agent: 'mable',
  project: 'wrkq',
  seat: 'primary',
  user_text_tail: '',
  final_text: 'Ship it?',
}

function fakeJev(probabilities: Record<string, number>): JevRequest {
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
    )) as unknown as JevRequest
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

describe('turn.attention text', () => {
  test('a message within the cap is the whole message', async () => {
    const final_text = `${'Context paragraph. '.repeat(40)}\n\nShould I ship it?`
    const out = await classify(
      { ...turn, final_text },
      'k',
      fakeJev({ blocking: 0.9, decision: 0, offer: 0, none: 0.1 })
    )
    expect(out.text).toBe(final_text)
    expect(Array.from(out.excerpt).length).toBe(240)
  })

  test('a longer message keeps its tail behind an ellipsis, within 16 KB of UTF-8', () => {
    const final_text = `${'é'.repeat(9000)}🚀 tail ask?`
    const out = capText(final_text)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(TEXT_BYTES)
    expect(out.startsWith('…')).toBe(true)
    expect(final_text.endsWith(out.slice(1))).toBe(true)
    expect(capText(out)).toBe(out)
  })

  test('the jev request still sends at most 2500 characters', () => {
    const req = buildRequest({ ...turn, final_text: 'x'.repeat(10000) })
    expect(req.state.final_text.length).toBe(2500)
  })
})
