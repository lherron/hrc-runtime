import { describe, expect, it } from 'bun:test'

import { formatDmPayload } from '../messages.js'

describe('semantic turn payload formatting', () => {
  it('presents an attributed turn request without the retired DM reply ceremony', () => {
    const rendered = formatDmPayload(
      { kind: 'session', sessionRef: 'agent:mable:project:hcs/lane:main' },
      {
        kind: 'session',
        sessionRef: 'agent:cody:project:hrc-runtime:task:T-07856/lane:main',
      },
      'implement the costume strip',
      42,
      '2026-09-01T18:30:00Z'
    )

    expect(rendered).toBe(
      '[Turn request from mable@hcs · #42 · sentAt=2026-09-01T18:30:00Z · to cody@hrc-runtime:T-07856]\nimplement the costume strip'
    )
    expect(rendered).not.toContain('[DM #')
    expect(rendered).not.toContain('reply_cmd')
    expect(rendered).not.toContain('hrcchat dm')
  })

  it('keeps the durable sequence in the truncation hint', () => {
    const rendered = formatDmPayload(
      { kind: 'entity', entity: 'human' },
      { kind: 'entity', entity: 'cody' },
      'x'.repeat(1_300),
      7,
      '2026-09-01T18:30:00Z'
    )

    expect(rendered).toContain("… (truncated; hrcchat show '#7')")
    expect(rendered).not.toContain('x'.repeat(1_201))
  })
})
