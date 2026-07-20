import { describe, expect, test } from 'bun:test'

import {
  LIVE_TAILNET_REQUIRED_MARKER,
  LIVE_TAILNET_SKIP_MARKER,
  liveTailnetDisposition,
  selectLiveTailnetTest,
} from './fixtures/live-tailnet-test.js'

describe('T-06684 live tailnet test guard', () => {
  test('simulated missing interface stays a visible skip outside the strict gate', () => {
    const warnings: string[] = []
    expect(liveTailnetDisposition(undefined, {})).toBe('skip')
    expect(
      selectLiveTailnetTest('simulated-federation.test.ts', undefined, {
        env: {},
        warn: (message) => warnings.push(message),
      })
    ).toBe(test.skip)
    expect(warnings).toEqual([
      expect.stringContaining(`[${LIVE_TAILNET_SKIP_MARKER}] simulated-federation.test.ts`),
    ])
  })

  test('simulated missing interface selects a running/failing test in strict mode', () => {
    const warnings: string[] = []
    const env = { HRC_REQUIRE_LIVE_TAILNET_TESTS: '1' }
    expect(liveTailnetDisposition(undefined, env)).toBe('fail')
    expect(
      selectLiveTailnetTest('simulated-federation.test.ts', undefined, {
        env,
        warn: (message) => warnings.push(message),
      })
    ).toBe(test)
    expect(warnings).toEqual([
      expect.stringContaining(`[${LIVE_TAILNET_REQUIRED_MARKER}] simulated-federation.test.ts`),
    ])
  })
})
