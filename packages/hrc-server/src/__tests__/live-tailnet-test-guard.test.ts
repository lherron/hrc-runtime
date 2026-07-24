import { describe, expect, test } from 'bun:test'

import {
  FEDERATION_CORPUS_TEST_PREFIX,
  LIVE_TAILNET_REQUIRED_MARKER,
  LIVE_TAILNET_SKIP_MARKER,
  federationTestHost,
  liveTailnetDisposition,
  selectLiveTailnetTest,
} from './fixtures/live-tailnet-test.js'

describe('T-06684 live tailnet test guard', () => {
  test('simulated missing interface stays a visible skip outside the strict gate', () => {
    const warnings: string[] = []
    expect(liveTailnetDisposition(undefined, {})).toBe('skip')
    selectLiveTailnetTest('simulated-federation.test.ts', undefined, {
      env: {},
      warn: (message) => warnings.push(message),
    })
    expect(warnings).toEqual([
      expect.stringContaining(`[${LIVE_TAILNET_SKIP_MARKER}] simulated-federation.test.ts`),
    ])
  })

  test('loopback is selected only by the test-fixture mode', () => {
    expect(federationTestHost(undefined, {})).toBeUndefined()
    expect(federationTestHost(undefined, { HRC_FEDERATION_TEST_MODE: 'loopback' })).toBe(
      '127.0.0.1'
    )
    expect(FEDERATION_CORPUS_TEST_PREFIX).toBe('[federation corpus]')
  })

  test('simulated missing interface selects a running/failing test in strict mode', () => {
    const warnings: string[] = []
    const env = { HRC_REQUIRE_LIVE_TAILNET_TESTS: '1' }
    expect(liveTailnetDisposition(undefined, env)).toBe('fail')
    selectLiveTailnetTest('simulated-federation.test.ts', undefined, {
      env,
      warn: (message) => warnings.push(message),
    })
    expect(warnings).toEqual([
      expect.stringContaining(`[${LIVE_TAILNET_REQUIRED_MARKER}] simulated-federation.test.ts`),
    ])
  })
})
