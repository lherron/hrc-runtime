import { describe, expect, it } from 'bun:test'

import { RUNTIME_STATUS_LEVEL_BY_STATUS } from '../monitor/status-levels'

describe('T-06578 frozen runtime status levels', () => {
  it('exhaustively maps every raw status, with transitional statuses satisfying no level', () => {
    expect(RUNTIME_STATUS_LEVEL_BY_STATUS).toEqual({
      ready: 'idle',
      idle: 'idle',
      busy: 'busy',
      awaiting_input: 'busy',
      dead: 'runtime-dead',
      stale: 'runtime-dead',
      terminated: 'runtime-dead',
      stopped: 'runtime-dead',
      failed: 'runtime-dead',
      disposed: 'runtime-dead',
      crashed: 'runtime-dead',
      exited: 'runtime-dead',
      starting: null,
      stopping: null,
      adopted: null,
    })
  })
})
