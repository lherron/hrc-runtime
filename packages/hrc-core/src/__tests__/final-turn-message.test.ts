import { describe, expect, it } from 'bun:test'

import { selectFinalTurnMessage } from '../final-turn-message.js'

describe('selectFinalTurnMessage', () => {
  it('selects the last explicitly-final non-empty message over a later trailer', () => {
    const answer = { text: 'answer', final: true, seq: 432 }
    const trailer = { text: 'No response requested.', final: false, seq: 436 }
    expect(selectFinalTurnMessage([{ text: '' }, answer, trailer])).toBe(answer)
  })

  it('falls back to the last non-empty message for legacy transports', () => {
    const last = { text: 'legacy answer', seq: 9 }
    expect(selectFinalTurnMessage([{ text: 'narration', seq: 8 }, last])).toBe(last)
  })
})
