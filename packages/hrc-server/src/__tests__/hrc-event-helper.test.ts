import { describe, expect, it } from 'bun:test'

import { createUserPromptPayload } from '../hrc-event-helper'

// T-08566 stage 1 retired the launch-wrapper hook/OTEL/launch-event derivations
// and the Claude transcript reader; their helper tests went with them. The
// broker mapper still builds user prompts through this helper.
describe('hrc semantic turn helpers', () => {
  it('truncates oversized user prompts to 16 KiB and flags them', () => {
    const payload = createUserPromptPayload('x'.repeat(16 * 1024 + 32))

    expect(payload.type).toBe('message_end')
    expect(payload.message.role).toBe('user')
    expect(payload.message.content).toHaveLength(16 * 1024)
    expect(payload.truncated).toBe(true)
  })
})
